require('dotenv').config();
const express = require('express');
const { sendTemplateMessage, normalizePhoneNumber } = require('./services/wati');
const db = require('./services/db');
const { initScheduler, processPendingMessages } = require('./services/scheduler');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Start Background Scheduler
initScheduler();

// ==========================================
// 1. Health & Status
// ==========================================
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    service: 'Auric Mills WhatsApp Automation Server (WATI)',
    timestamp: new Date().toISOString()
  });
});

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
// 2. Webhook: Order Created (Instant Confirm + Next-Day 11 AM Milling Drip)
// ==========================================

/**
 * Calculate Next Calendar Day at 11:00 AM IST
 * e.g., Order placed Oct 19 at 4:00 PM -> Scheduled for Oct 20 at 11:00 AM IST
 */
function getNextDay11AM_IST(orderDate = new Date()) {
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000; // 5 hours 30 mins IST
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

// Circular in-memory log buffer (last 100 entries)
const recentLogs = [];
function addLog(msg) {
  const entry = { time: new Date().toISOString(), message: msg };
  recentLogs.unshift(entry);
  if (recentLogs.length > 100) recentLogs.pop();
  console.log(`[${entry.time}] ${msg}`);
}

app.post('/webhooks/shopify/orders-create', async (req, res) => {
  try {
    const order = req.body;
    const orderNumber = order.name || `#${order.order_number || order.id || ''}`;
    const rawPhone = order.phone || order.customer?.phone || order.shipping_address?.phone || '';
    const phone = normalizePhoneNumber(rawPhone);
    const customerName = order.customer?.first_name || order.shipping_address?.first_name || 'Valued Customer';

    addLog(`[Shopify Webhook] New Order Received: ${orderNumber} (Phone: ${phone})`);

    if (!phone) {
      addLog(`[Shopify Webhook] Order ${orderNumber} has no phone. Skipping.`);
      return res.status(200).json({ status: 'ignored', reason: 'No phone number found' });
    }

    // 1. ATOMIC LOCK CHECK FOR ORDER CONFIRMATION
    // Blocks any duplicate webhook arriving concurrently (within 15 minutes) for this order OR this phone!
    const canSendConfirmation = db.tryAcquireLock(orderNumber, 'order_confirmed', phone);

    if (!canSendConfirmation) {
      addLog(`[Shopify Webhook DEDUP] Order confirmation for ${orderNumber} / ${phone} already locked/sent. Skipping duplicate.`);
      return res.status(200).json({ status: 'ignored', reason: 'Duplicate order confirmation' });
    }

    // Synchronously record as sent in DB immediately
    db.recordMessageSent(orderNumber, 'order_confirmed');

    // RESPOND 200 OK TO SHOPIFY IMMEDIATELY (<50ms)
    // This is CRITICAL: Prevents Shopify from timing out (5s limit) and sending retry webhooks!
    res.status(200).json({
      status: 'accepted',
      order: orderNumber
    });

    // 2. SEND ORDER CONFIRMATION (Background)
    const orderTemplate = process.env.TEMPLATE_ORDER_CONFIRMED || 'thank_you_new';
    try {
      await sendTemplateMessage({
        phone,
        templateName: orderTemplate,
        parameters: [
          { name: 'customer_name', value: customerName },
          { name: '1', value: customerName }
        ],
        broadcastName: `Order_${orderNumber}`
      });
      addLog(`[CONFIRMED] Successfully sent "${orderTemplate}" to ${phone} for ${orderNumber}`);
    } catch (err) {
      addLog(`[CONFIRM ERROR] Failed to send "${orderTemplate}" to ${phone}: ${err.message}`);
    }

    // 3. SCHEDULE MILLING MESSAGE (Scheduled Next Day Morning at 11:00 AM IST)
    const millingTemplate = process.env.TEMPLATE_MILLING_STARTED || 'fresh_milling_started_new';
    const orderDate = order.created_at ? new Date(order.created_at) : new Date();
    const scheduledTime = getNextDay11AM_IST(orderDate);

    if (db.isJobScheduled(orderNumber, millingTemplate) || db.hasMessageBeenSent(orderNumber, 'milling_started')) {
      addLog(`[Shopify Webhook] Milling job already scheduled/sent for ${orderNumber}. Skipping duplicate.`);
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
// 3. Webhook: Order Shipped / Fulfilled
// ==========================================
app.post('/webhooks/shopify/orders-fulfilled', async (req, res) => {
  try {
    const payload = req.body;
    const order = payload.order || payload;
    const customerName = order.customer?.first_name || order.shipping_address?.first_name || 'Valued Customer';
    const rawPhone = order.phone || order.customer?.phone || order.shipping_address?.phone || '';
    const phone = normalizePhoneNumber(rawPhone);
    const orderNumber = order.name || `#${order.order_number || order.id || ''}`;

    addLog(`[Shopify Webhook] Order Fulfilled: ${orderNumber} (Phone: ${phone})`);

    if (!phone) {
      return res.status(200).json({ status: 'ignored', reason: 'No phone' });
    }

    // Atomic lock check
    const canSendShipped = db.tryAcquireLock(orderNumber, 'order_shipped', phone);
    if (!canSendShipped) {
      addLog(`[Shopify Webhook DEDUP] Shipping message for ${orderNumber} / ${phone} already locked/sent. Skipping duplicate.`);
      return res.status(200).json({ status: 'ignored', reason: 'Duplicate shipping message' });
    }

    db.recordMessageSent(orderNumber, 'order_shipped');

    res.status(200).json({ status: 'accepted', order: orderNumber });

    const shippedTemplate = process.env.TEMPLATE_ORDER_SHIPPED || 'order_shipped_new';
    try {
      await sendTemplateMessage({
        phone,
        templateName: shippedTemplate,
        parameters: [],
        broadcastName: `Shipped_${orderNumber}`
      });
      addLog(`[SHIPPED] Successfully sent "${shippedTemplate}" to ${phone} for ${orderNumber}`);
    } catch (err) {
      addLog(`[SHIPPED ERROR] Failed to send "${shippedTemplate}" to ${phone}: ${err.message}`);
    }
  } catch (error) {
    addLog(`[Shopify Webhook ERROR orders-fulfilled]: ${error.message}`);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    }
  }
});

// ==========================================
// 4. Webhook: Order Delivered (Feedback)
// ==========================================
app.post('/webhooks/shopify/orders-delivered', async (req, res) => {
  try {
    const order = req.body;
    const customerName = order.customer?.first_name || order.shipping_address?.first_name || 'Valued Customer';
    const rawPhone = order.phone || order.customer?.phone || order.shipping_address?.phone || '';
    const phone = normalizePhoneNumber(rawPhone);
    const orderNumber = order.name || `#${order.order_number || order.id || ''}`;

    addLog(`[Delivery Webhook] Order Updated/Delivered check: ${orderNumber} (Phone: ${phone})`);

    if (!phone) {
      return res.status(200).json({ status: 'ignored', reason: 'No phone' });
    }

    // CRITICAL: Strict Delivery Verification
    const fulfillments = order.fulfillments || [];
    const isDelivered = fulfillments.some(f => f.shipment_status === 'delivered') ||
                        (order.tags && order.tags.toLowerCase().includes('delivered'));

    if (!isDelivered) {
      addLog(`[Delivery Webhook] Order ${orderNumber} is NOT delivered yet. Skipping feedback message.`);
      return res.status(200).json({ status: 'ignored', reason: 'Order is not marked delivered yet' });
    }

    // Atomic lock check
    const canSendFeedback = db.tryAcquireLock(orderNumber, 'order_feedback', phone);
    if (!canSendFeedback) {
      addLog(`[Delivery Webhook DEDUP] Feedback for ${orderNumber} / ${phone} already locked/sent. Skipping duplicate.`);
      return res.status(200).json({ status: 'ignored', reason: 'Duplicate feedback message' });
    }

    db.recordMessageSent(orderNumber, 'order_feedback');

    res.status(200).json({ status: 'accepted', order: orderNumber });

    const feedbackTemplate = process.env.TEMPLATE_DELIVERY_FEEDBACK || 'feedback_new';
    try {
      await sendTemplateMessage({
        phone,
        templateName: feedbackTemplate,
        parameters: [],
        broadcastName: `Feedback_${orderNumber}`
      });
      addLog(`[FEEDBACK] Successfully sent "${feedbackTemplate}" to ${phone} for ${orderNumber}`);
    } catch (err) {
      addLog(`[FEEDBACK ERROR] Failed to send "${feedbackTemplate}" to ${phone}: ${err.message}`);
    }
  } catch (error) {
    addLog(`[Delivery Webhook ERROR]: ${error.message}`);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    }
  }
});

// ==========================================
// 5. Cron Trigger Endpoint (for Cron-job.org / External Pings)
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
// 6. View Scheduled & Sent Jobs
// ==========================================
app.get('/admin/jobs', (req, res) => {
  const jobs = db.getAllJobs();
  res.json({ total: jobs.length, jobs });
});

// ==========================================
// 6b. Live Logs Endpoint
// ==========================================
app.get('/admin/logs', (req, res) => {
  res.json({ total: recentLogs.length, logs: recentLogs });
});

// ==========================================
// 7. Test Message Trigger
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
      parameters: customerName ? [{ name: 'customer_name', value: customerName }, { name: '1', value: customerName }] : [],
      broadcastName: 'Manual_Test'
    });

    res.json({ status: 'success', result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Start Server
app.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(`🚀 Auric Mills WhatsApp Automation Server Started!`);
  console.log(`📍 Port: ${PORT}`);
  console.log(`🌐 Health Check: http://localhost:${PORT}/health`);
  console.log(`📋 Admin Jobs:   http://localhost:${PORT}/admin/jobs`);
  console.log(`====================================================`);
});
