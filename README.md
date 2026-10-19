# Auric Mills — WhatsApp Automation Server (WATI)

Independent Node.js middleware server connecting **Shopify Orders** to **WATI WhatsApp Business API** for Auric Mills.

---

## 🌾 The 4-Step Customer WhatsApp Journey

1. **Order Confirmed (Instant):** Sent immediately when an order is created (`thank_you_new`).
2. **Fresh Milling Started (Next Day 11:00 AM IST):** Scheduled in database and sent automatically next calendar morning at 11:00 AM IST (`fresh_milling_started_new`).
3. **Order Shipped (Instant on Dispatch):** Sent immediately when the order is fulfilled (`order_shipped_new`).
4. **Order Delivered & Feedback (Instant on Delivery):** Sent when the order is delivered with Google Review link and Order Again link (`feedback_new`).

---

## 📁 Project Structure

```
auric-server/
├── data/
│   └── jobs.json         # Persistent database for scheduled 2-day drip messages
├── services/
│   ├── db.js             # Atomic database manager
│   ├── wati.js           # WATI WhatsApp API caller & phone normalizer
│   └── scheduler.js      # Background cron scheduler (every 5 mins)
├── .env                  # Live WATI credentials & template mappings
├── .env.example          # Sample environment variables
├── .gitignore            # Protects secrets & node_modules
├── package.json          # Node dependencies
├── server.js             # Express routes & Shopify webhooks
└── README.md             # Documentation
```

---

## 🚀 How to Run Locally

```bash
cd d:\wepitch\auric-server
npm install
npm start
```

Health Check: `http://localhost:3000/health`  
Admin Jobs: `http://localhost:3000/admin/jobs`

---

## ☁️ Deploy to Render.com (100% Free - $0/month)

1. Push this `auric-server` folder to a new private GitHub repository (e.g. `auric-whatsapp-server`).
2. Open [Render.com](https://render.com) ➔ Click **New +** ➔ **Web Service**.
3. Select your GitHub repository.
4. Settings:
   - **Environment:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
   - **Plan:** Free ($0)
5. Under **Environment Variables**, copy-paste the values from `.env`:
   - `WATI_API_ENDPOINT`
   - `WATI_ACCESS_TOKEN`
   - `TEMPLATE_ORDER_CONFIRMED`
   - `TEMPLATE_MILLING_STARTED`
   - `TEMPLATE_ORDER_SHIPPED`
   - `TEMPLATE_DELIVERY_FEEDBACK`
6. Click **Create Web Service**. You will get a live URL like:
   `https://auric-server.onrender.com`

---

## 🔗 Connect Shopify Webhooks

In **Shopify Admin** ➔ **Settings** ➔ **Notifications** ➔ Scroll down to **Webhooks**:

1. **Order Creation:**
   - Event: `Order creation`
   - Format: `JSON`
   - URL: `https://your-render-url.onrender.com/webhooks/shopify/orders-create`
2. **Order Fulfillment:**
   - Event: `Order fulfillment`
   - Format: `JSON`
   - URL: `https://your-render-url.onrender.com/webhooks/shopify/orders-fulfilled`
3. **Order Delivered:**
   - Event: `Order updated`
   - Format: `JSON`
   - URL: `https://your-render-url.onrender.com/webhooks/shopify/orders-delivered`

---

## ⏰ Keep Server Awake for Free

On [Cron-Job.org](https://cron-job.org) (100% Free):
- Set a cron job to call `https://your-render-url.onrender.com/cron/process` every 5-10 minutes.
- This ensures your free Render server never sleeps and triggers scheduled 2-day milling messages right on time!
