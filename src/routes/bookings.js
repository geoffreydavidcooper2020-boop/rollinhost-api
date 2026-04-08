const { Router } = require("express");
const Stripe = require("stripe");
const db = require("../db");

const router = Router();

const key = process.env.STRIPE_SECRET_KEY;
const stripe = key && key !== "placeholder" ? new Stripe(key) : null;

// POST /bookings
// Creates a booking + Stripe payment intent
router.post("/", async (req, res) => {
  console.log("Received body:", JSON.stringify(req.body));
  const {
    park_slug, space_number,
    guest_first_name, guest_last_name, guest_email, guest_phone,
    check_in, check_out,
    rate_type, booking_source,
  } = req.body;

  if (!park_slug || !space_number || !check_in || !check_out ||
      !guest_first_name || !guest_last_name || !guest_email || !rate_type) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  if (!["nightly", "weekly", "monthly"].includes(rate_type)) {
    return res.status(400).json({ error: "rate_type must be nightly, weekly, or monthly" });
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    // Look up park by slug (include rate_nightly for pricing)
    const { rows: parkRows } = await client.query(
      "SELECT id, rate_nightly FROM parks WHERE slug = $1",
      [park_slug]
    );
    if (parkRows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Park not found" });
    }
    const park = parkRows[0];

    // Look up space by park + number
    const { rows: spaceRows } = await client.query(
      `SELECT * FROM spaces
       WHERE park_id = $1 AND number = $2`,
      [park.id, parseInt(space_number, 10)]
    );
    if (spaceRows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Space not found" });
    }
    const space = spaceRows[0];

    // Check availability with row lock
    const { rows: conflicts } = await client.query(
      `SELECT id FROM bookings
       WHERE space_id = $1
         AND status IN ('confirmed', 'pending')
         AND check_in < $3
         AND check_out > $2
       FOR UPDATE`,
      [space.id, check_in, check_out]
    );

    if (conflicts.length > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Space not available for selected dates" });
    }

    // Calculate nights and price
    const nights = Math.ceil(
      (new Date(check_out) - new Date(check_in)) / (1000 * 60 * 60 * 24)
    );

    if (nights <= 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "check_out must be after check_in" });
    }

    const nightlyRate = Number(park.rate_nightly);
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
      metadata: {
        park_slug,
        space_number: String(space_number),
        check_in,
        check_out,
        rate_type,
      },
    });

    // Insert booking
    const { rows: bookingRows } = await client.query(
      `INSERT INTO bookings
         (space_id, guest_first_name, guest_last_name, guest_email, guest_phone,
          check_in, check_out, nights, nightly_rate, total, status,
          stripe_payment_intent_id, rate_type, booking_source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', $11, $12, $13)
       RETURNING *`,
      [space.id, guest_first_name, guest_last_name, guest_email, guest_phone || null,
       check_in, check_out, nights, nightlyRate, total,
       paymentIntent.id, rate_type, booking_source || null]
    );

    await client.query("COMMIT");

    res.status(201).json({
      booking_id: bookingRows[0].id,
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
