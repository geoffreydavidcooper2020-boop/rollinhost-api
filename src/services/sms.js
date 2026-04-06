const twilio = require("twilio");

const sid = process.env.TWILIO_ACCOUNT_SID;
const client =
  sid && sid !== "placeholder"
    ? twilio(sid, process.env.TWILIO_AUTH_TOKEN)
    : null;

async function sendOwnerAlert({ ownerPhone, guestName, spaceName, checkIn, checkOut, total }) {
  if (!client) {
    console.log("Twilio not configured — skipping SMS to", ownerPhone);
    return;
  }
  await client.messages.create({
    body: `New booking! ${guestName} booked ${spaceName} from ${checkIn} to ${checkOut}. Total: $${(total / 100).toFixed(2)}`,
    from: process.env.TWILIO_PHONE_NUMBER,
    to: ownerPhone,
  });
}

module.exports = { sendOwnerAlert };
