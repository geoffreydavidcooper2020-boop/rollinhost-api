const twilio = require("twilio");

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

async function sendOwnerAlert({ ownerPhone, guestName, spaceName, checkIn, checkOut, total }) {
  await client.messages.create({
    body: `New booking! ${guestName} booked ${spaceName} from ${checkIn} to ${checkOut}. Total: $${(total / 100).toFixed(2)}`,
    from: process.env.TWILIO_PHONE_NUMBER,
    to: ownerPhone,
  });
}

module.exports = { sendOwnerAlert };
