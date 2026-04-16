const db     = require('./db');
const Resend = require('resend').Resend;

const resend        = new Resend(process.env.RESEND_API_KEY);
const FROM_EMAIL    = process.env.RESEND_FROM_EMAIL || 'reservations@rollinhost.com';
const SUPPORT_EMAIL = 'host@rollinhost.com';
const SUPPORT_PHONE = '626-ROLLIN1 (626-765-5461)';

// ── Helpers ────────────────────────────────────────────────────────────────

function arizonaDateStr(offsetDays = 0) {
  const now = new Date();
  const az = new Date(now.getTime() - (7 * 60 * 60 * 1000));
  az.setUTCDate(az.getUTCDate() + offsetDays);
  return az.toISOString().slice(0, 10);
}

function msUntilMidnightAZ() {
  const now = new Date();
  const az = new Date(now.getTime() - (7 * 60 * 60 * 1000));
  const nextMidnight = new Date(az);
  nextMidnight.setUTCHours(24, 0, 0, 0);
  return nextMidnight.getTime() - now.getTime() + (7 * 60 * 60 * 1000);
}

function addDaysToDate(dateStr, days) {
  const d = new Date(dateStr + 'T12:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

// ── Job 1: Auto Check-In ───────────────────────────────────────────────────
async function runAutoCheckIn() {
  const today = arizonaDateStr();
  console.log("[CRON] Auto check-in running for " + today);
  try {
    const { rows } = await db.query(
      "UPDATE bookings SET status = 'checked_in', updated_at = NOW() WHERE status = 'confirmed' AND check_in = $1 RETURNING id, guest_first_name, guest_last_name",
      [today]
    );
    if (rows.length > 0) {
      console.log("[CRON] Auto checked-in " + rows.length + " booking(s)");
    } else {
      console.log("[CRON] No bookings to check in today");
    }
  } catch (err) {
    console.error("[CRON] Auto check-in error:", err.message);
  }
}

// ── Job 2: Auto Check-Out + Review Email ──────────────────────────────────
async function runAutoCheckOut() {
  const today = arizonaDateStr();
  console.log("[CRON] Auto check-out running for " + today);
  try {
    const { rows } = await db.query(
      "UPDATE bookings SET status = 'checked_out', updated_at = NOW() WHERE status = 'checked_in' AND check_out = $1 RETURNING id, guest_first_name, guest_last_name, guest_email, check_in, check_out, space_id",
      [today]
    );

    if (!rows.length) {
      console.log("[CRON] No bookings to check out today");
      return;
    }

    console.log("[CRON] Auto checked-out " + rows.length + " booking(s)");

    for (const booking of rows) {
      if (!booking.guest_email || booking.guest_email.includes(".local")) continue;
      const { rows: sr } = await db.query(
        "SELECT p.name FROM spaces s JOIN parks p ON p.id = s.park_id WHERE s.id = $1",
        [booking.space_id]
      );
      const parkName = sr[0] ? sr[0].name : "the park";

      // Delay review email by 1 hour
      setTimeout(async function() {
        try {
          await resend.emails.send({
            from: FROM_EMAIL,
            to: booking.guest_email,
            subject: "Thanks for staying at " + parkName + " — leave us a review?",
            html: "<div style=\"font-family:sans-serif;max-width:560px;margin:0 auto\"><div style=\"background:#2c1810;padding:20px 24px;border-radius:8px 8px 0 0\"><div style=\"font-size:20px;font-weight:700;color:#e8d5b0\">Roll In Host</div><div style=\"font-size:12px;color:rgba(232,213,176,0.6);margin-top:2px\">" + parkName + "</div></div><div style=\"background:#fff;padding:28px 24px;border:1px solid #e0d8cc;border-top:none;border-radius:0 0 8px 8px\"><h2 style=\"color:#2c1810\">Thanks for your stay, " + booking.guest_first_name + "!</h2><p style=\"color:#555;line-height:1.7;margin-top:12px\">We hope you had a great time at <strong>" + parkName + "</strong>. If you enjoyed your visit, a quick Google review means the world to us.</p><div style=\"text-align:center;margin:28px 0\"><a href=\"https://www.google.com/search?q=" + encodeURIComponent(parkName + " RV Park") + "+reviews\" style=\"background:#2c1810;color:#e8d5b0;padding:13px 30px;border-radius:6px;text-decoration:none;font-weight:700;font-size:15px;display:inline-block\">&#11088; Leave a Google Review</a></div><p style=\"color:#aaa;font-size:11px;margin-top:24px;border-top:1px solid #f0ebe4;padding-top:16px\">" + parkName + " &middot; Powered by Roll In Host LLC &middot; rollinhost.com</p></div></div>"
          });
          console.log("[CRON] Review email sent to " + booking.guest_email);
        } catch (e) {
          console.error("[CRON] Review email failed:", e.message);
        }
      }, 60 * 60 * 1000); // 1 hour delay
    }
  } catch (err) {
    console.error("[CRON] Auto check-out error:", err.message);
  }
}

// ── Job 3: Pre-Arrival Email ───────────────────────────────────────────────
async function runPreArrivalEmails() {
  const tomorrow = arizonaDateStr(1);
  console.log("[CRON] Pre-arrival emails for check-ins on " + tomorrow);
  try {
    // Pull park address and phone from DB so it works for any park
    const { rows } = await db.query(
      `SELECT b.id, b.guest_first_name, b.guest_last_name, b.guest_email,
              b.check_in, b.check_out, b.nights, b.space_display,
              s.number AS space_number, s.amp,
              p.name AS park_name, p.address AS park_address, p.phone AS park_phone
       FROM bookings b
       JOIN spaces s ON s.id = b.space_id
       JOIN parks p ON p.id = s.park_id
       WHERE b.status = 'confirmed' AND b.check_in = $1`,
      [tomorrow]
    );

    if (!rows.length) { console.log("[CRON] No arrivals tomorrow"); return; }
    console.log("[CRON] Sending " + rows.length + " pre-arrival email(s)");

    for (const b of rows) {
      if (!b.guest_email || b.guest_email.includes(".local")) continue;

      const spaceLabel = b.space_display ? "Space " + b.space_display : "Space " + b.space_number;
      const parkAddress = b.park_address || "304 E. HWY 82, Huachuca City, AZ 85616";
      const parkPhone = b.park_phone || "928-951-2067";
      const mapsUrl = "https://maps.google.com/?q=" + encodeURIComponent(parkAddress);

      const cin = new Date(b.check_in + "T12:00:00").toLocaleDateString("en-US", {weekday:"long",month:"long",day:"numeric",year:"numeric"});
      const cout = new Date(b.check_out + "T12:00:00").toLocaleDateString("en-US", {weekday:"long",month:"long",day:"numeric"});

      try {
        await resend.emails.send({
          from: FROM_EMAIL,
          to: b.guest_email,
          subject: "Your stay at " + b.park_name + " starts tomorrow — arrival info inside",
          html: "<div style=\"font-family:sans-serif;max-width:560px;margin:0 auto\"><div style=\"background:#2c1810;padding:20px 24px;border-radius:8px 8px 0 0\"><div style=\"font-size:20px;font-weight:700;color:#e8d5b0\">Roll In Host</div><div style=\"font-size:12px;color:rgba(232,213,176,0.6);margin-top:2px\">" + b.park_name + "</div></div><div style=\"background:#fff;padding:28px 24px;border:1px solid #e0d8cc;border-top:none;border-radius:0 0 8px 8px\"><h2 style=\"color:#2c1810\">See you tomorrow, " + b.guest_first_name + "!</h2><p style=\"color:#555;line-height:1.7\">Your reservation at <strong>" + b.park_name + "</strong> starts tomorrow. Here's what you need.</p><div style=\"background:#f5f0eb;border-radius:8px;padding:18px;margin:20px 0\"><table style=\"width:100%;font-size:14px;border-collapse:collapse\"><tr><td style=\"color:#888;padding:6px 0;width:130px\">Your Space</td><td style=\"font-weight:700;color:#2c1810;padding:6px 0\">" + spaceLabel + " &nbsp;&middot;&nbsp; " + b.amp + "A electric</td></tr><tr><td style=\"color:#888;padding:6px 0\">Check-in</td><td style=\"font-weight:700;color:#2c1810;padding:6px 0\">" + cin + "<br><span style=\"font-weight:400;font-size:13px;color:#666\">After 2:00 PM</span></td></tr><tr><td style=\"color:#888;padding:6px 0\">Check-out</td><td style=\"font-weight:700;color:#2c1810;padding:6px 0\">" + cout + "<br><span style=\"font-weight:400;font-size:13px;color:#666\">By 11:00 AM</span></td></tr><tr><td style=\"color:#888;padding:6px 0\">Stay</td><td style=\"font-weight:700;color:#2c1810;padding:6px 0\">" + b.nights + " night" + (b.nights !== 1 ? "s" : "") + "</td></tr></table></div><h3 style=\"color:#2c1810;font-size:15px\">&#128205; Address</h3><p style=\"color:#555\">" + parkAddress + "</p><a href=\"" + mapsUrl + "\" style=\"color:#2E8BC0;font-size:13px\">Open in Google Maps &rarr;</a><h3 style=\"color:#2c1810;font-size:15px;margin-top:20px\">&#128663; Arrival</h3><p style=\"color:#555;line-height:1.7\">Drive in and go directly to <strong>" + spaceLabel + "</strong>. Full hookups at your site: water, sewer, and " + b.amp + "A electric.</p><h3 style=\"color:#2c1810;font-size:15px;margin-top:20px\">&#128222; Questions?</h3><p style=\"color:#555\">Call or text the park at <a href=\"tel:" + parkPhone.replace(/\D/g,'') + "\" style=\"color:#2E8BC0\">" + parkPhone + "</a>.</p><p style=\"color:#aaa;font-size:11px;margin-top:28px;border-top:1px solid #f0ebe4;padding-top:16px\">" + b.park_name + " &middot; " + parkAddress + "<br>Powered by Roll In Host LLC &middot; rollinhost.com</p></div></div>"
        });
        console.log("[CRON] Pre-arrival email sent to " + b.guest_email + " " + spaceLabel);
      } catch (e) {
        console.error("[CRON] Pre-arrival email failed:", e.message);
      }
    }
  } catch (err) {
    console.error("[CRON] Pre-arrival error:", err.message);
  }
}

// ── Job 4: Trial Warning (7 days before expiry) ───────────────────────────
async function runTrialWarnings() {
  const today = arizonaDateStr();
  const targetStartDate = addDaysToDate(today, -(120 - 7));
  console.log("[CRON] Trial warning check for start date " + targetStartDate);
  try {
    const { rows: parks } = await db.query(
      "SELECT id, name, slug, email, trial_start_date FROM parks WHERE trial_start_date = $1 AND (trial_active IS NULL OR trial_active = true)",
      [targetStartDate]
    );
    if (!parks.length) { console.log("[CRON] No trial warnings today"); return; }

    for (const park of parks) {
      const expiryDate = addDaysToDate(park.trial_start_date, 120);
      const expiryNice = new Date(expiryDate + "T12:00:00").toLocaleDateString("en-US", {weekday:"long",month:"long",day:"numeric",year:"numeric"});

      await resend.emails.send({
        from: FROM_EMAIL,
        to: SUPPORT_EMAIL,
        subject: "[RollinHost] " + park.name + " trial expires in 7 days",
        html: "<p><strong>" + park.name + "</strong> (" + park.slug + ") has 7 days left on their founding trial.</p><p>Expires: <strong>" + expiryNice + "</strong></p><p>Follow up to arrange payment.</p>"
      }).catch(function(e){ console.error("[CRON] Internal trial warning failed:", e.message); });

      if (park.email) {
        await resend.emails.send({
          from: FROM_EMAIL,
          to: park.email,
          subject: "Your RollinHost trial ends in one week — here's what happens next",
          html: "<div style=\"font-family:sans-serif;max-width:560px;margin:0 auto\"><div style=\"background:#2c1810;padding:20px 24px;border-radius:8px 8px 0 0\"><div style=\"font-size:20px;font-weight:700;color:#e8d5b0\">Roll In Host</div></div><div style=\"background:#fff;padding:28px 24px;border:1px solid #e0d8cc;border-top:none;border-radius:0 0 8px 8px\"><h2 style=\"color:#2c1810\">Your founding trial ends in one week</h2><p style=\"color:#555;line-height:1.7\">Hi there — your 4-month founding trial for <strong>" + park.name + "</strong> ends on <strong>" + expiryNice + "</strong>.</p><p style=\"color:#555;line-height:1.7;margin-top:12px\">We've loved having you as a founding park. Continuing is simple — your rate is locked at <strong>$99/month</strong> forever, exactly as promised.</p><div style=\"background:#f5f0eb;border-radius:8px;padding:18px;margin:24px 0\"><div style=\"font-weight:700;color:#2c1810;margin-bottom:8px\">What stays active after your trial:</div><p style=\"color:#555;font-size:14px;line-height:1.8;margin:0\">&#10003; Your booking system<br>&#10003; All your guest data<br>&#10003; Every feature<br>&#10003; Your $99/month rate locked forever</p></div><p style=\"color:#555;line-height:1.7\">Just give us a call or reply to this email and we'll get your payment set up in minutes.</p><div style=\"text-align:center;margin:28px 0\"><a href=\"tel:6267655461\" style=\"background:#2c1810;color:#e8d5b0;padding:13px 30px;border-radius:6px;text-decoration:none;font-weight:700;font-size:15px;display:inline-block\">&#128222; Call 626-ROLLIN1</a></div><p style=\"color:#555\">Thank you for being a founding park.</p><p style=\"color:#555\">— Geoffrey<br><span style=\"color:#888;font-size:13px\">Roll In Host LLC &middot; " + SUPPORT_PHONE + "</span></p><p style=\"color:#aaa;font-size:11px;margin-top:24px;border-top:1px solid #f0ebe4;padding-top:16px\">Roll In Host LLC &middot; rollinhost.com &middot; " + SUPPORT_EMAIL + "</p></div></div>"
        }).catch(function(e){ console.error("[CRON] Park trial warning email failed:", e.message); });
        console.log("[CRON] Trial warning sent to " + park.email + " for " + park.name);
      }
    }
  } catch (err) {
    console.error("[CRON] Trial warning error:", err.message);
  }
}

// ── Job 5: Trial Expiry ───────────────────────────────────────────────────
async function runTrialExpiry() {
  const today = arizonaDateStr();
  const targetStartDate = addDaysToDate(today, -120);
  console.log("[CRON] Trial expiry check for start date " + targetStartDate);
  try {
    const { rows: parks } = await db.query(
      "UPDATE parks SET trial_active = false WHERE trial_start_date = $1 AND (trial_active IS NULL OR trial_active = true) RETURNING id, name, slug",
      [targetStartDate]
    );
    if (!parks.length) { console.log("[CRON] No trials expiring today"); return; }
    for (const park of parks) {
      console.log("[CRON] Trial expired: " + park.name + " (" + park.slug + ")");
      await resend.emails.send({
        from: FROM_EMAIL,
        to: SUPPORT_EMAIL,
        subject: "[RollinHost] " + park.name + " trial expired — action needed",
        html: "<p><strong>" + park.name + "</strong> (" + park.slug + ") trial expired today. Bookings disabled.</p><p>To reactivate after payment:</p><code style=\"background:#f5f0eb;padding:8px 12px;border-radius:4px;display:block;margin:12px 0\">UPDATE parks SET trial_active = true, trial_start_date = NULL WHERE slug = '" + park.slug + "';</code>"
      }).catch(function(e){ console.error("[CRON] Expiry alert failed:", e.message); });
    }
  } catch (err) {
    console.error("[CRON] Trial expiry error:", err.message);
  }
}

// ── Scheduler ─────────────────────────────────────────────────────────────
async function runAllJobs() {
  console.log("[CRON] Running nightly jobs...");
  await runAutoCheckIn();
  await runAutoCheckOut();
  await runPreArrivalEmails();
  await runTrialWarnings();
  await runTrialExpiry();
  console.log("[CRON] All nightly jobs complete.");
}

function scheduleMidnightJob() {
  const ms = msUntilMidnightAZ();
  const hours = Math.floor(ms / 3600000);
  const mins  = Math.floor((ms % 3600000) / 60000);
  console.log("[CRON] Nightly jobs scheduled — next run in " + hours + "h " + mins + "m (midnight Arizona time)");
  setTimeout(function tick() {
    runAllJobs();
    setInterval(runAllJobs, 24 * 60 * 60 * 1000);
  }, ms);
}

scheduleMidnightJob();

module.exports = { runAutoCheckIn, runAutoCheckOut, runPreArrivalEmails, runTrialWarnings, runTrialExpiry };
