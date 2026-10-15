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

module.exports = {
  addJob,
  getDuePendingJobs,
  markJobSent,
  markJobFailed,
  getAllJobs
};
