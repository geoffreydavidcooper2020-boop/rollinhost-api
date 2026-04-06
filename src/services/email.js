const { Resend } = require("resend");

const resend = new Resend(process.env.RESEND_API_KEY);

async function sendConfirmationEmail({ guestEmail, guestName, spaceName, parkName, checkIn, checkOut, total }) {
  await resend.emails.send({
    from: process.env.RESEND_FROM_EMAIL,
    to: guestEmail,
    subject: `Booking Confirmed - ${parkName}`,
    html: `
      <h2>You're all set, ${guestName}!</h2>
      <p>Your booking at <strong>${parkName}</strong> has been confirmed.</p>
      <table>
        <tr><td><strong>Space:</strong></td><td>${spaceName}</td></tr>
        <tr><td><strong>Check-in:</strong></td><td>${checkIn}</td></tr>
        <tr><td><strong>Check-out:</strong></td><td>${checkOut}</td></tr>
        <tr><td><strong>Total:</strong></td><td>$${(total / 100).toFixed(2)}</td></tr>
      </table>
      <p>See you soon!</p>
    `,
  });
}

module.exports = { sendConfirmationEmail };
