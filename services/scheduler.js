const cron = require('node-cron');
const db = require('./db');
const { sendTemplateMessage } = require('./wati');

let isProcessing = false;

/**
 * Process all pending scheduled messages that are due
 */
async function processPendingMessages() {
  if (isProcessing) {
    console.log('[Scheduler] Already processing, skipping run.');
    return { processed: 0, skipped: true };
  }

  const settings = db.getSettings();
  if (settings.automations && settings.automations.milling_started === false) {
    console.log('[Scheduler] Milling drip automation is currently PAUSED via dashboard.');
    return { processed: 0, paused: true };
  }

  isProcessing = true;
  let processedCount = 0;

  try {
    const dueJobs = db.getDuePendingJobs();

    if (dueJobs.length === 0) {
      isProcessing = false;
      return { processed: 0 };
    }

    console.log(`[Scheduler] Found ${dueJobs.length} due message(s) to send.`);

    for (const job of dueJobs) {
      try {
        console.log(`[Scheduler] Sending scheduled "${job.templateName}" to ${job.phone}`);
        const res = await sendTemplateMessage({
          phone: job.phone,
          templateName: job.templateName,
          parameters: job.parameters,
          broadcastName: `Scheduled_${job.templateName}`
        });

        db.markJobSent(job.id);
        db.recordMessageSent(job.orderId, 'milling_started');
        db.updateMessageStatus(null, 'delivered', {
          orderId: job.orderId,
          stage: 'milling_started',
          watiMessageId: res.messageId
        });
        processedCount++;
      } catch (err) {
        console.error(`[Scheduler ERROR] Failed job ${job.id}:`, err.message);
        db.markJobFailed(job.id, err.message);
        db.updateMessageStatus(null, 'failed', {
          orderId: job.orderId,
          stage: 'milling_started',
          failureReason: err.friendlyReason || err.message
        });
      }
    }
  } catch (err) {
    console.error('[Scheduler ERROR] Error in processPendingMessages:', err.message);
  } finally {
    isProcessing = false;
  }

  return { processed: processedCount };
}

/**
 * Initialize background cron runner (runs every 5 minutes)
 */
function initScheduler() {
  cron.schedule('*/5 * * * *', async () => {
    console.log('[Scheduler] Checking for due messages...');
    await processPendingMessages();
  });

  console.log('[Scheduler] Cron initialized (runs every 5 minutes).');
}

module.exports = {
  initScheduler,
  processPendingMessages
};
