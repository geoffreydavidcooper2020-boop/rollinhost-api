const { Router } = require("express");
const Stripe = require("stripe");
const db = require("../db");

const router = Router();

const key = process.env.STRIPE_SECRET_KEY;
const stripe = key && key !== "placeholder" ? new Stripe(key) : null;

// POST /bookings
// Creates a booking + Stripe payment intent
router.post("/", async (req, res) => {
  const { space_id, guest_name, guest_email, guest_phone, check_in, check_out } = req.body;

  if (!space_id || !guest_name || !guest_email || !check_in || !check_out) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    // Check availability with row lock
    const { rows: conflicts } = await client.query(
      `SELECT id FROM bookings
       WHERE space_id = $1
         AND status IN ('confirmed', 'pending')
         AND check_in < $3
         AND check_out > $2
       FOR UPDATE`,
      [space_id, check_in, check_out]
    );

    if (conflicts.length > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Space not available for selected dates" });
    }

    // Calculate price
    const { rows: spaceRows } = await client.query(
      `SELECT s.*, p.id AS park_id FROM spaces s
       JOIN parks p ON p.id = s.park_id
       WHERE s.id = $1`,
      [space_id]
    );

    if (spaceRows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Space not found" });
    }

    const space = spaceRows[0];
    const nights = Math.ceil(
      (new Date(check_out) - new Date(check_in)) / (1000 * 60 * 60 * 24)
    );

    if (nights <= 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "check_out must be after check_in" });
    }

    // Apply pricing rules (weekly/monthly discounts)
    const { rows: rules } = await client.query(
      `SELECT * FROM pricing_rules
       WHERE park_id = $1 AND min_nights <= $2
       ORDER BY min_nights DESC LIMIT 1`,
      [space.park_id, nights]
    );

    let nightlyRate = space.price_per_night;
    if (rules.length > 0) {
      nightlyRate = Math.round(nightlyRate * (1 - rules[0].discount_pct / 100));
    }

    const total = nightlyRate * nights;

    // Create Stripe payment intent
    if (!stripe) {
      await client.query("ROLLBACK");
      console.log("Stripe not configured — cannot create payment intent");
      return res.status(503).json({ error: "Payment processing not configured" });
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount: total,
      currency: "usd",
      metadata: { space_id, check_in, check_out },
    });

    // Insert booking
    const { rows: bookingRows } = await client.query(
      `INSERT INTO bookings
         (space_id, guest_name, guest_email, guest_phone, check_in, check_out, nights, nightly_rate, total, status, stripe_payment_intent_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', $10)
       RETURNING *`,
      [space_id, guest_name, guest_email, guest_phone, check_in, check_out, nights, nightlyRate, total, paymentIntent.id]
    );

    await client.query("COMMIT");

    res.status(201).json({
      booking: bookingRows[0],
      client_secret: paymentIntent.client_secret,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Error creating booking:", err);
    res.status(500).json({ error: "Failed to create booking" });
  } finally {
    client.release();
  }
});

// POST /bookings/:id/cancel
router.post("/:id/cancel", async (req, res) => {
  try {
    const { rows } = await db.query(
      `UPDATE bookings SET status = 'cancelled', updated_at = NOW()
       WHERE id = $1 AND status IN ('pending', 'confirmed')
       RETURNING *`,
      [req.params.id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: "Booking not found or already cancelled" });
    }

    // Refunds are handled manually by park owners through their Stripe dashboard
    // until Stripe Connect is implemented.

    res.json(rows[0]);
  } catch (err) {
    console.error("Error cancelling booking:", err);
    res.status(500).json({ error: "Failed to cancel booking" });
  }
});

// GET /bookings/:id
router.get("/:id", async (req, res) => {
  try {
    const { rows } = await db.query("SELECT * FROM bookings WHERE id = $1", [req.params.id]);

    if (rows.length === 0) {
      return res.status(404).json({ error: "Booking not found" });
    }

    res.json(rows[0]);
  } catch (err) {
    console.error("Error fetching booking:", err);
    res.status(500).json({ error: "Failed to fetch booking" });
  }
});

module.exports = router;
