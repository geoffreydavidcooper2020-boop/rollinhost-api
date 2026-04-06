const { Router } = require("express");
const Stripe = require("stripe");
const db = require("../db");
const { sendOwnerAlert } = require("../services/sms");
const { sendConfirmationEmail } = require("../services/email");

const router = Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// POST /webhooks/stripe
router.post("/stripe", async (req, res) => {
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
      // Confirm the booking
      const { rows } = await db.query(
        `UPDATE bookings SET status = 'confirmed', updated_at = NOW()
         WHERE stripe_payment_intent_id = $1 AND status = 'pending'
         RETURNING *`,
        [paymentIntent.id]
      );

      if (rows.length === 0) {
        console.warn("No pending booking found for payment intent:", paymentIntent.id);
        return res.json({ received: true });
      }

      const booking = rows[0];

      // Fetch space and park details for notifications
      const { rows: details } = await db.query(
        `SELECT s.name AS space_name, p.name AS park_name, p.owner_phone
         FROM spaces s
         JOIN parks p ON p.id = s.park_id
         WHERE s.id = $1`,
        [booking.space_id]
      );

      const { space_name, park_name, owner_phone } = details[0];

      // Fire notifications in parallel
      await Promise.allSettled([
        sendOwnerAlert({
          ownerPhone: owner_phone,
          guestName: booking.guest_name,
          spaceName: space_name,
          checkIn: booking.check_in,
          checkOut: booking.check_out,
          total: booking.total,
        }),
        sendConfirmationEmail({
          guestEmail: booking.guest_email,
          guestName: booking.guest_name,
          spaceName: space_name,
          parkName: park_name,
          checkIn: booking.check_in,
          checkOut: booking.check_out,
          total: booking.total,
        }),
      ]);
    } catch (err) {
      console.error("Error processing payment webhook:", err);
    }
  }

  res.json({ received: true });
});

module.exports = router;
