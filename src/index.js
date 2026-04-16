require("dotenv").config();
const express    = require("express");
const cors       = require("cors");
const helmet     = require("helmet");
const rateLimit  = require("express-rate-limit");
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
  "https://geoffreyc37.sg-host.com"
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
app.post("/scrape", async (req, res) => {
  const { url, prompt } = req.body;
  if (!url || !prompt) {
    return res.status(400).json({ error: "url and prompt are required" });
  }
  try {
    const fetch = (await import("node-fetch")).default;

    let siteContent = "";
    try {
      const siteRes = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; RollinHostBot/1.0)" },
        timeout: 10000
      });
      siteContent = await siteRes.text();
      siteContent = siteContent.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 8000);
    } catch (e) {
      siteContent = "Could not fetch site content: " + e.message;
    }

    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-opus-4-5",
        max_tokens: 2000,
        messages: [{
          role: "user",
          content: prompt + "\n\nSite content:\n" + siteContent
        }]
      })
    });

    const claudeData = await claudeRes.json();
    const text = claudeData.content && claudeData.content[0] && claudeData.content[0].text
      ? claudeData.content[0].text
      : "";

    res.json({ result: text });
  } catch (err) {
    console.error("Scrape proxy error:", err);
    res.status(500).json({ error: "Scrape failed: " + err.message });
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
  version: "1.1.0",
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
  console.log(`RollInHost API v1.1.0 listening on port ${PORT}`);
});
