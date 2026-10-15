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
// 2. Webhook: Order Created (Instant Confirm + 2-Day Milling Drip)
// ==========================================
app.post('/webhooks/shopify/orders-create', async (req, res) => {
  try {
    const order = req.body;
    console.log(`[Shopify Webhook] New Order Received: ${order.name || order.id}`);

    const customerName = order.customer?.first_name || order.shipping_address?.first_name || 'Valued Customer';
    const rawPhone = order.phone || order.customer?.phone || order.shipping_address?.phone || '';
    const phone = normalizePhoneNumber(rawPhone);
    const orderNumber = order.name || `#${order.order_number || order.id}`;

    if (!phone) {
      console.warn(`[Shopify Webhook] Order ${orderNumber} has no phone. Skipping.`);
      return res.status(200).json({ status: 'ignored', reason: 'No phone number found' });
    }

    // Message 1: Order Received (Instant)
    const orderTemplate = process.env.TEMPLATE_ORDER_CONFIRMED || 'order_received_new';
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
    } catch (err) {
      console.error(`[Webhook] Error sending order confirmation to ${phone}:`, err.message);
    }

    // Message 2: Fresh Milling Started (Scheduled 2 Days = 48 Hours Later)
    const millingTemplate = process.env.TEMPLATE_MILLING_STARTED || 'fresh_milling_started_new';
    const twoDaysMs = 2 * 24 * 60 * 60 * 1000;
    const scheduledTime = Date.now() + twoDaysMs;

    db.addJob({
      orderId: orderNumber,
      customerName,
      phone,
      templateName: millingTemplate,
      parameters: [],
      scheduledAt: scheduledTime
    });

    res.status(200).json({
      status: 'success',
      order: orderNumber,
      instantMessage: 'sent',
      millingScheduledFor: new Date(scheduledTime).toISOString()
    });
  } catch (error) {
    console.error('[Shopify Webhook ERROR orders-create]:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// 3. Webhook: Order Shipped / Fulfilled
// ==========================================
app.post('/webhooks/shopify/orders-fulfilled', async (req, res) => {
  try {
    const payload = req.body;
    console.log(`[Shopify Webhook] Order Fulfilled: ${payload.name || payload.id}`);

    const order = payload.order || payload;
    const customerName = order.customer?.first_name || order.shipping_address?.first_name || 'Valued Customer';
    const rawPhone = order.phone || order.customer?.phone || order.shipping_address?.phone || '';
    const phone = normalizePhoneNumber(rawPhone);
    const orderNumber = order.name || `#${order.order_number || order.id || ''}`;

    if (!phone) {
      return res.status(200).json({ status: 'ignored', reason: 'No phone' });
    }

    // Message 3: Order Shipped
    const shippedTemplate = process.env.TEMPLATE_ORDER_SHIPPED || 'order_shipped_new';
    await sendTemplateMessage({
      phone,
      templateName: shippedTemplate,
      parameters: [],
      broadcastName: `Shipped_${orderNumber}`
    });

    res.status(200).json({ status: 'success', order: orderNumber, message: 'shipped_sent' });
  } catch (error) {
    console.error('[Shopify Webhook ERROR orders-fulfilled]:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// 4. Webhook: Order Delivered (Feedback)
// ==========================================
app.post('/webhooks/shopify/orders-delivered', async (req, res) => {
  try {
    const order = req.body;
    console.log(`[Delivery Webhook] Order Delivered: ${order.name || order.id}`);

    const customerName = order.customer?.first_name || order.shipping_address?.first_name || 'Valued Customer';
    const rawPhone = order.phone || order.customer?.phone || order.shipping_address?.phone || '';
    const phone = normalizePhoneNumber(rawPhone);
    const orderNumber = order.name || `#${order.order_number || order.id || ''}`;

    if (!phone) {
      return res.status(200).json({ status: 'ignored', reason: 'No phone' });
    }

    // Message 4: Feedback & Google Review
    const feedbackTemplate = process.env.TEMPLATE_DELIVERY_FEEDBACK || 'feedback_new';
    await sendTemplateMessage({
      phone,
      templateName: feedbackTemplate,
      parameters: [],
      broadcastName: `Feedback_${orderNumber}`
    });

    res.status(200).json({ status: 'success', order: orderNumber, message: 'feedback_sent' });
  } catch (error) {
    console.error('[Delivery Webhook ERROR]:', error);
    res.status(500).json({ error: error.message });
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
