const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'jobs.json');
const MESSAGES_FILE = path.join(DATA_DIR, 'messages.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const SENT_EVENTS_FILE = path.join(DATA_DIR, 'sent_events.json');

// Ensure data directory and files exist
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function initFile(filePath, defaultContent) {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(defaultContent, null, 2), 'utf-8');
  }
}

initFile(DB_FILE, []);
initFile(MESSAGES_FILE, []);
initFile(SENT_EVENTS_FILE, {});
initFile(SETTINGS_FILE, {
  automations: {
    order_confirmed: true,
    milling_started: true,
    order_shipped: true,
    order_feedback: true
  },
  lastWebhook: {
    timestamp: null,
    orderNumber: null,
    topic: null,
    phone: null
  }
});

// ==========================================
// 1. Settings & Webhook Pulse
// ==========================================
function getSettings() {
  try {
    const raw = fs.readFileSync(SETTINGS_FILE, 'utf-8');
    return JSON.parse(raw || '{}');
  } catch (err) {
    return {
      automations: {
        order_confirmed: true,
        milling_started: true,
        order_shipped: true,
        order_feedback: true
      },
      lastWebhook: { timestamp: null, orderNumber: null, topic: null, phone: null }
    };
  }
}

function updateSettings(patch) {
  try {
    const current = getSettings();
    const updated = {
      ...current,
      ...patch,
      automations: {
        ...(current.automations || {}),
        ...(patch.automations || {})
      }
    };
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(updated, null, 2), 'utf-8');
    return updated;
  } catch (err) {
    console.error('[DB] Error updating settings:', err.message);
    return getSettings();
  }
}

function recordWebhookPulse(topic, orderNumber, phone) {
  try {
    const current = getSettings();
    current.lastWebhook = {
      timestamp: Date.now(),
      orderNumber: String(orderNumber || ''),
      topic: String(topic || ''),
      phone: String(phone || '')
    };
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(current, null, 2), 'utf-8');
  } catch (err) {
    console.error('[DB] Error recording webhook pulse:', err.message);
  }
}

// ==========================================
// 2. Full Message History & Delivery Tracking
// ==========================================
function readMessages() {
  try {
    const raw = fs.readFileSync(MESSAGES_FILE, 'utf-8');
    return JSON.parse(raw || '[]');
  } catch (err) {
    console.error('[DB] Error reading messages:', err.message);
    return [];
  }
}

function writeMessages(messages) {
  try {
    const tempFile = `${MESSAGES_FILE}.tmp`;
    // Keep top 5000 records (newest first) to prevent infinite growth
    const trimmed = messages.slice(0, 5000);
    fs.writeFileSync(tempFile, JSON.stringify(trimmed, null, 2), 'utf-8');
    fs.renameSync(tempFile, MESSAGES_FILE);
  } catch (err) {
    console.error('[DB] Error writing messages:', err.message);
  }
}

const STAGE_LABELS = {
  order_confirmed: 'Order Confirmed',
  milling_started: 'Fresh Milling Drip',
  order_shipped: 'Order Shipped',
  order_feedback: 'Delivered & Review',
  manual_test: 'Manual Test'
};

/**
 * Record a message in the persistent message log
 */
function recordMessage({
  orderId = '',
  customerName = 'Valued Customer',
  phone = '',
  rawPhone = '',
  templateName = '',
  stage = 'order_confirmed',
  status = 'sent', // 'scheduled' | 'sent' | 'delivered' | 'read' | 'failed' | 'skipped'
  failureReason = null,
  watiMessageId = null,
  scheduledAt = null,
  sentAt = Date.now(),
  source = 'shopify_webhook'
}) {
  const messages = readMessages();
  const id = `msg_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

  const record = {
    id,
    orderId: String(orderId || ''),
    customerName: String(customerName || 'Customer'),
    phone: String(phone || ''),
    rawPhone: String(rawPhone || phone || ''),
    templateName: String(templateName || ''),
    stage: String(stage || 'order_confirmed'),
    stageLabel: STAGE_LABELS[stage] || stage,
    status: String(status || 'sent'),
    failureReason: failureReason ? String(failureReason) : null,
    watiMessageId: watiMessageId ? String(watiMessageId) : null,
    createdAt: Date.now(),
    scheduledAt: scheduledAt ? Number(scheduledAt) : null,
    sentAt: status === 'scheduled' || status === 'skipped' ? null : sentAt,
    deliveredAt: status === 'delivered' ? Date.now() : null,
    readAt: status === 'read' ? Date.now() : null,
    retryCount: 0,
    source
  };

  messages.unshift(record); // newest first
  writeMessages(messages);
  console.log(`[DB MESSAGE LOG] Recorded ${id} for ${record.orderId} - Status: ${record.status}`);
  return record;
}

/**
 * Update message status (e.g. from WATI webhook callback: sent -> delivered -> read -> failed)
 */
function updateMessageStatus(identifier, status, details = {}) {
  const messages = readMessages();
  let updated = false;

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const match =
      m.id === identifier ||
      (m.watiMessageId && m.watiMessageId === identifier) ||
      (details.orderId && m.orderId === details.orderId && m.stage === details.stage);

    if (match) {
      m.status = status;
      if (details.failureReason) m.failureReason = details.failureReason;
      if (details.watiMessageId) m.watiMessageId = details.watiMessageId;
      if (status === 'delivered' && !m.deliveredAt) m.deliveredAt = details.deliveredAt || Date.now();
      if (status === 'read') {
        if (!m.deliveredAt) m.deliveredAt = details.deliveredAt || Date.now();
        if (!m.readAt) m.readAt = details.readAt || Date.now();
      }
      if (status === 'sent' && !m.sentAt) m.sentAt = Date.now();
      updated = true;
      break;
    }
  }

  if (updated) {
    writeMessages(messages);
  }
  return updated;
}

/**
 * Retrieve messages with search, filter, and pagination
 */
function getAllMessages({ limit = 50, offset = 0, status, search, stage } = {}) {
  let list = readMessages();

  if (status && status !== 'all') {
    list = list.filter(m => m.status === status);
  }

  if (stage && stage !== 'all') {
    list = list.filter(m => m.stage === stage);
  }

  if (search && search.trim() !== '') {
    const q = search.trim().toLowerCase();
    list = list.filter(m =>
      (m.orderId && m.orderId.toLowerCase().includes(q)) ||
      (m.phone && m.phone.includes(q)) ||
      (m.customerName && m.customerName.toLowerCase().includes(q)) ||
      (m.templateName && m.templateName.toLowerCase().includes(q)) ||
      (m.failureReason && m.failureReason.toLowerCase().includes(q))
    );
  }

  const total = list.length;
  const page = list.slice(offset, offset + limit);

  return { total, messages: page };
}

/**
 * Calculate KPI summary stats
 */
function getDashboardStats() {
  const messages = readMessages();
  const settings = getSettings();
  const jobs = readJobs();

  // Calculate start of today in IST (UTC+5:30)
  const now = new Date();
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const istNow = new Date(now.getTime() + IST_OFFSET_MS);
  const istTodayStart = new Date(
    Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate(), -5, -30, 0, 0)
  ).getTime();

  let totalSentToday = 0;
  let totalAllTime = 0;
  let deliveredCount = 0;
  let readCount = 0;
  let failedCount = 0;
  let skippedCount = 0;

  for (const m of messages) {
    if (m.status !== 'scheduled' && m.status !== 'skipped') {
      totalAllTime++;
      if (m.createdAt >= istTodayStart) {
        totalSentToday++;
      }
    }

    if (m.status === 'delivered') deliveredCount++;
    else if (m.status === 'read') {
      readCount++;
      deliveredCount++; // Read implies delivered
    } else if (m.status === 'failed') failedCount++;
    else if (m.status === 'skipped') skippedCount++;
  }

  const pendingScheduled = jobs.filter(j => j.status === 'pending').length;

  const validAttempts = deliveredCount + failedCount;
  const successRate = validAttempts > 0 ? Math.round((deliveredCount / validAttempts) * 100) : 100;

  return {
    totalSentToday,
    totalAllTime,
    deliveredCount,
    readCount,
    failedCount,
    skippedCount,
    pendingScheduled,
    successRate,
    automations: settings.automations || {},
    lastWebhook: settings.lastWebhook || {}
  };
}

// ==========================================
// 3. Scheduled Jobs (for 11:00 AM IST Milling Drip)
// ==========================================
function readJobs() {
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf-8');
    return JSON.parse(raw || '[]');
  } catch (err) {
    return [];
  }
}

function writeJobs(jobs) {
  try {
    const tempFile = `${DB_FILE}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify(jobs, null, 2), 'utf-8');
    fs.renameSync(tempFile, DB_FILE);
  } catch (err) {
    console.error('[DB] Error writing jobs:', err.message);
  }
}

function addJob({ orderId, customerName, phone, templateName, parameters = [], scheduledAt }) {
  const jobs = readJobs();
  const id = `job_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const newJob = {
    id,
    orderId: String(orderId || ''),
    customerName: String(customerName || 'Customer'),
    phone: String(phone || ''),
    templateName: String(templateName || ''),
    parameters,
    scheduledAt: Number(scheduledAt),
    status: 'pending',
    createdAt: Date.now(),
    sentAt: null,
    error: null,
    retryCount: 0
  };

  jobs.push(newJob);
  writeJobs(jobs);

  // Also record in messages log as "scheduled"
  recordMessage({
    orderId,
    customerName,
    phone,
    templateName,
    stage: 'milling_started',
    status: 'scheduled',
    scheduledAt
  });

  console.log(`[DB] Scheduled job created: ${id} (${templateName}) for ${new Date(scheduledAt).toLocaleString()}`);
  return newJob;
}

function getDuePendingJobs() {
  const jobs = readJobs();
  const now = Date.now();
  return jobs.filter(j => j.status === 'pending' && j.scheduledAt <= now);
}

function markJobSent(id) {
  const jobs = readJobs();
  const index = jobs.findIndex(j => j.id === id);
  if (index !== -1) {
    jobs[index].status = 'sent';
    jobs[index].sentAt = Date.now();
    writeJobs(jobs);
    console.log(`[DB] Job ${id} marked as SENT`);
  }
}

function markJobFailed(id, errorMessage) {
  const jobs = readJobs();
  const index = jobs.findIndex(j => j.id === id);
  if (index !== -1) {
    jobs[index].retryCount = (jobs[index].retryCount || 0) + 1;
    jobs[index].error = errorMessage;
    if (jobs[index].retryCount >= 3) {
      jobs[index].status = 'failed';
    }
    writeJobs(jobs);
    console.log(`[DB] Job ${id} marked as FAILED (retry: ${jobs[index].retryCount})`);
  }
}

function getAllJobs(limit = 100) {
  const jobs = readJobs();
  return jobs.slice(-limit).reverse();
}

function isJobScheduled(orderId, templateName) {
  const jobs = readJobs();
  return jobs.some(j => String(j.orderId) === String(orderId) && j.templateName === templateName);
}

// ==========================================
// 4. Deduplication & In-Memory Locks
// ==========================================
function readSentEvents() {
  try {
    if (!fs.existsSync(SENT_EVENTS_FILE)) return {};
    const raw = fs.readFileSync(SENT_EVENTS_FILE, 'utf-8');
    return JSON.parse(raw || '{}');
  } catch (err) {
    return {};
  }
}

function recordMessageSent(orderId, type) {
  try {
    const events = readSentEvents();
    const key = String(orderId);
    if (!events[key]) events[key] = [];
    if (!events[key].includes(type)) {
      events[key].push(type);
      fs.writeFileSync(SENT_EVENTS_FILE, JSON.stringify(events, null, 2), 'utf-8');
    }
  } catch (err) {
    console.error('[DB] Error recording sent event:', err.message);
  }
}

function hasMessageBeenSent(orderId, type) {
  const events = readSentEvents();
  const key = String(orderId);
  return Boolean(events[key] && events[key].includes(type));
}

const memoryLocks = new Map();

function tryAcquireLock(orderId, type, phone = '', cooldownMs = 15 * 60 * 1000) {
  const now = Date.now();
  const orderKey = orderId ? `order_${orderId}_${type}` : null;
  const phoneKey = phone ? `phone_${phone}_${type}` : null;

  if (orderKey && memoryLocks.has(orderKey)) {
    const ts = memoryLocks.get(orderKey);
    if (now - ts < cooldownMs) return false;
  }

  if (phoneKey && memoryLocks.has(phoneKey)) {
    const ts = memoryLocks.get(phoneKey);
    if (now - ts < cooldownMs) return false;
  }

  if (orderId && hasMessageBeenSent(orderId, type)) {
    return false;
  }

  if (orderKey) memoryLocks.set(orderKey, now);
  if (phoneKey) memoryLocks.set(phoneKey, now);

  if (memoryLocks.size > 2000) {
    for (const [k, v] of memoryLocks.entries()) {
      if (now - v > cooldownMs) memoryLocks.delete(k);
    }
  }

  return true;
}

module.exports = {
  readMessages,
  writeMessages,
  getSettings,
  updateSettings,
  recordWebhookPulse,
  recordMessage,
  updateMessageStatus,
  getAllMessages,
  getDashboardStats,
  addJob,
  getDuePendingJobs,
  markJobSent,
  markJobFailed,
  getAllJobs,
  isJobScheduled,
  recordMessageSent,
  hasMessageBeenSent,
  tryAcquireLock
};
