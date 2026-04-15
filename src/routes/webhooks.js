const { Router } = require("express");
const Stripe = require("stripe");
const db = require("../db");
const { sendOwnerAlert } = require("../services/sms");
const { sendConfirmationEmail } = require("../services/email");
const router = Router();
const key = process.env.STRIPE_SECRET_KEY;
const stripe = key && key !== "placeholder" ? new Stripe(key) : null;

// POST /webhooks/stripe
router.post("/stripe", async (req, res) => {
  if (!stripe) {
    console.log("Stripe not configured — skipping webhook");
    return res.status(503).json({ error: "Stripe not configured" });
  }
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers["stripe-signature"],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("Webhook signature verification failed:", err.message);
    return res.status(400).json({ error: "Invalid signature" });
  }

  if (event.type === "payment_intent.succeeded") {
    const paymentIntent = event.data.object;
    try {
      // Find booking via payments table
      const { rows: paymentRows } = await db.query(
        `SELECT booking_id FROM payments WHERE stripe_payment_intent_id = $1`,
        [paymentIntent.id]
      );
      if (!paymentRows.length) {
        console.warn("No payment found for payment_intent:", paymentIntent.id);
        return res.json({ received: true });
      }
      const bookingId = paymentRows[0].booking_id;

      // Confirm the booking
      const { rows } = await db.query(
        `UPDATE bookings SET status = 'confirmed', updated_at = NOW()
         WHERE id = $1 AND status = 'pending'
         RETURNING *`,
        [bookingId]
      );
      if (!rows.length) {
        console.warn("No pending booking found for id:", bookingId);
        return res.json({ received: true });
      }
      const booking = rows[0];

      // Update payment status
      await db.query(
        `UPDATE payments SET status = 'succeeded' WHERE stripe_payment_intent_id = $1`,
        [paymentIntent.id]
      );

      // Fetch space and park details
      const { rows: details } = await db.query(
        `SELECT s.number AS space_number, p.name AS park_name, p.phone
         FROM spaces s
         JOIN parks p ON p.id = s.park_id
         WHERE s.id = $1`,
        [booking.space_id]
      );
      if (!details.length) {
        console.warn("No space/park found for booking:", bookingId);
        return res.json({ received: true });
      }
      const { space_number, park_name, phone } = details[0];

      // Use space_display (e.g. "F13") if stored, fall back to raw number
      const spaceName = booking.space_display
        ? "Space " + booking.space_display
        : "Space #" + space_number;

      // Build guest name
      const guestFirst = booking.guest_first_name || "";
      const guestLast  = booking.guest_last_name  || "";
      const guestName  = (guestFirst + " " + guestLast).trim() || "Guest";
      const total      = booking.total_charged || booking.total || 0;

      // Fire notifications in parallel
      await Promise.allSettled([
        sendOwnerAlert({
          ownerPhone: phone,
          guestName,
          spaceName,
          checkIn: booking.check_in,
          checkOut: booking.check_out,
          total: Math.round(total * 100),
        }),
        sendConfirmationEmail({
          guestEmail: booking.guest_email,
          guestName,
          spaceName,
          parkName: park_name,
          checkIn: booking.check_in,
          checkOut: booking.check_out,
          total: Math.round(total * 100),
        }),
      ]);
      console.log(`Booking ${bookingId} confirmed — notifications sent`);
    } catch (err) {
      console.error("Error processing payment webhook:", err);
    }
  }
  res.json({ received: true });
});

module.exports = router;
