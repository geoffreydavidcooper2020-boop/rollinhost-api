let SignalHouseSDK;
try {
  ({ SignalHouseSDK } = require("@signalhousellc/sdk"));
} catch(e) {
  console.warn("Signal House SDK not available:", e.message);
}

const client = SignalHouseSDK && process.env.SIGNAL_HOUSE_API_KEY
  ? new SignalHouseSDK({
      apiKey: process.env.SIGNAL_HOUSE_API_KEY,
      baseUrl: "https://v2.signalhouse.io",
    })
  : null;

async function sendOwnerAlert({ ownerPhone, guestName, spaceName, checkIn, checkOut, total }) {
  if (!client) {
    console.log("Signal House not configured — skipping SMS to", ownerPhone);
    return;
  }
  try {
    await client.messages.sendSMS({
      senderPhoneNumber: process.env.SIGNAL_HOUSE_PHONE_NUMBER,
      recipientPhoneNumbers: [ownerPhone],
      messageBody: `New booking! ${guestName} booked ${spaceName} from ${checkIn} to ${checkOut}. Total: $${(total / 100).toFixed(2)}`,
    });
    console.log("SMS sent to", ownerPhone);
  } catch (err) {
    console.error("Signal House SMS error:", err.message);
  }
}

module.exports = { sendOwnerAlert };
