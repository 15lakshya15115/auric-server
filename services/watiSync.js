/**
 * WATI Historical Messages Sync Service for Auric Mills
 * Recovers all past broadcast messages, recipient delivery statuses,
 * customer names, and order numbers directly from WATI API.
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const db = require('./db');

const STAGE_LABELS = {
  order_confirmed: 'Order Confirmed',
  milling_started: 'Fresh Milling Drip',
  order_shipped: 'Order Shipped',
  order_feedback: 'Delivered & Review',
  manual_test: 'Manual Test'
};

/**
 * Fetch all contacts from WATI to build a phone/contactId -> customerName lookup cache
 */
async function buildContactDirectory(endpoint, authHeader) {
  const contactMap = new Map();
  let page = 1;
  const pageSize = 50;

  console.log('[WATI SYNC] Building contact name directory...');

  while (true) {
    try {
      const url = `${endpoint}/api/v1/getContacts?pageNumber=${page}&pageSize=${pageSize}`;
      const res = await fetch(url, { headers: { 'Authorization': authHeader } });
      if (!res.ok) break;

      const data = await res.json().catch(() => ({}));
      const list = data.contact_list || [];
      if (list.length === 0) break;

      for (const c of list) {
        let name = '';
        if (c.customParams && Array.isArray(c.customParams)) {
          const nameParam = c.customParams.find(p => p.name === 'customer_name' || p.name === '1');
          if (nameParam && nameParam.value) {
            name = String(nameParam.value).trim();
          }
        }
        if (!name && c.fullName && !c.fullName.match(/^\d+$/)) {
          name = c.fullName.trim();
        }

        if (name) {
          if (c.wAid) contactMap.set(c.wAid, name);
          if (c.phone) contactMap.set(c.phone, name);
          if (c.id) contactMap.set(c.id, name);
        }
      }

      // If we got fewer than pageSize, we've reached the end
      if (list.length < pageSize) break;
      page++;
      // Safety cap at 30 pages (1,500 contacts)
      if (page > 30) break;
    } catch (err) {
      console.warn(`[WATI SYNC] Warning fetching contacts page ${page}:`, err.message);
      break;
    }
  }

  console.log(`[WATI SYNC] Cached ${contactMap.size} customer names from contacts.`);
  return contactMap;
}

/**
 * Fetch all message templates to map template_id -> template_name
 */
async function buildTemplateDirectory(endpoint, authHeader) {
  const templateMap = new Map();
  try {
    const res = await fetch(`${endpoint}/api/v1/getMessageTemplates`, {
      headers: { 'Authorization': authHeader }
    });
    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      for (const t of data.messageTemplates || []) {
        templateMap.set(t.id, t.elementName || t.templateName || '');
      }
    }
  } catch (err) {
    console.warn('[WATI SYNC] Warning fetching message templates:', err.message);
  }
  return templateMap;
}

/**
 * Infer journey stage from broadcast name or template name
 */
function inferStage(broadcastName = '', templateName = '') {
  const bName = broadcastName.toLowerCase();
  const tName = templateName.toLowerCase();

  if (bName.includes('manual') || bName.includes('test') || tName === 'test_template') {
    return 'manual_test';
  }
  if (bName.startsWith('order_') || tName.includes('thank_you') || tName.includes('order_received')) {
    return 'order_confirmed';
  }
  if (bName.startsWith('feedback_') || tName.includes('feedback')) {
    return 'order_feedback';
  }
  if (bName.startsWith('shipped_') || tName.includes('shipped')) {
    return 'order_shipped';
  }
  if (bName.startsWith('milling_') || tName.includes('milling')) {
    return 'milling_started';
  }
  return 'order_confirmed';
}

/**
 * Parse Order ID from broadcast name
 */
function parseOrderId(broadcastName = '') {
  if (!broadcastName) return '-';
  const name = broadcastName.trim();

  if (name.toLowerCase().includes('manual_test') || name.toLowerCase() === 'manual_test') {
    return 'MANUAL_TEST';
  }

  const match = name.match(/#?(\d{3,7})/);
  if (match) {
    return `#${match[1]}`;
  }

  const parts = name.split('_');
  if (parts.length > 1 && parts[1]) {
    const candidate = parts[1].trim();
    return candidate.startsWith('#') ? candidate : `#${candidate}`;
  }

  return name;
}

/**
 * Fetch all broadcasts and their recipients, then merge into messages.json
 */
async function syncAllHistoricalMessages(options = {}) {
  const { maxBroadcasts = 1000, concurrency = 10 } = options;

  const endpoint = process.env.WATI_API_ENDPOINT;
  const token = process.env.WATI_ACCESS_TOKEN;

  if (!endpoint || !token) {
    throw new Error('WATI credentials missing in .env');
  }

  const authHeader = token.startsWith('Bearer ') ? token : `Bearer ${token}`;

  // 1. Build directory caches
  const [contactMap, templateMap] = await Promise.all([
    buildContactDirectory(endpoint, authHeader),
    buildTemplateDirectory(endpoint, authHeader)
  ]);

  // 2. Fetch all broadcasts from WATI API
  console.log('[WATI SYNC] Fetching broadcast history from WATI API...');
  let broadcasts = [];
  let page = 1;
  const pageSize = 100;

  while (true) {
    try {
      const url = `https://live-mt-server.wati.io/api/ext/v3/broadcasts?date_from=2025-01-01&date_to=2027-01-01&page_number=${page}&page_size=${pageSize}`;
      const res = await fetch(url, { headers: { 'Authorization': authHeader } });
      if (!res.ok) break;

      const data = await res.json().catch(() => ({}));
      const list = data.broadcasts || [];
      if (list.length === 0) break;

      broadcasts.push(...list);
      console.log(`[WATI SYNC] Loaded page ${page}: ${list.length} broadcasts (Total so far: ${broadcasts.length})`);

      if (list.length < pageSize || broadcasts.length >= maxBroadcasts) break;
      page++;
    } catch (err) {
      console.error(`[WATI SYNC] Error fetching broadcasts page ${page}:`, err.message);
      break;
    }
  }

  console.log(`[WATI SYNC] Found ${broadcasts.length} total broadcasts. Fetching recipient delivery details...`);

  // 3. Concurrently fetch recipients for each broadcast
  const syncedRecords = [];

  for (let i = 0; i < broadcasts.length; i += concurrency) {
    const chunk = broadcasts.slice(i, i + concurrency);
    const chunkResults = await Promise.all(
      chunk.map(async b => {
        try {
          const recUrl = `https://live-mt-server.wati.io/api/ext/v3/broadcasts/${b.id}/recipients?pageSize=1`;
          const res = await fetch(recUrl, { headers: { 'Authorization': authHeader } });
          if (!res.ok) return null;

          const recData = await res.json().catch(() => ({}));
          const r = recData.recipients?.[0] || null;
          if (!r) return null;

          const bName = b.name || '';
          const templateName = templateMap.get(b.template_id) || '';
          const stage = inferStage(bName, templateName);
          const orderId = parseOrderId(bName);

          const phone = r.contact_phone || r.contact_name || '';

          // Find customer name:
          // 1. From recipient custom_params
          let customerName = '';
          if (r.custom_params && Array.isArray(r.custom_params)) {
            const p = r.custom_params.find(x => x.name === 'customer_name' || x.name === '1');
            if (p && p.value) customerName = String(p.value).trim();
          }

          // 2. From cached contact directory
          if (!customerName && phone && contactMap.has(phone)) {
            customerName = contactMap.get(phone);
          }
          if (!customerName && r.contact_id && contactMap.has(r.contact_id)) {
            customerName = contactMap.get(r.contact_id);
          }

          // 3. Fallback
          if (!customerName || customerName.match(/^\d+$/)) {
            customerName = 'Valued Customer';
          }

          const status = (r.status || 'delivered').toLowerCase();
          const timestamp = new Date(r.created || b.created).getTime();

          return {
            id: `msg_sync_${b.id}`,
            orderId,
            customerName,
            phone,
            rawPhone: phone,
            templateName,
            stage,
            stageLabel: STAGE_LABELS[stage] || stage,
            status: status === 'read' ? 'read' : status === 'delivered' ? 'delivered' : status === 'failed' ? 'failed' : 'sent',
            failureReason: r.failed_code ? String(r.failed_code) : null,
            watiMessageId: r.message_id || b.id,
            createdAt: timestamp,
            scheduledAt: null,
            sentAt: timestamp,
            deliveredAt: status === 'delivered' || status === 'read' ? timestamp : null,
            readAt: status === 'read' ? timestamp : null,
            retryCount: 0,
            source: 'wati_sync'
          };
        } catch (err) {
          return null;
        }
      })
    );

    for (const r of chunkResults) {
      if (r) syncedRecords.push(r);
    }
  }

  console.log(`[WATI SYNC] Successfully processed ${syncedRecords.length} historical delivery records.`);

  // 4. Merge into existing data/messages.json
  const existing = db.readMessages ? db.readMessages() : [];

  // Build index of existing items by watiMessageId and (orderId + stage)
  const existingMap = new Map();
  for (const m of existing) {
    if (m.watiMessageId) existingMap.set(m.watiMessageId, m);
    if (m.orderId && m.stage && m.orderId !== '-') {
      existingMap.set(`${m.orderId}_${m.stage}`, m);
    }
  }

  // Preserve scheduled jobs / existing messages
  let addedCount = 0;
  let updatedCount = 0;

  for (const s of syncedRecords) {
    const key = `${s.orderId}_${s.stage}`;
    const byWatiId = s.watiMessageId ? existingMap.get(s.watiMessageId) : null;
    const byOrderStage = (s.orderId !== '-' && s.orderId !== 'MANUAL_TEST') ? existingMap.get(key) : null;
    const match = byWatiId || byOrderStage;

    if (match) {
      // Update delivery status if it improved (e.g. sent -> delivered -> read)
      if (s.status === 'read' && match.status !== 'read') {
        match.status = 'read';
        match.readAt = s.readAt || Date.now();
        updatedCount++;
      } else if (s.status === 'delivered' && match.status === 'sent') {
        match.status = 'delivered';
        match.deliveredAt = s.deliveredAt || Date.now();
        updatedCount++;
      }
      if (!match.watiMessageId && s.watiMessageId) {
        match.watiMessageId = s.watiMessageId;
      }
    } else {
      existing.push(s);
      addedCount++;
    }
  }

  // Sort newest first
  existing.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  // Write back to database
  db.writeMessages(existing);

  console.log(`[WATI SYNC COMPLETE] Added ${addedCount} new records, updated ${updatedCount} existing records. Total messages now: ${existing.length}`);

  return {
    success: true,
    addedCount,
    updatedCount,
    totalMessages: existing.length
  };
}

module.exports = {
  syncAllHistoricalMessages
};
