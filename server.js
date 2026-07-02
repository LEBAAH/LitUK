/**
 * ═══════════════════════════════════════════════════════════════
 * Life in the UK 2026 — Payment Backend
 * Handles GoCardless Direct Debit flows and PayPal webhooks.
 *
 * DEPLOY OPTIONS (all free tier available):
 *   • Railway  → railway.app   (recommended, one-click deploy)
 *   • Render   → render.com
 *   • Vercel   → vercel.com (set type:"module" in package.json)
 *
 * SETUP:
 *   1. npm install express cors gocardless-nodejs dotenv
 *   2. Create a .env file with the keys below
 *   3. Deploy and paste the public URL into PAYMENT_CONFIG in the React app
 * ═══════════════════════════════════════════════════════════════
 */

const express    = require("express");
const cors       = require("cors");
const { Client, Environments, WebhookParser } = require("gocardless-nodejs");
require("dotenv").config();

// ─────────────────────────────────────────────────────────────
// .env — create this file in the same directory as server.js
// ─────────────────────────────────────────────────────────────
// GOCARDLESS_ACCESS_TOKEN=live_xxxxxxxxxxxx
// GOCARDLESS_WEBHOOK_SECRET=your_webhook_secret
// PAYPAL_WEBHOOK_ID=your_paypal_webhook_id
// PAYPAL_CLIENT_ID=your_paypal_client_id
// PAYPAL_CLIENT_SECRET=your_paypal_client_secret
// FRONTEND_URL=https://your-frontend-domain.com
// PORT=3001
//
// GoCardless tokens:  https://manage.gocardless.com/developers/access-tokens
// PayPal credentials: https://developer.paypal.com/dashboard/applications/live
// ─────────────────────────────────────────────────────────────

const app = express();

// Allow your frontend origin
app.use(cors({ origin: process.env.FRONTEND_URL || "*" }));

// Raw body needed for webhook signature verification — MUST come before express.json()
app.use("/api/webhooks/gocardless", express.raw({ type: "application/json" }));
app.use("/api/webhooks/paypal",     express.raw({ type: "application/json" }));
app.use(express.json());

// ─────────────────────────────────────────────────────────────
// GoCardless client
// ─────────────────────────────────────────────────────────────
const gc = new Client({
  access_token: process.env.GOCARDLESS_ACCESS_TOKEN,
  environment:  Environments.Live, // change to Environments.Sandbox while testing
});

// ─────────────────────────────────────────────────────────────
// PLAN → GoCardless subscription amount map
// Create matching subscription plans in your GoCardless dashboard:
//   https://manage.gocardless.com/subscriptions/plans
// Paste the plan IDs below.
// ─────────────────────────────────────────────────────────────
const GC_PLAN_IDS = {
  basic:    process.env.GC_PLAN_ID_BASIC    || "PLxxxxxxxxx",  // £4.99/mo
  standard: process.env.GC_PLAN_ID_STANDARD || "PLxxxxxxxxx",  // £9.99/mo
  premium:  process.env.GC_PLAN_ID_PREMIUM  || "PLxxxxxxxxx",  // £14.99/mo
};

// In-memory user store — replace with a real database (Supabase, Postgres, MongoDB)
// in production. This resets every time the server restarts.
const users = {};  // { email: { plan, mandateId, subscriptionId } }

// ─────────────────────────────────────────────────────────────
// Health check
// ─────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "ok", service: "Life in the UK 2026 Payment Backend" });
});

// ═══════════════════════════════════════════════════════════════
// GOCARDLESS ROUTES
// ═══════════════════════════════════════════════════════════════

/**
 * POST /api/gocardless/create-flow
 * Creates a GoCardless redirect flow so the user can authorise
 * their Direct Debit mandate. Returns the redirectUrl.
 *
 * Body: { planId, userEmail, userName }
 */
app.post("/api/gocardless/create-flow", async (req, res) => {
  const { planId, userEmail, userName } = req.body;

  if (!planId || !userEmail || !userName) {
    return res.status(400).json({ error: "planId, userEmail, and userName are required." });
  }
  if (!GC_PLAN_IDS[planId]) {
    return res.status(400).json({ error: `Unknown planId: ${planId}` });
  }

  try {
    const redirectFlow = await gc.redirectFlows.create({
      description: `Life in the UK 2026 — ${planId.charAt(0).toUpperCase() + planId.slice(1)} Plan`,
      session_token: `session_${Date.now()}_${userEmail}`,
      success_redirect_url: `${process.env.FRONTEND_URL}/payment-success?plan=${planId}&email=${encodeURIComponent(userEmail)}`,
      prefilled_customer: {
        email: userEmail,
        given_name: userName.split(" ")[0] || userName,
        family_name: userName.split(" ").slice(1).join(" ") || "",
      },
      scheme: "bacs", // UK Direct Debit
    });

    // Store the session token so we can verify it on completion
    users[userEmail] = { ...users[userEmail], pendingPlan: planId, sessionToken: redirectFlow.session_token };

    res.json({ redirectUrl: redirectFlow.redirect_url, flowId: redirectFlow.id });
  } catch (err) {
    console.error("GoCardless create-flow error:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/gocardless/complete-flow
 * Called by your frontend after the user returns from GoCardless
 * (at your success_redirect_url). Completes the redirect flow,
 * creates a subscription, and activates the plan.
 *
 * Body: { redirectFlowId, userEmail }
 */
app.post("/api/gocardless/complete-flow", async (req, res) => {
  const { redirectFlowId, userEmail } = req.body;
  const userRecord = users[userEmail] || {};

  if (!redirectFlowId || !userEmail) {
    return res.status(400).json({ error: "redirectFlowId and userEmail are required." });
  }

  try {
    // Complete the redirect flow to get the mandate
    const completedFlow = await gc.redirectFlows.complete(redirectFlowId, {
      session_token: userRecord.sessionToken,
    });

    const mandateId  = completedFlow.links.mandate;
    const customerId = completedFlow.links.customer;
    const planId     = userRecord.pendingPlan || "basic";
    const gcPlanId   = GC_PLAN_IDS[planId];

    // Create the subscription using the mandate
    const subscription = await gc.subscriptions.create({
      amount: planId === "basic" ? 499 : planId === "standard" ? 999 : 1499, // pence
      currency: "GBP",
      name: `Life in the UK 2026 — ${planId}`,
      interval_unit: "monthly",
      interval: 1,
      links: { mandate: mandateId, plan: gcPlanId },
    });

    // Activate the plan in your user store
    users[userEmail] = {
      ...userRecord,
      plan: planId,
      mandateId,
      customerId,
      subscriptionId: subscription.id,
      pendingPlan: null,
      sessionToken: null,
    };

    console.log(`✅ GoCardless subscription created for ${userEmail}: ${planId} (${subscription.id})`);
    res.json({ success: true, plan: planId, subscriptionId: subscription.id });
  } catch (err) {
    console.error("GoCardless complete-flow error:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/user/plan
 * Returns the current plan for a user (used by frontend after payment).
 *
 * Query: ?email=user@example.com
 */
app.get("/api/user/plan", (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: "email is required." });
  const user = users[email.toLowerCase()];
  res.json({ plan: user?.plan || "free" });
});

// ═══════════════════════════════════════════════════════════════
// GOCARDLESS WEBHOOK
// Receives real-time events from GoCardless (payment success,
// cancellation, mandate failure) and updates user plans.
// ═══════════════════════════════════════════════════════════════
app.post("/api/webhooks/gocardless", (req, res) => {
  const signature = req.headers["webhook-signature"];

  let events;
  try {
    events = WebhookParser.parse(req.body, process.env.GOCARDLESS_WEBHOOK_SECRET, signature);
  } catch (err) {
    console.warn("GoCardless webhook signature invalid:", err.message);
    return res.status(498).send("Invalid signature");
  }

  for (const event of events) {
    console.log(`GoCardless event: ${event.resource_type}.${event.action}`, event.links);
    const { resource_type, action, links } = event;

    if (resource_type === "payments" && action === "failed") {
      // Payment failed — optionally downgrade the user or send a notification
      const subId = links.subscription;
      const userEntry = Object.entries(users).find(([, u]) => u.subscriptionId === subId);
      if (userEntry) {
        console.warn(`Payment failed for ${userEntry[0]} — consider downgrading or notifying.`);
      }
    }

    if (resource_type === "mandates" && action === "cancelled") {
      const mandateId = links.mandate;
      const userEntry = Object.entries(users).find(([, u]) => u.mandateId === mandateId);
      if (userEntry) {
        users[userEntry[0]].plan = "free";
        console.log(`Mandate cancelled for ${userEntry[0]} — downgraded to Free.`);
      }
    }

    if (resource_type === "subscriptions" && action === "cancelled") {
      const subId = links.subscription;
      const userEntry = Object.entries(users).find(([, u]) => u.subscriptionId === subId);
      if (userEntry) {
        users[userEntry[0]].plan = "free";
        console.log(`Subscription cancelled for ${userEntry[0]} — downgraded to Free.`);
      }
    }
  }

  res.status(200).json({ acknowledged: true });
});

// ═══════════════════════════════════════════════════════════════
// PAYPAL WEBHOOK
// Verifies the signature and handles subscription events.
// Register this URL in your PayPal dashboard:
//   https://developer.paypal.com/dashboard/webhooks
// Events to subscribe to:
//   BILLING.SUBSCRIPTION.ACTIVATED
//   BILLING.SUBSCRIPTION.CANCELLED
//   BILLING.SUBSCRIPTION.SUSPENDED
//   PAYMENT.SALE.COMPLETED
// ═══════════════════════════════════════════════════════════════
app.post("/api/webhooks/paypal", async (req, res) => {
  const headers = req.headers;
  const body    = req.body.toString("utf8");
  const event   = JSON.parse(body);

  // Verify signature with PayPal API
  const verified = await verifyPayPalWebhook(headers, body);
  if (!verified) {
    console.warn("PayPal webhook signature invalid");
    return res.status(401).json({ error: "Invalid signature" });
  }

  console.log(`PayPal event: ${event.event_type}`, event.resource?.id);

  const resource = event.resource || {};

  if (event.event_type === "BILLING.SUBSCRIPTION.ACTIVATED") {
    const subId    = resource.id;
    const planId   = paypalPlanIdToLocalPlan(resource.plan_id);
    const email    = resource.subscriber?.email_address;
    if (email && planId) {
      users[email.toLowerCase()] = {
        ...users[email.toLowerCase()],
        plan: planId,
        paypalSubscriptionId: subId,
      };
      console.log(`✅ PayPal subscription activated for ${email}: ${planId}`);
    }
  }

  if (event.event_type === "BILLING.SUBSCRIPTION.CANCELLED" ||
      event.event_type === "BILLING.SUBSCRIPTION.SUSPENDED") {
    const subId = resource.id;
    const userEntry = Object.entries(users).find(([, u]) => u.paypalSubscriptionId === subId);
    if (userEntry) {
      users[userEntry[0]].plan = "free";
      console.log(`PayPal subscription ${event.event_type} for ${userEntry[0]} — downgraded to Free.`);
    }
  }

  res.status(200).json({ acknowledged: true });
});

// ─────────────────────────────────────────────────────────────
// Helper: verify PayPal webhook signature via PayPal API
// ─────────────────────────────────────────────────────────────
async function verifyPayPalWebhook(headers, rawBody) {
  try {
    const accessToken = await getPayPalAccessToken();
    const verifyRes = await fetch("https://api-m.paypal.com/v1/notifications/verify-webhook-signature", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        auth_algo:         headers["paypal-auth-algo"],
        cert_url:          headers["paypal-cert-url"],
        transmission_id:   headers["paypal-transmission-id"],
        transmission_sig:  headers["paypal-transmission-sig"],
        transmission_time: headers["paypal-transmission-time"],
        webhook_id:        process.env.PAYPAL_WEBHOOK_ID,
        webhook_event:     JSON.parse(rawBody),
      }),
    });
    const data = await verifyRes.json();
    return data.verification_status === "SUCCESS";
  } catch (e) {
    console.error("PayPal webhook verify error:", e);
    return false;
  }
}

async function getPayPalAccessToken() {
  const res = await fetch("https://api-m.paypal.com/v1/oauth2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Authorization": "Basic " + Buffer.from(
        `${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`
      ).toString("base64"),
    },
    body: "grant_type=client_credentials",
  });
  const data = await res.json();
  return data.access_token;
}

// ─────────────────────────────────────────────────────────────
// Helper: map PayPal Plan ID back to local plan name
// ─────────────────────────────────────────────────────────────
function paypalPlanIdToLocalPlan(paypalPlanId) {
  const map = {
    [process.env.PAYPAL_PLAN_ID_BASIC]:    "basic",
    [process.env.PAYPAL_PLAN_ID_STANDARD]: "standard",
    [process.env.PAYPAL_PLAN_ID_PREMIUM]:  "premium",
  };
  return map[paypalPlanId] || null;
}

// ─────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n🚀 Life in the UK 2026 backend running on port ${PORT}`);
  console.log(`   GoCardless: ${process.env.GOCARDLESS_ACCESS_TOKEN ? "✅ configured" : "⚠️  GOCARDLESS_ACCESS_TOKEN missing"}`);
  console.log(`   PayPal:     ${process.env.PAYPAL_CLIENT_ID ? "✅ configured" : "⚠️  PAYPAL_CLIENT_ID missing"}\n`);
});
