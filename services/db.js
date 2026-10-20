const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'jobs.json');

// Ensure data directory and file exist
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

if (!fs.existsSync(DB_FILE)) {
  fs.writeFileSync(DB_FILE, JSON.stringify([], null, 2), 'utf-8');
}

function readJobs() {
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf-8');
    return JSON.parse(raw || '[]');
  } catch (err) {
    console.error('[DB] Error reading jobs database:', err.message);
    return [];
  }
}

function writeJobs(jobs) {
  try {
    const tempFile = `${DB_FILE}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify(jobs, null, 2), 'utf-8');
    fs.renameSync(tempFile, DB_FILE);
  } catch (err) {
    console.error('[DB] Error writing jobs database:', err.message);
  }
}

/**
 * Add a new scheduled job (e.g. 2-Day Milling Started message)
 */
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
    status: 'pending', // 'pending' | 'sent' | 'failed'
    createdAt: Date.now(),
    sentAt: null,
    error: null,
    retryCount: 0
  };

  jobs.push(newJob);
  writeJobs(jobs);
  console.log(`[DB] Scheduled job created: ${id} (${templateName}) for ${new Date(scheduledAt).toLocaleString()}`);
  return newJob;
}

/**
 * Get all pending jobs that are due
 */
function getDuePendingJobs() {
  const jobs = readJobs();
  const now = Date.now();
  return jobs.filter(j => j.status === 'pending' && j.scheduledAt <= now);
}

/**
 * Mark a job as successfully sent
 */
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

/**
 * Mark a job as failed
 */
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

/**
 * Get all jobs for dashboard/debugging
 */
function getAllJobs(limit = 100) {
  const jobs = readJobs();
  return jobs.slice(-limit).reverse();
}

const SENT_EVENTS_FILE = path.join(DATA_DIR, 'sent_events.json');

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

function isJobScheduled(orderId, templateName) {
  const jobs = readJobs();
  return jobs.some(j => String(j.orderId) === String(orderId) && j.templateName === templateName);
}

// In-memory locks map: key -> timestamp (persists during process lifetime)
const memoryLocks = new Map();

/**
 * Atomic deduplication lock
 * Checks both Order ID and Phone Number.
 * If either was locked/processed within cooldown window, returns false.
 * Otherwise locks immediately and returns true.
 */
function tryAcquireLock(orderId, type, phone = '', cooldownMs = 15 * 60 * 1000) {
  const now = Date.now();
  const orderKey = orderId ? `order_${orderId}_${type}` : null;
  const phoneKey = phone ? `phone_${phone}_${type}` : null;

  // Check memory locks first
  if (orderKey && memoryLocks.has(orderKey)) {
    const ts = memoryLocks.get(orderKey);
    if (now - ts < cooldownMs) {
      return false; // Order locked!
    }
  }

  if (phoneKey && memoryLocks.has(phoneKey)) {
    const ts = memoryLocks.get(phoneKey);
    if (now - ts < cooldownMs) {
      return false; // Phone locked!
    }
  }

  // Check persistent storage
  if (orderId && hasMessageBeenSent(orderId, type)) {
    return false;
  }

  // Set memory locks immediately
  if (orderKey) memoryLocks.set(orderKey, now);
  if (phoneKey) memoryLocks.set(phoneKey, now);

  // Clean old locks if map grows too large (> 2000 entries)
  if (memoryLocks.size > 2000) {
    for (const [k, v] of memoryLocks.entries()) {
      if (now - v > cooldownMs) memoryLocks.delete(k);
    }
  }

  return true;
}

module.exports = {
  addJob,
  getDuePendingJobs,
  markJobSent,
  markJobFailed,
  getAllJobs,
  recordMessageSent,
  hasMessageBeenSent,
  isJobScheduled,
  tryAcquireLock
};

