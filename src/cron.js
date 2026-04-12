// ─── RollinHost Nightly Cron Jobs ─────────────────────────────────────────
// No external packages needed — uses built-in setInterval
// Started automatically from src/index.js
//
// Three jobs run every night at midnight Arizona time (MST = UTC-7):
//   1. Auto check-in  — confirmed bookings where check_in = today
//   2. Auto check-out — checked_in bookings where check_out = today → fires review email
//   3. Pre-arrival    — confirmed bookings where check_in = tomorrow → sends arrival email

const db     = require('./db');
const Resend = require('resend').Resend;

const resend      = new Resend(process.env.RESEND_API_KEY);
const FROM_EMAIL  = process.env.RESEND_FROM_EMAIL || 'reservations@rollinhost.com';

// ── Helpers ────────────────────────────────────────────────────────────────

// Get today's date in Arizona time as YYYY-MM-DD string
function arizonaDateStr(offsetDays = 0) {
  const now = new Date();
  // Arizona is UTC-7 (no DST)
  const az = new Date(now.getTime() - (7 * 60 * 60 * 1000));
  az.setUTCDate(az.getUTCDate() + offsetDays);
  return az.toISOString().slice(0, 10);
}

// How many ms until next midnight Arizona time
function msUntilMidnightAZ() {
  const now = new Date();
  const az = new Date(now.getTime() - (7 * 60 * 60 * 1000));
  const nextMidnight = new Date(az);
  nextMidnight.setUTCHours(24, 0, 0, 0); // next UTC midnight = AZ midnight
  return nextMidnight.getTime() - now.getTime() + (7 * 60 * 60 * 1000);
}

// ── Job 1: Auto Check-In ───────────────────────────────────────────────────
async function runAutoCheckIn() {
  const today = arizonaDateStr();
  console.log(`[CRON] Auto check-in running for ${today}`);
  try {
    const { rows } = await db.query(
      `UPDATE bookings
       SET status = 'checked_in'
       WHERE status = 'confirmed'
         AND check_in = $1
       RETURNING id, guest_first_name, guest_last_name, check_in`,
      [today]
    );
    if (rows.length > 0) {
      console.log(`[CRON] Auto checked-in ${rows.length} booking(s):`,
        rows.map(r => `${r.guest_first_name} ${r.guest_last_name} (${r.id})`).join(', ')
      );
    } else {
      console.log(`[CRON] No bookings to check in today`);
    }
  } catch (err) {
    console.error('[CRON] Auto check-in error:', err.message);
  }
}

// ── Job 2: Auto Check-Out + Review Email ──────────────────────────────────
async function runAutoCheckOut() {
  const today = arizonaDateStr();
  console.log(`[CRON] Auto check-out running for ${today}`);
  try {
    const { rows } = await db.query(
      `UPDATE bookings
       SET status = 'checked_out'
       WHERE status = 'checked_in'
         AND check_out = $1
       RETURNING id, guest_first_name, guest_last_name, guest_email,
                 check_in, check_out, space_id`,
      [today]
    );

    if (!rows.length) {
      console.log(`[CRON] No bookings to check out today`);
      return;
    }

    console.log(`[CRON] Auto checked-out ${rows.length} booking(s)`);

    // Fire review request email for each checkout
    for (const booking of rows) {
      if (!booking.guest_email || booking.guest_email.includes('@mustang-corner.local')) continue;

      // Get park name for this booking
      const { rows: spaceRows } = await db.query(
        `SELECT p.name, p.slug FROM spaces s JOIN parks p ON p.id = s.park_id WHERE s.id = $1`,
        [booking.space_id]
      );
      const parkName = spaceRows[0]?.name || 'Mustang Corner RV Park';

      try {
        await resend.emails.send({
          from: FROM_EMAIL,
          to: booking.guest_email,
          subject: `Thanks for staying at ${parkName} — leave us a review?`,
          html: `
            <div style="font-family:sans-serif;max-width:560px;margin:0 auto;color:#333">
              <h2 style="color:#2c1810">Thanks for your stay, ${booking.guest_first_name}!</h2>
              <p>We hope you enjoyed your time at <strong>${parkName}</strong>. It was a pleasure having you.</p>
              <p>If you have a moment, we'd really appreciate a quick Google review — it helps other travelers find us and helps us keep improving.</p>
              <div style="text-align:center;margin:28px 0">
                <a href="https://www.google.com/search?q=${encodeURIComponent(parkName)}+review"
                   style="background:#2c1810;color:#fff;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:600;font-size:15px">
                  Leave a Review ⭐
                </a>
              </div>
              <p style="color:#888;font-size:13px">Questions or feedback? Call us at 928-951-2067 or reply to this email.</p>
              <p style="color:#aaa;font-size:11px;margin-top:24px">Powered by Roll In Host LLC · rollinhost.com</p>
            </div>
          `
        });
        console.log(`[CRON] Review email sent to ${booking.guest_email}`);
      } catch (emailErr) {
        console.error(`[CRON] Review email failed for ${booking.guest_email}:`, emailErr.message);
      }
    }
  } catch (err) {
    console.error('[CRON] Auto check-out error:', err.message);
  }
}

// ── Job 3: Pre-Arrival Email ───────────────────────────────────────────────
async function runPreArrivalEmails() {
  const tomorrow = arizonaDateStr(1);
  console.log(`[CRON] Pre-arrival emails running for check-ins on ${tomorrow}`);
  try {
    const { rows } = await db.query(
      `SELECT b.id, b.guest_first_name, b.guest_last_name, b.guest_email,
              b.check_in, b.check_out, b.nights, b.rate_type,
              s.number AS space_number, s.amp,
              p.name AS park_name, p.slug
       FROM bookings b
       JOIN spaces s ON s.id = b.space_id
       JOIN parks p ON p.id = s.park_id
       WHERE b.status = 'confirmed'
         AND b.check_in = $1`,
      [tomorrow]
    );

    if (!rows.length) {
      console.log(`[CRON] No arrivals tomorrow`);
      return;
    }

    console.log(`[CRON] Sending pre-arrival emails to ${rows.length} guest(s)`);

    for (const booking of rows) {
      if (!booking.guest_email || booking.guest_email.includes('@mustang-corner.local')) continue;

      const checkInDate = new Date(booking.check_in + 'T12:00:00').toLocaleDateString('en-US', {
        weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
      });

      try {
        await resend.emails.send({
          from: FROM_EMAIL,
          to: booking.guest_email,
          subject: `Your stay at ${booking.park_name} starts tomorrow — arrival info inside`,
          html: `
            <div style="font-family:sans-serif;max-width:560px;margin:0 auto;color:#333">
              <h2 style="color:#2c1810">See you tomorrow, ${booking.guest_first_name}!</h2>
              <p>Your reservation at <strong>${booking.park_name}</strong> starts tomorrow. Here's everything you need to arrive smoothly.</p>

              <div style="background:#f5f0eb;border-radius:8px;padding:18px;margin:20px 0">
                <table style="width:100%;font-size:14px">
                  <tr>
                    <td style="color:#888;padding:5px 0;width:140px">Your Space</td>
                    <td style="font-weight:700;color:#2c1810">Space ${booking.space_number} (${booking.amp}A electric)</td>
                  </tr>
                  <tr>
                    <td style="color:#888;padding:5px 0">Check-in</td>
                    <td style="font-weight:700;color:#2c1810">${checkInDate} after 2:00 PM</td>
                  </tr>
                  <tr>
                    <td style="color:#888;padding:5px 0">Check-out</td>
                    <td style="font-weight:700;color:#2c1810">${new Date(booking.check_out + 'T12:00:00').toLocaleDateString('en-US', {weekday:'long',month:'long',day:'numeric'})} by 11:00 AM</td>
                  </tr>
                  <tr>
                    <td style="color:#888;padding:5px 0">Length of stay</td>
                    <td style="font-weight:700;color:#2c1810">${booking.nights} night${booking.nights !== 1 ? 's' : ''}</td>
                  </tr>
                </table>
              </div>

              <h3 style="color:#2c1810;margin-top:24px">Park Address</h3>
              <p>304 E. HWY 82, Huachuca City, AZ 85616</p>
              <p>
                <a href="https://maps.google.com/?q=304+E+HWY+82+Huachuca+City+AZ+85616"
                   style="color:#2E8BC0">Get directions →</a>
              </p>

              <h3 style="color:#2c1810;margin-top:24px">Arrival Instructions</h3>
              <p>Drive in and head directly to Space ${booking.space_number}. Your space will be ready for you. Full hookups — connect to water, sewer, and ${booking.amp}A electric at your site.</p>

              <h3 style="color:#2c1810;margin-top:24px">Questions?</h3>
              <p>Call or text Willie at <a href="tel:9289512067" style="color:#2E8BC0">928-951-2067</a> or reply to this email.</p>

              <p style="color:#aaa;font-size:11px;margin-top:32px;border-top:1px solid #eee;padding-top:16px">
                Mustang Corner RV Park · 304 E. HWY 82, Huachuca City, AZ 85616<br>
                Powered by Roll In Host LLC · rollinhost.com
              </p>
            </div>
          `
        });
        console.log(`[CRON] Pre-arrival email sent to ${booking.guest_email} for Space ${booking.space_number}`);
      } catch (emailErr) {
        console.error(`[CRON] Pre-arrival email failed for ${booking.guest_email}:`, emailErr.message);
      }
    }
  } catch (err) {
    console.error('[CRON] Pre-arrival email error:', err.message);
  }
}

// ── Scheduler ─────────────────────────────────────────────────────────────
// Runs all three jobs together at midnight Arizona time every night

function runAllJobs() {
  console.log('[CRON] Running nightly jobs...');
  runAutoCheckIn();
  runAutoCheckOut();
  runPreArrivalEmails();
}

function scheduleMidnightJob() {
  const ms = msUntilMidnightAZ();
  const hours = Math.floor(ms / 3600000);
  const mins  = Math.floor((ms % 3600000) / 60000);
  console.log(`[CRON] Nightly jobs scheduled — next run in ${hours}h ${mins}m (midnight Arizona time)`);

  setTimeout(function tick() {
    runAllJobs();
    // After first run, repeat every 24 hours exactly
    setInterval(runAllJobs, 24 * 60 * 60 * 1000);
  }, ms);
}

// Start the scheduler
scheduleMidnightJob();

module.exports = { runAutoCheckIn, runAutoCheckOut, runPreArrivalEmails };
