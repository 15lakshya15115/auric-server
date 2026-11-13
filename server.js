require('dotenv').config();
const express = require('express');
const path = require('path');
const { sendTemplateMessage, normalizePhoneNumber, parseFailureReason } = require('./services/wati');
const db = require('./services/db');
const { initScheduler, processPendingMessages } = require('./services/scheduler');

const app = express();
const PORT = process.env.PORT || 3000;
const DASHBOARD_PIN = process.env.DASHBOARD_PIN || 'auric2026';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Start Background Scheduler (for 11:00 AM IST Milling Drips)
initScheduler();

// ==========================================
// In-Memory Circular Log Buffer (100 items)
// ==========================================
const recentLogs = [];
function addLog(msg) {
  const entry = { time: new Date().toISOString(), message: msg };
  recentLogs.unshift(entry);
  if (recentLogs.length > 100) recentLogs.pop();
  console.log(`[${entry.time}] ${msg}`);
}

/**
 * Calculate Next Calendar Day at 11:00 AM IST
 * e.g., Order placed Oct 19 at 4:00 PM -> Scheduled for Oct 20 at 11:00 AM IST
 */
function getNextDay11AM_IST(orderDate = new Date()) {
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const istTime = new Date(orderDate.getTime() + IST_OFFSET_MS);
  return Date.UTC(
    istTime.getUTCFullYear(),
    istTime.getUTCMonth(),
    istTime.getUTCDate() + 1, // Next calendar day in IST
    5,                        // 05:30 AM UTC = 11:00:00 AM IST
    30,
    0,
    0
  );
}

// ==========================================
// 1. Dashboard UI & Auth Gate
// ==========================================
app.get('/', (req, res) => {
  // If browser request, open dashboard; else return API info
  if (req.headers.accept && req.headers.accept.includes('text/html')) {
    return res.redirect('/dashboard');
  }
  res.json({
    status: 'online',
    service: 'Auric Mills WhatsApp Automation Server (WATI)',
    dashboard: '/dashboard',
    timestamp: new Date().toISOString()
  });
});

app.get(['/dashboard', '/admin'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// Verify PIN API
app.post('/api/dashboard/verify-pin', (req, res) => {
  const { pin } = req.body;
  if (pin && String(pin).trim() === String(DASHBOARD_PIN).trim()) {
    return res.json({ valid: true });
  }
  res.status(401).json({ valid: false, error: 'Invalid PIN' });
});

// Middleware for Dashboard API Protection
function authMiddleware(req, res, next) {
  const pinHeader = req.headers['x-dashboard-pin'];
  const pinQuery = req.query.pin;
  const provided = pinHeader || pinQuery;

  if (provided && String(provided).trim() === String(DASHBOARD_PIN).trim()) {
    return next();
  }
  return res.status(401).json({ error: 'Unauthorized. Invalid Dashboard PIN.' });
}

// ==========================================
// 2. Dashboard API Endpoints
// ==========================================
app.get('/api/dashboard/stats', authMiddleware, (req, res) => {
  const stats = db.getDashboardStats();
  res.json(stats);
});

app.get('/api/dashboard/messages', authMiddleware, (req, res) => {
  const { status, search, stage, limit, offset } = req.query;
  const data = db.getAllMessages({
    status,
    search,
    stage,
    limit: limit ? parseInt(limit, 10) : 100,
    offset: offset ? parseInt(offset, 10) : 0
  });
  res.json(data);
});

app.post('/api/dashboard/settings', authMiddleware, (req, res) => {
  const updated = db.updateSettings(req.body);
  addLog('[Settings] Automation toggles updated from Dashboard.');
  res.json({ status: 'success', settings: updated });
});

// 1-Click Resend API
app.post('/api/dashboard/resend', authMiddleware, async (req, res) => {
  try {
    const { messageId } = req.body;
    const { messages } = db.getAllMessages({ limit: 5000 });
    const target = messages.find(m => m.id === messageId);

    if (!target) {
      return res.status(404).json({ error: 'Message record not found' });
    }

    if (!target.phone) {
      return res.status(400).json({ error: 'Cannot resend: No phone number exists for this order.' });
    }

    const templateName = target.templateName || process.env.TEMPLATE_ORDER_CONFIRMED || 'thank_you_new';
    const params = target.customerName ? [
      { name: 'customer_name', value: target.customerName },
      { name: '1', value: target.customerName }
    ] : [];

    addLog(`[Dashboard RESEND] Retrying message to ${target.phone} (${templateName})...`);

    const result = await sendTemplateMessage({
      phone: target.phone,
      templateName,
      parameters: params,
      broadcastName: `Resend_${target.orderId || 'Direct'}`
    });

    db.updateMessageStatus(target.id, 'delivered', {
      watiMessageId: result.messageId,
      deliveredAt: Date.now()
    });

    res.json({ success: true, result });
  } catch (err) {
    addLog(`[Dashboard RESEND ERROR]: ${err.message}`);
    res.status(500).json({ success: false, error: err.friendlyReason || err.message });
  }
});

// Export CSV
app.get('/api/dashboard/export-csv', authMiddleware, (req, res) => {
  const { messages } = db.getAllMessages({ limit: 5000 });

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="auric_whatsapp_logs_${new Date().toISOString().slice(0, 10)}.csv"`);

  const headers = ['Date & Time (IST)', 'Order ID', 'Customer Name', 'Phone', 'Stage', 'Status', 'Failure Reason', 'WATI Message ID'];
  const rows = messages.map(m => {
    const dateStr = m.createdAt ? new Date(m.createdAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : '';
    return [
      `"${dateStr}"`,
      `"${m.orderId || ''}"`,
      `"${(m.customerName || '').replace(/"/g, '""')}"`,
      `"${m.phone || ''}"`,
      `"${m.stageLabel || m.stage || ''}"`,
      `"${m.status || ''}"`,
      `"${(m.failureReason || '').replace(/"/g, '""')}"`,
      `"${m.watiMessageId || ''}"`
    ].join(',');
  });

  res.send([headers.join(','), ...rows].join('\n'));
});

// Health check
app.get('/health', (req, res) => {
  const jobs = db.getAllJobs();
  const pending = jobs.filter(j => j.status === 'pending').length;
  const sent = jobs.filter(j => j.status === 'sent').length;

  res.json({
    status: 'healthy',
    uptimeSeconds: Math.floor(process.uptime()),
    stats: { totalJobs: jobs.length, pending, sent },
    timestamp: new Date().toISOString()
  });
});

// ==========================================
// 3. Webhook: Order Created (Instant Confirm + Next-Day 11 AM Milling Drip)
// ==========================================
app.post('/webhooks/shopify/orders-create', async (req, res) => {
  try {
    const order = req.body;
    const orderNumber = order.name || `#${order.order_number || order.id || ''}`;
    const rawPhone = order.phone || order.customer?.phone || order.shipping_address?.phone || '';
    const phone = normalizePhoneNumber(rawPhone);
    const customerName = order.customer?.first_name || order.shipping_address?.first_name || 'Valued Customer';

    // Record Webhook Pulse
    db.recordWebhookPulse('orders/create', orderNumber, phone || rawPhone);
    addLog(`[Shopify Webhook] New Order Received: ${orderNumber} (Phone: ${phone || rawPhone || 'NONE'})`);

    const settings = db.getSettings();

    // If order has no phone number
    if (!phone) {
      addLog(`[Shopify Webhook] Order ${orderNumber} has no valid phone number. Logging skipped.`);
      db.recordMessage({
        orderId: orderNumber,
        customerName,
        phone: '',
        rawPhone,
        templateName: process.env.TEMPLATE_ORDER_CONFIRMED || 'thank_you_new',
        stage: 'order_confirmed',
        status: 'skipped',
        failureReason: 'Missing phone number (Customer used email only)'
      });
      return res.status(200).json({ status: 'ignored', reason: 'No phone number found' });
    }

    // Dedup lock check
    const canSendConfirmation = db.tryAcquireLock(orderNumber, 'order_confirmed', phone);
    if (!canSendConfirmation) {
      addLog(`[Shopify Webhook DEDUP] Order confirmation for ${orderNumber} / ${phone} already locked/sent. Skipping.`);
      return res.status(200).json({ status: 'ignored', reason: 'Duplicate order confirmation' });
    }

    db.recordMessageSent(orderNumber, 'order_confirmed');

    // RESPOND 200 OK TO SHOPIFY IMMEDIATELY (<50ms)
    res.status(200).json({ status: 'accepted', order: orderNumber });

    // 1. Instant Order Confirmation
    const orderTemplate = process.env.TEMPLATE_ORDER_CONFIRMED || 'thank_you_new';
    if (settings.automations && settings.automations.order_confirmed === false) {
      addLog(`[AUTOMATION PAUSED] Order confirmation paused via dashboard for ${orderNumber}.`);
    } else {
      try {
        const result = await sendTemplateMessage({
          phone,
          templateName: orderTemplate,
          parameters: [
            { name: 'customer_name', value: customerName },
            { name: '1', value: customerName }
          ],
          broadcastName: `Order_${orderNumber}`
        });

        db.recordMessage({
          orderId: orderNumber,
          customerName,
          phone,
          rawPhone,
          templateName: orderTemplate,
          stage: 'order_confirmed',
          status: 'delivered',
          watiMessageId: result.messageId
        });

        addLog(`[CONFIRMED] Successfully sent "${orderTemplate}" to ${phone} for ${orderNumber}`);
      } catch (err) {
        addLog(`[CONFIRM ERROR] Failed sending "${orderTemplate}" to ${phone}: ${err.message}`);
        db.recordMessage({
          orderId: orderNumber,
          customerName,
          phone,
          rawPhone,
          templateName: orderTemplate,
          stage: 'order_confirmed',
          status: 'failed',
          failureReason: err.friendlyReason || err.message
        });
      }
    }

    // 2. Schedule Next-Day 11:00 AM IST Milling Drip
    const millingTemplate = process.env.TEMPLATE_MILLING_STARTED || 'fresh_milling_started_new';
    const orderDate = order.created_at ? new Date(order.created_at) : new Date();
    const scheduledTime = getNextDay11AM_IST(orderDate);

    if (db.isJobScheduled(orderNumber, millingTemplate) || db.hasMessageBeenSent(orderNumber, 'milling_started')) {
      addLog(`[Shopify Webhook] Milling job already scheduled/sent for ${orderNumber}. Skipping.`);
    } else {
      db.addJob({
        orderId: orderNumber,
        customerName,
        phone,
        templateName: millingTemplate,
        parameters: [],
        scheduledAt: scheduledTime
      });
      const scheduledDateIST = new Date(scheduledTime).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
      addLog(`[SCHEDULED] Milling message scheduled for Order ${orderNumber} at: ${scheduledDateIST} (IST)`);
    }

  } catch (error) {
    addLog(`[Shopify Webhook ERROR orders-create]: ${error.message}`);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    }
  }
});

// ==========================================
// 4. Webhook: Order Shipped / Fulfilled
// ==========================================
app.post('/webhooks/shopify/orders-fulfilled', async (req, res) => {
  try {
    const payload = req.body;
    const order = payload.order || payload;
    const customerName = order.customer?.first_name || order.shipping_address?.first_name || 'Valued Customer';
    const rawPhone = order.phone || order.customer?.phone || order.shipping_address?.phone || '';
    const phone = normalizePhoneNumber(rawPhone);
    const orderNumber = order.name || `#${order.order_number || order.id || ''}`;

    db.recordWebhookPulse('orders/fulfilled', orderNumber, phone || rawPhone);
    addLog(`[Shopify Webhook] Order Fulfilled: ${orderNumber} (Phone: ${phone || rawPhone || 'NONE'})`);

    if (!phone) {
      db.recordMessage({
        orderId: orderNumber,
        customerName,
        phone: '',
        rawPhone,
        templateName: process.env.TEMPLATE_ORDER_SHIPPED || 'order_shipped_new',
        stage: 'order_shipped',
        status: 'skipped',
        failureReason: 'Missing phone number (Customer used email only)'
      });
      return res.status(200).json({ status: 'ignored', reason: 'No phone' });
    }

    const canSendShipped = db.tryAcquireLock(orderNumber, 'order_shipped', phone);
    if (!canSendShipped) {
      addLog(`[Shopify Webhook DEDUP] Shipping message for ${orderNumber} / ${phone} already locked/sent. Skipping duplicate.`);
      return res.status(200).json({ status: 'ignored', reason: 'Duplicate shipping message' });
    }

    db.recordMessageSent(orderNumber, 'order_shipped');
    res.status(200).json({ status: 'accepted', order: orderNumber });

    const settings = db.getSettings();
    if (settings.automations && settings.automations.order_shipped === false) {
      addLog(`[AUTOMATION PAUSED] Order shipped message paused via dashboard for ${orderNumber}.`);
      return;
    }

    const shippedTemplate = process.env.TEMPLATE_ORDER_SHIPPED || 'order_shipped_new';
    try {
      const result = await sendTemplateMessage({
        phone,
        templateName: shippedTemplate,
        parameters: [],
        broadcastName: `Shipped_${orderNumber}`
      });

      db.recordMessage({
        orderId: orderNumber,
        customerName,
        phone,
        rawPhone,
        templateName: shippedTemplate,
        stage: 'order_shipped',
        status: 'delivered',
        watiMessageId: result.messageId
      });

      addLog(`[SHIPPED] Successfully sent "${shippedTemplate}" to ${phone} for ${orderNumber}`);
    } catch (err) {
      addLog(`[SHIPPED ERROR] Failed to send "${shippedTemplate}" to ${phone}: ${err.message}`);
      db.recordMessage({
        orderId: orderNumber,
        customerName,
        phone,
        rawPhone,
        templateName: shippedTemplate,
        stage: 'order_shipped',
        status: 'failed',
        failureReason: err.friendlyReason || err.message
      });
    }
  } catch (error) {
    addLog(`[Shopify Webhook ERROR orders-fulfilled]: ${error.message}`);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    }
  }
});

// ==========================================
// 5. Webhook: Order Delivered (Feedback)
// ==========================================
app.post('/webhooks/shopify/orders-delivered', async (req, res) => {
  try {
    const order = req.body;
    const customerName = order.customer?.first_name || order.shipping_address?.first_name || 'Valued Customer';
    const rawPhone = order.phone || order.customer?.phone || order.shipping_address?.phone || '';
    const phone = normalizePhoneNumber(rawPhone);
    const orderNumber = order.name || `#${order.order_number || order.id || ''}`;

    db.recordWebhookPulse('orders/updated', orderNumber, phone || rawPhone);
    addLog(`[Delivery Webhook] Order Updated/Delivered check: ${orderNumber} (Phone: ${phone || rawPhone || 'NONE'})`);

    if (!phone) {
      return res.status(200).json({ status: 'ignored', reason: 'No phone' });
    }

    // Verify Delivery Status
    const fulfillments = order.fulfillments || [];
    const isDelivered = fulfillments.some(f => f.shipment_status === 'delivered') ||
                        (order.tags && order.tags.toLowerCase().includes('delivered'));

    if (!isDelivered) {
      addLog(`[Delivery Webhook] Order ${orderNumber} is NOT marked delivered yet. Skipping feedback.`);
      return res.status(200).json({ status: 'ignored', reason: 'Order is not marked delivered yet' });
    }

    const canSendFeedback = db.tryAcquireLock(orderNumber, 'order_feedback', phone);
    if (!canSendFeedback) {
      addLog(`[Delivery Webhook DEDUP] Feedback for ${orderNumber} / ${phone} already locked/sent. Skipping duplicate.`);
      return res.status(200).json({ status: 'ignored', reason: 'Duplicate feedback message' });
    }

    db.recordMessageSent(orderNumber, 'order_feedback');
    res.status(200).json({ status: 'accepted', order: orderNumber });

    const settings = db.getSettings();
    if (settings.automations && settings.automations.order_feedback === false) {
      addLog(`[AUTOMATION PAUSED] Delivery feedback paused via dashboard for ${orderNumber}.`);
      return;
    }

    const feedbackTemplate = process.env.TEMPLATE_DELIVERY_FEEDBACK || 'feedback_new';
    try {
      const result = await sendTemplateMessage({
        phone,
        templateName: feedbackTemplate,
        parameters: [],
        broadcastName: `Feedback_${orderNumber}`
      });

      db.recordMessage({
        orderId: orderNumber,
        customerName,
        phone,
        rawPhone,
        templateName: feedbackTemplate,
        stage: 'order_feedback',
        status: 'delivered',
        watiMessageId: result.messageId
      });

      addLog(`[FEEDBACK] Successfully sent "${feedbackTemplate}" to ${phone} for ${orderNumber}`);
    } catch (err) {
      addLog(`[FEEDBACK ERROR] Failed to send "${feedbackTemplate}" to ${phone}: ${err.message}`);
      db.recordMessage({
        orderId: orderNumber,
        customerName,
        phone,
        rawPhone,
        templateName: feedbackTemplate,
        stage: 'order_feedback',
        status: 'failed',
        failureReason: err.friendlyReason || err.message
      });
    }
  } catch (error) {
    addLog(`[Delivery Webhook ERROR]: ${error.message}`);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    }
  }
});

// ==========================================
// 6. WATI Status Callback Webhook (Delivered / Read / Failed)
// ==========================================
app.post('/webhooks/wati/status-update', (req, res) => {
  try {
    const payload = req.body || {};
    const status = String(payload.status || payload.eventType || '').toUpperCase();
    const watiId = payload.id || payload.messageId || payload.whatsappMessageId || '';
    const phone = payload.whatsappNumber || payload.phone || '';

    addLog(`[WATI Callback] Message ${watiId || phone} status updated to: ${status}`);

    if (status.includes('READ')) {
      db.updateMessageStatus(watiId, 'read', { readAt: Date.now() });
    } else if (status.includes('DELIVERED')) {
      db.updateMessageStatus(watiId, 'delivered', { deliveredAt: Date.now() });
    } else if (status.includes('FAIL') || status.includes('UNDELIVERED')) {
      const reason = parseFailureReason(payload.error || payload.reason || 'Delivery failed', phone);
      db.updateMessageStatus(watiId, 'failed', { failureReason: reason });
    }

    res.status(200).json({ received: true });
  } catch (err) {
    res.status(200).json({ received: true }); // Always 200 to WATI
  }
});

// ==========================================
// 7. Cron Trigger Endpoint (for Cron-job.org / External Pings)
// ==========================================
app.get('/cron/process', async (req, res) => {
  const result = await processPendingMessages();
  res.json({
    status: 'success',
    ...result,
    timestamp: new Date().toISOString()
  });
});

// ==========================================
// 8. Admin Jobs & Logs
// ==========================================
app.get('/admin/jobs', (req, res) => {
  const jobs = db.getAllJobs();
  res.json({ total: jobs.length, jobs });
});

app.get('/admin/logs', (req, res) => {
  res.json({ total: recentLogs.length, logs: recentLogs });
});

// ==========================================
// 9. Manual Test Message Trigger
// ==========================================
app.post('/test/send-message', async (req, res) => {
  try {
    const { phone, templateName, customerName } = req.body;

    if (!phone || !templateName) {
      return res.status(400).json({ error: 'Please provide phone and templateName' });
    }

    const result = await sendTemplateMessage({
      phone,
      templateName,
      parameters: customerName ? [
        { name: 'customer_name', value: customerName },
        { name: '1', value: customerName }
      ] : [],
      broadcastName: 'Manual_Test'
    });

    db.recordMessage({
      orderId: 'MANUAL_TEST',
      customerName: customerName || 'Valued Customer',
      phone,
      templateName,
      stage: 'manual_test',
      status: 'delivered',
      watiMessageId: result.messageId,
      source: 'manual_dashboard'
    });

    res.json({ status: 'success', result });
  } catch (error) {
    db.recordMessage({
      orderId: 'MANUAL_TEST',
      customerName: req.body?.customerName || 'Test Customer',
      phone: req.body?.phone || '',
      templateName: req.body?.templateName || '',
      stage: 'manual_test',
      status: 'failed',
      failureReason: error.friendlyReason || error.message,
      source: 'manual_dashboard'
    });
    res.status(500).json({ error: error.friendlyReason || error.message });
  }
});

// Start Server
app.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(`🚀 Auric Mills WhatsApp Automation Server Started!`);
  console.log(`📍 Port: ${PORT}`);
  console.log(`📊 Dashboard:    http://localhost:${PORT}/dashboard`);
  console.log(`🌐 Health Check: http://localhost:${PORT}/health`);
  console.log(`📋 Admin Jobs:   http://localhost:${PORT}/admin/jobs`);
  console.log(`🔑 PIN:          ${DASHBOARD_PIN}`);
  console.log(`====================================================`);
});
