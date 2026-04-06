require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

const spacesRouter = require("./routes/spaces");
const bookingsRouter = require("./routes/bookings");
const parksRouter = require("./routes/parks");
const webhooksRouter = require("./routes/webhooks");

const app = express();

app.use(helmet());
app.set("trust proxy", 1);
app.use(cors());
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
  })
);

// Stripe webhooks need the raw body
app.use("/webhooks", express.raw({ type: "application/json" }));
app.use(express.json());

app.use("/spaces", spacesRouter);
app.use("/bookings", bookingsRouter);
app.use("/parks", parksRouter);
app.use("/webhooks", webhooksRouter);

app.get("/health", (_req, res) => res.json({ status: "ok" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`RollInHost API listening on port ${PORT}`);
});
