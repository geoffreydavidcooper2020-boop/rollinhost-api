const { Router } = require("express");
const Stripe = require("stripe");
const db = require("../db");

const router = Router();

const key = process.env.STRIPE_SECRET_KEY;
const stripe = key && key !== "placeholder" ? new Stripe(key) : null;

// POST /bookings
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

  // Walk-in bookings may use "cash" rate type — map to nightly for DB
  const normalizedRateType = rate_type === "cash" ? "nightly" : rate_type;
  if (!["nightly", "weekly", "monthly"].includes(normalizedRateType)) {
    return res.status(400).json({ error: "rate_type must be nightly, weekly, monthly, or cash" });
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    // Look up park
    const { rows: parkRows } = await client.query(
      "SELECT id, rate_nightly, rate_weekly, rate_monthly FROM parks WHERE slug = $1",
      [park_slug]
    );
    if (!parkRows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Park not found" });
    }
    const park = parkRows[0];

    // Look up space
    const { rows: spaceRows } = await client.query(
      "SELECT * FROM spaces WHERE park_id = $1 AND number = $2",
      [park.id, parseInt(space_number, 10)]
    );
    if (!spaceRows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Space not found" });
    }
    const space = spaceRows[0];

    // Check availability with row lock
    const { rows: conflicts } = await client.query(
      `SELECT id FROM bookings
       WHERE space_id = $1
         AND status IN ('confirmed', 'pending', 'checked_in')
         AND check_in < $3
         AND check_out > $2
       FOR UPDATE`,
      [space.id, check_in, check_out]
    );
    if (conflicts.length > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Space not available for selected dates" });
    }

    // Check blacklist
    try {
      const { rows: blacklisted } = await client.query(
        `SELECT id FROM blacklist WHERE park_id = $1 AND email = $2`,
        [park.id, (guest_email || "").toLowerCase()]
      );
      if (blacklisted.length > 0) {
        await client.query("ROLLBACK");
        return res.status(403).json({ error: "Unable to process booking. Please contact the park directly." });
      }
    } catch(e) { /* blacklist table may not exist yet — fail open */ }

    // Calculate nights and price
    const nights = Math.ceil(
      (new Date(check_out) - new Date(check_in)) / (1000 * 60 * 60 * 24)
    );
    if (nights <= 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "check_out must be after check_in" });
    }

    // Rate calculation
    let nightlyRate, total;
    if (normalizedRateType === "weekly") {
      nightlyRate = Number(park.rate_weekly) || Number(park.rate_nightly) * 7;
      total = Math.ceil(nights / 7) * nightlyRate;
    } else if (normalizedRateType === "monthly") {
      nightlyRate = Number(park.rate_monthly) || Number(park.rate_nightly) * 30;
      total = Math.ceil(nights / 30) * nightlyRate;
    } else {
      nightlyRate = Number(park.rate_nightly);
      total = nightlyRate * nights;
    }

    // Walk-in / cash bookings skip Stripe
    const isWalkIn = booking_source === "walk_in" || rate_type === "cash";

    if (!isWalkIn) {
      // Online booking — require Stripe
      if (!stripe) {
        await client.query("ROLLBACK");
        return res.status(503).json({ error: "Payment processing not configured" });
      }

      const paymentIntent = await stripe.paymentIntents.create({
        amount: Math.round(total * 100),
        currency: "usd",
        metadata: {
          park_slug,
          space_number: String(space_number),
          check_in,
          check_out,
          rate_type: normalizedRateType,
        },
      });

      // Cancellation deadline: 72 hours from now
      const cancellationDeadline = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();

      // Insert booking as PENDING — webhook confirms after payment
      const { rows: bookingRows } = await client.query(
        `INSERT INTO bookings (
           park_id, space_id,
           guest_first_name, guest_last_name, guest_email, guest_phone,
           check_in, check_out, rate_type, rate_amount, nights,
           subtotal, total_charged, booking_source, space_number, status,
           cancellation_deadline
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'pending',$16)
         RETURNING id`,
        [
          park.id, space.id,
          guest_first_name, guest_last_name, guest_email, guest_phone || null,
          check_in, check_out, normalizedRateType, nightlyRate, nights,
          total, total,
          booking_source || "online", parseInt(space_number, 10),
          cancellationDeadline
        ]
      );

      await client.query(
        `INSERT INTO payments (booking_id, park_id, stripe_payment_intent_id, amount, status)
         VALUES ($1, $2, $3, $4, 'pending')`,
        [bookingRows[0].id, park.id, paymentIntent.id, total]
      );

      await client.query("COMMIT");

      return res.status(201).json({
        booking_id: bookingRows[0].id,
        client_secret: paymentIntent.client_secret,
      });

    } else {
      // Walk-in / cash booking — no Stripe, insert as confirmed immediately
      // Cancellation deadline: 72 hours from now
      const cancellationDeadline = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();

      const { rows: bookingRows } = await client.query(
        `INSERT INTO bookings (
           park_id, space_id,
           guest_first_name, guest_last_name, guest_email, guest_phone,
           check_in, check_out, rate_type, rate_amount, nights,
           subtotal, total_charged, booking_source, space_number, status,
           cancellation_deadline
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'confirmed',$16)
         RETURNING id`,
        [
          park.id, space.id,
          guest_first_name, guest_last_name, guest_email, guest_phone || null,
          check_in, check_out, normalizedRateType, nightlyRate, nights,
          total, total,
          "walk_in", parseInt(space_number, 10),
          cancellationDeadline
        ]
      );

      await client.query("COMMIT");

      return res.status(201).json({
        booking_id: bookingRows[0].id,
        confirmed: true,
      });
    }

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Error creating booking:", err);
    res.status(500).json({ error: "Failed to create booking" });
  } finally {
    client.release();
  }
});

// GET /bookings?park=mustang-corner
router.get("/", async (req, res) => {
  const { park } = req.query;
  if (!park) return res.status(400).json({ error: "park (slug) is required" });
  try {
    const { rows } = await db.query(
      `SELECT b.* FROM bookings b
       JOIN parks p ON p.id = b.park_id
       WHERE p.slug = $1
       ORDER BY b.created_at DESC`,
      [park]
    );
    res.json(rows);
  } catch (err) {
    console.error("Error listing bookings:", err);
    res.status(500).json({ error: "Failed to list bookings" });
  }
});

// POST /bookings/:id/cancel
// Within 72 hours of booking: full Stripe refund + cancel
// After 72 hours: cancel reservation only, no refund (spot was held)
// Dashboard override: owner can always cancel (no refund check)
router.post("/:id/cancel", async (req, res) => {
  const { override } = req.body; // owner dashboard passes override: true
  try {
    const { rows } = await db.query(
      `SELECT b.*, p.stripe_payment_intent_id
       FROM bookings b
       LEFT JOIN payments p ON p.booking_id = b.id
       WHERE b.id = $1 AND b.status IN ('pending', 'confirmed')`,
      [req.params.id]
    );
    if (!rows.length) {
      return res.status(404).json({ error: "Booking not found or already cancelled" });
    }
    const booking = rows[0];

    // Determine if within cancellation window
    const deadline = booking.cancellation_deadline ? new Date(booking.cancellation_deadline) : null;
    const withinWindow = deadline ? new Date() < deadline : false;
    const shouldRefund = withinWindow && !override;

    // Cancel in DB
    await db.query(
      `UPDATE bookings SET status = 'cancelled', updated_at = NOW() WHERE id = $1`,
      [req.params.id]
    );

    // Attempt Stripe refund if within window
    let refunded = false;
    if (shouldRefund && stripe && booking.stripe_payment_intent_id) {
      try {
        await stripe.refunds.create({
          payment_intent: booking.stripe_payment_intent_id,
        });
        refunded = true;
        console.log(`Refund issued for booking ${req.params.id}`);
      } catch (refundErr) {
        console.error("Stripe refund failed:", refundErr.message);
      }
    }

    res.json({
      cancelled: true,
      refunded,
      within_window: withinWindow,
      message: refunded
        ? "Booking cancelled and full refund issued."
        : withinWindow
          ? "Booking cancelled. Refund could not be processed — contact support."
          : "Booking cancelled. Cancellation window has passed — no refund issued."
    });

  } catch (err) {
    console.error("Error cancelling booking:", err);
    res.status(500).json({ error: "Failed to cancel booking" });
  }
});

// POST /bookings/:id/checkin  (kept for manual override from dashboard)
router.post("/:id/checkin", async (req, res) => {
  try {
    const { rows } = await db.query(
      `UPDATE bookings SET status = 'checked_in', updated_at = NOW()
       WHERE id = $1 AND status = 'confirmed'
       RETURNING *`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "Booking not found or not confirmed" });
    res.json(rows[0]);
  } catch (err) {
    console.error("Error checking in:", err);
    res.status(500).json({ error: "Failed to check in" });
  }
});

// POST /bookings/:id/checkout  (kept for manual override from dashboard)
router.post("/:id/checkout", async (req, res) => {
  try {
    const { rows } = await db.query(
      `UPDATE bookings SET status = 'checked_out', updated_at = NOW()
       WHERE id = $1 AND status = 'checked_in'
       RETURNING *`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "Booking not found or not checked in" });
    const booking = rows[0];
    res.json(booking);

    // Send review request email
    if (booking.guest_email && process.env.RESEND_API_KEY) {
      try {
        const { rows: spaceRows } = await db.query(
          `SELECT p.name AS park_name FROM spaces s JOIN parks p ON p.id = s.park_id WHERE s.id = $1`,
          [booking.space_id]
        );
        if (spaceRows.length) {
          const { park_name } = spaceRows[0];
          const { Resend } = require("resend");
          const resend = new Resend(process.env.RESEND_API_KEY);
          await resend.emails.send({
            from: process.env.RESEND_FROM_EMAIL || "reservations@rollinhost.com",
            to: booking.guest_email,
            subject: `How was your stay at ${park_name}?`,
            html: `
              <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px">
                <h2 style="color:#1a0d04">Thanks for staying with us, ${booking.guest_first_name || "there"}!</h2>
                <p>We hope you had a wonderful stay at <strong>${park_name}</strong>.</p>
                <p style="margin-top:12px">If you enjoyed your visit, we'd love it if you left us a quick review. It only takes a minute and means the world to a small, independent park like ours.</p>
                <div style="text-align:center;margin:24px 0">
                  <a href="https://www.google.com/search?q=${encodeURIComponent(park_name)}+rv+park+reviews"
                     style="background:#6b3a1f;color:#f5eed8;padding:14px 28px;border-radius:6px;text-decoration:none;font-weight:700;display:inline-block;font-size:15px">
                    ⭐ Leave a Google Review
                  </a>
                </div>
                <p style="color:#aaa;font-size:11px;margin-top:24px">Powered by Roll In Host LLC · rollinhost.com</p>
              </div>
            `
          });
        }
      } catch (emailErr) {
        console.error("Review email failed:", emailErr.message);
      }
    }
  } catch (err) {
    console.error("Error checking out:", err);
    res.status(500).json({ error: "Failed to check out" });
  }
});

// GET /bookings/:id
router.get("/:id", async (req, res) => {
  try {
    const { rows } = await db.query("SELECT * FROM bookings WHERE id = $1", [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: "Booking not found" });
    res.json(rows[0]);
  } catch (err) {
    console.error("Error fetching booking:", err);
    res.status(500).json({ error: "Failed to fetch booking" });
  }
});

module.exports = router;
