/**
 * Utility script to import past Shopify orders from CSV export
 * into the local dashboard database with ZERO WATI API calls!
 * 
 * Usage:
 * 1. Export orders from Shopify Admin -> Orders -> Export -> All orders (CSV).
 * 2. Save the file as "shopify_orders.csv" in the root of auric-server.
 * 3. Run: node scripts/import_shopify_csv.js
 */

const fs = require('fs');
const path = require('path');
const db = require('../services/db');

const CSV_PATH = path.join(__dirname, '..', 'shopify_orders.csv');

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"' && (i === 0 || line[i - 1] !== '\\')) {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

function importOrders() {
  if (!fs.existsSync(CSV_PATH)) {
    console.log(`[Import Error] No "shopify_orders.csv" found in: ${CSV_PATH}`);
    console.log('Please place your Shopify orders CSV file there and run again.');
    return;
  }

  const content = fs.readFileSync(CSV_PATH, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim().length > 0);

  if (lines.length < 2) {
    console.log('[Import Error] CSV file appears empty.');
    return;
  }

  const header = parseCSVLine(lines[0]);
  const nameIdx = header.indexOf('Name');
  const dateIdx = header.indexOf('Created at');
  const billNameIdx = header.indexOf('Billing Name');
  const shipNameIdx = header.indexOf('Shipping Name');
  const phoneIdx = header.indexOf('Phone');
  const shipPhoneIdx = header.indexOf('Shipping Phone');
  const fulfillIdx = header.indexOf('Fulfillment Status');

  console.log(`Found ${lines.length - 1} rows in CSV. Parsing unique orders...`);

  const seenOrders = new Set();
  let importedCount = 0;

  for (let i = 1; i < lines.length; i++) {
    const row = parseCSVLine(lines[i]);
    const orderNumber = nameIdx !== -1 ? row[nameIdx] : '';
    if (!orderNumber || seenOrders.has(orderNumber)) continue;
    seenOrders.add(orderNumber);

    const rawDate = dateIdx !== -1 ? row[dateIdx] : '';
    const customerName = (shipNameIdx !== -1 && row[shipNameIdx]) || (billNameIdx !== -1 && row[billNameIdx]) || 'Valued Customer';
    const rawPhone = (shipPhoneIdx !== -1 && row[shipPhoneIdx]) || (phoneIdx !== -1 && row[phoneIdx]) || '';
    const fulfillmentStatus = fulfillIdx !== -1 ? row[fulfillIdx] : '';

    const timestamp = rawDate ? new Date(rawDate).getTime() : Date.now();

    // Record Order Confirmed
    db.recordMessage({
      orderId: orderNumber,
      customerName,
      phone: rawPhone,
      rawPhone,
      templateName: 'thank_you_new',
      stage: 'order_confirmed',
      status: rawPhone ? 'delivered' : 'skipped',
      failureReason: rawPhone ? null : 'Missing phone number (Customer used email only)',
      sentAt: timestamp,
      source: 'shopify_csv_import'
    });

    // If fulfilled, also record Order Shipped
    if (fulfillmentStatus && fulfillmentStatus.toLowerCase().includes('fulfilled')) {
      db.recordMessage({
        orderId: orderNumber,
        customerName,
        phone: rawPhone,
        rawPhone,
        templateName: 'order_shipped_new',
        stage: 'order_shipped',
        status: rawPhone ? 'delivered' : 'skipped',
        failureReason: rawPhone ? null : 'Missing phone number (Customer used email only)',
        sentAt: timestamp + 24 * 60 * 60 * 1000,
        source: 'shopify_csv_import'
      });
    }

    importedCount++;
  }

  console.log(`Successfully imported ${importedCount} past orders into dashboard database with 0 WATI API calls!`);
}

importOrders();
