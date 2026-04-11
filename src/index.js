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
  // Add client park domains here as you onboard them:
  // "https://mustangcornerrvpark.com",
];

app.use(cors({
  origin: function(origin, callback) {
    // Allow requests with no origin (mobile apps, curl, etc.)
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
