# Auric Mills — WhatsApp Automation Server & Live Dashboard (WATI)

Independent Node.js middleware server connecting **Shopify Orders** to **WATI WhatsApp Business API** with a real-time command-center **Admin Dashboard** for Auric Mills.

---

## 🌾 The 4-Step Customer WhatsApp Journey

1. **Order Confirmed (Instant):** Sent immediately when an order is created (`thank_you_new`).
2. **Fresh Milling Started (Next Day 11:00 AM IST):** Scheduled in database and sent automatically next calendar morning at 11:00 AM IST (`fresh_milling_started_new`).
3. **Order Shipped (Instant on Dispatch):** Sent immediately when the order is fulfilled (`order_shipped_new`).
4. **Order Delivered & Feedback (Instant on Delivery):** Sent when the order is delivered with Google Review link and Order Again link (`feedback_new`).

---

## 📊 Live Admin Dashboard (`/dashboard`)

Access at: `https://your-domain.com/dashboard` (Default PIN: `auric2026`)

* **Live Delivery Badges:** `Delivered ✔️✔️`, `Read 👁️`, `Dispatched ↗️`, `Failed ❌`, `Scheduled 🕒`.
* **Exact Failure Reasons:** Identifies why a message didn't reach a customer (*"Not on WhatsApp"*, *"Missing phone at checkout"*, *"Balance exhausted"*, etc.).
* **Shopify Webhook Pulse:** Real-time indicator showing if Shopify webhooks are receiving live orders.
* **1-Click Actions:** Direct "Resend" and "Open WhatsApp Chat" (`wa.me`) for any customer.
* **Automation Toggles:** Turn on/off individual message stages with a switch without restarting the server.
* **Export CSV:** One-click download of all WhatsApp message logs and customer delivery reports.
* **Test Tool:** Built-in modal to test any WhatsApp template to your own phone number.

---

## 📁 Project Structure

```
auric-server/
├── data/
│   ├── jobs.json             # Persistent database for scheduled 11:00 AM drip messages
│   ├── messages.json         # Full delivery logs & status history (persistent)
│   ├── settings.json         # Automation toggles & webhook pulse tracker
│   └── sent_events.json      # Deduplication locks (prevents double messages)
├── public/
│   └── dashboard.html        # Interactive, mobile-responsive Web Dashboard
├── services/
│   ├── db.js                 # Database manager (messages, stats, settings, locks)
│   ├── wati.js               # WATI WhatsApp API client, phone normalizer & failure parser
│   └── scheduler.js          # Background cron scheduler (runs every 5 mins)
├── .env                      # Live WATI credentials, template names & DASHBOARD_PIN
├── .env.example              # Sample environment template
├── server.js                 # Express routes, dashboard API & Shopify/WATI webhooks
└── README.md                 # Documentation
```

---

## 🚀 How to Run Locally

```bash
cd d:\wepitch\auric-server
npm install
npm start
```

* Dashboard: `http://localhost:3000/dashboard` (PIN: `auric2026`)
* Health Check: `http://localhost:3000/health`

---

## ☁️ Deploy to Hostinger (Shared / Cloud Hosting)

1. In Hostinger hPanel, create a subdomain (e.g., `whatsapp.auricmills.com`) and activate **Free SSL**.
2. Go to **Node.js** in hPanel &rarr; Click **Create Application**:
   * Version: `20.x` or `18.x`
   * Mode: `Production`
   * Startup File: `server.js`
   * App Root: `public_html/whatsapp`
3. Upload all files from this folder (except `node_modules`).
4. Click **NPM Install** in hPanel, then **Start / Restart Application**.
5. Set up **Cron Job** in hPanel (Runs every 5 mins: `*/5 * * * *`):
   ```bash
   curl -s https://whatsapp.auricmills.com/cron/process > /dev/null 2>&1
   ```
6. In **Shopify Admin** &rarr; **Settings** &rarr; **Notifications** &rarr; **Webhooks**:
   * `Order creation` &rarr; `https://whatsapp.auricmills.com/webhooks/shopify/orders-create`
   * `Order fulfillment` &rarr; `https://whatsapp.auricmills.com/webhooks/shopify/orders-fulfilled`
   * `Order updated` &rarr; `https://whatsapp.auricmills.com/webhooks/shopify/orders-delivered`
