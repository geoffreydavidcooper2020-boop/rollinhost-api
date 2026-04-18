require("dotenv").config();
const express    = require("express");
const cors       = require("cors");
const helmet     = require("helmet");
const rateLimit  = require("express-rate-limit");
const Stripe     = require("stripe");
const db         = require("./db");
const spacesRouter   = require("./routes/spaces");
const bookingsRouter = require("./routes/bookings");
const parksRouter    = require("./routes/parks");
const webhooksRouter = require("./routes/webhooks");
const authRouter     = require("./routes/auth");
const reportsRouter  = require("./routes/reports");
require("./cron");

const app = express();
app.use(helmet());
app.set("trust proxy", 1);

const key = process.env.STRIPE_SECRET_KEY;
const stripe = key && key !== "placeholder" ? new Stripe(key) : null;

const ALLOWED_ORIGINS = [
  "http://geoffreyc35.sg-host.com",
  "https://geoffreyc35.sg-host.com",
  "http://rollinhost.com",
  "https://rollinhost.com",
  "http://www.rollinhost.com",
  "https://www.rollinhost.com",
  "http://mustangcorner.com",
  "https://mustangcorner.com",
  "http://geoffreyc37.sg-host.com",
  "https://geoffreyc37.sg-host.com",
  "http://geoffreyc38.sg-host.com",
  "https://geoffreyc38.sg-host.com"
];

app.use(cors({
  origin: function(origin, callback) {
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    callback(new Error("Not allowed by CORS"));
  }
}));

app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
    message: { error: "Too many requests, please try again later" }
  })
);

// Stripe webhooks need raw body — must be before express.json()
app.use("/webhooks", express.raw({ type: "application/json" }));
app.use(express.json());

// ── SCRAPE PROXY ──────────────────────────────────────────────────────────────
// Fetches the target site's HTML directly, then sends it to Claude with the
// web_search tool enabled so Claude can also research the park online (nearby
// attractions, reviews, etc.). Returns both `result` (legacy plain text) and
// `content` (full Anthropic response blocks) so ops.html v2 can read either.
app.post("/scrape", async (req, res) => {
  const { url, prompt } = req.body;
  if (!url || !prompt) {
    return res.status(400).json({ error: "url and prompt are required" });
  }
  try {
    const fetch = (await import("node-fetch")).default;

    // Fetch the park's site HTML directly
    let siteContent = "";
    try {
      const siteRes = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; RollinHostBot/1.0)" },
        timeout: 10000
      });
      siteContent = await siteRes.text();
      siteContent = siteContent
        .replace(/<script[\s\S]*?<\/script>/gi, " ") // drop scripts first
        .replace(/<style[\s\S]*?<\/style>/gi, " ")   // drop style blocks
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 15000);
    } catch (e) {
      siteContent = "Could not fetch site content: " + e.message;
    }

    // Call Anthropic with web_search tool enabled
    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5-20250929",
        max_tokens: 8000,
        tools: [{
          type: "web_search_20250305",
          name: "web_search",
          max_uses: 6
        }],
        messages: [{
          role: "user",
          content: prompt + "\n\n=== RAW SITE CONTENT (already fetched for you) ===\n" + siteContent
        }]
      })
    });

    const claudeData = await claudeRes.json();

    // Claude may return multiple block types: text, server_tool_use, web_search_tool_result.
    // Pull just the text blocks for the legacy `result` field.
    const textBlocks = (claudeData.content || [])
      .filter(b => b.type === "text" && b.text)
      .map(b => b.text);
    const text = textBlocks.join("\n\n");

    // Return both shapes — legacy callers get `result`, new ops.html reads `content`
    res.json({
      result: text,
      content: claudeData.content || []
    });
  } catch (err) {
    console.error("Scrape proxy error:", err);
    res.status(500).json({ error: "Scrape failed: " + err.message });
  }
});

// ── STRIPE CONNECT — Onboarding ───────────────────────────────────────────────
// GET /connect/onboard/:park_slug
// Generates a Stripe Connect onboarding link for a park owner
// Send this link to the park owner — they complete Stripe's onboarding in minutes
app.get("/connect/onboard/:park_slug", async (req, res) => {
  if (!stripe) return res.status(503).json({ error: "Stripe not configured" });

  try {
    const { rows } = await db.query(
      "SELECT id, name, stripe_account_id FROM parks WHERE slug = $1",
      [req.params.park_slug]
    );
    if (!rows.length) return res.status(404).json({ error: "Park not found" });
    const park = rows[0];

    let accountId = park.stripe_account_id;

    // Create a new Connect account if park doesn't have one yet
    if (!accountId) {
      const account = await stripe.accounts.create({
        type: "express",
        metadata: { park_slug: req.params.park_slug, park_name: park.name }
      });
      accountId = account.id;

      // Save the account ID to the park
      await db.query(
        "UPDATE parks SET stripe_account_id = $1 WHERE id = $2",
        [accountId, park.id]
      );
      console.log(`Created Stripe Connect account ${accountId} for park ${park.name}`);
    }

    // Generate onboarding link
    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: `https://rollinhost.com/connect/refresh/${req.params.park_slug}`,
      return_url: `https://rollinhost.com/connect/success/${req.params.park_slug}`,
      type: "account_onboarding",
    });

    res.json({
      onboarding_url: accountLink.url,
      account_id: accountId,
      park: park.name,
      message: `Send this URL to ${park.name} — they complete Stripe onboarding in ~2 minutes`
    });

  } catch (err) {
    console.error("Connect onboarding error:", err);
    res.status(500).json({ error: err.message });
  }
});

// GET /connect/status/:park_slug — check if park has Connect set up
app.get("/connect/status/:park_slug", async (req, res) => {
  try {
    const { rows } = await db.query(
      "SELECT name, stripe_account_id FROM parks WHERE slug = $1",
      [req.params.park_slug]
    );
    if (!rows.length) return res.status(404).json({ error: "Park not found" });
    const park = rows[0];

    if (!park.stripe_account_id) {
      return res.json({ connected: false, park: park.name, message: "No Stripe account connected" });
    }

    // Check account status with Stripe
    if (stripe) {
      const account = await stripe.accounts.retrieve(park.stripe_account_id);
      return res.json({
        connected: true,
        park: park.name,
        account_id: park.stripe_account_id,
        charges_enabled: account.charges_enabled,
        payouts_enabled: account.payouts_enabled,
        details_submitted: account.details_submitted,
        ready: account.charges_enabled && account.payouts_enabled
      });
    }

    res.json({ connected: true, account_id: park.stripe_account_id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// ─────────────────────────────────────────────────────────────────────────────

// Routes
app.use("/spaces",   spacesRouter);
app.use("/bookings", bookingsRouter);
app.use("/parks",    parksRouter);
app.use("/webhooks", webhooksRouter);
app.use("/auth",     authRouter);
app.use("/reports",  reportsRouter);

// Health check
app.get("/health", (_req, res) => res.json({
  status: "ok",
  version: "1.2.0",
  timestamp: new Date().toISOString()
}));

// 404 handler
app.use((_req, res) => res.status(404).json({ error: "Not found" }));

// Error handler
app.use((err, _req, res, _next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`RollInHost API v1.2.0 listening on port ${PORT}`);
});
