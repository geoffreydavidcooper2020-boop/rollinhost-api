const { Router } = require("express");
const db = require("../db");

const router = Router();

// ── GET /parks/:slug/dashboard ────────────────────────────────────────────
// Occupancy, revenue, upcoming check-ins
router.get("/:slug/dashboard", async (req, res) => {
  const { slug } = req.params;
  try {
    const { rows: parkRows } = await db.query(
      `SELECT id, name, owner_phone FROM parks WHERE slug = $1`, [slug]
    );
    if (!parkRows.length) return res.status(404).json({ error: "Park not found" });
    const park = parkRows[0];

    // Total spaces
    const { rows: spaceCount } = await db.query(
      `SELECT COUNT(*) AS total FROM spaces WHERE park_id = $1`, [park.id]
    );

    // Current occupancy (spaces occupied today)
    const today = new Date().toISOString().slice(0, 10);
    const { rows: occRows } = await db.query(
      `SELECT COUNT(*) AS occupied
       FROM bookings b
       JOIN spaces s ON s.id = b.space_id
       WHERE s.park_id = $1
         AND b.status IN ('confirmed','checked_in')
         AND b.check_in <= $2 AND b.check_out > $2`,
      [park.id, today]
    );

    // This month revenue
    const { rows: revRows } = await db.query(
      `SELECT COALESCE(SUM(total_charged), SUM(total), 0) AS revenue
       FROM bookings b
       JOIN spaces s ON s.id = b.space_id
       WHERE s.park_id = $1
         AND b.status IN ('confirmed','checked_in','checked_out')
         AND DATE_TRUNC('month', b.created_at) = DATE_TRUNC('month', NOW())`,
      [park.id]
    );

    // Upcoming check-ins (next 7 days)
    const { rows: upcoming } = await db.query(
      `SELECT b.id, b.check_in, b.check_out, b.nights,
              b.guest_first_name, b.guest_last_name, b.guest_name,
              b.guest_email, b.rate_type,
              b.total_charged, b.total,
              s.number AS space_number, s.amp_service
       FROM bookings b
       JOIN spaces s ON s.id = b.space_id
       WHERE s.park_id = $1
         AND b.status = 'confirmed'
         AND b.check_in BETWEEN $2 AND $2::date + INTERVAL '7 days'
       ORDER BY b.check_in`,
      [park.id, today]
    );

    res.json({
      park_name:    park.name,
      total_spaces: parseInt(spaceCount[0].total),
      occupied:     parseInt(occRows[0].occupied),
      month_revenue: parseInt(revRows[0].revenue || 0),
      upcoming,
    });
  } catch (err) {
    console.error("Dashboard error:", err);
    res.status(500).json({ error: "Failed to load dashboard" });
  }
});

// ── GET /parks/:slug/pricing-rules ───────────────────────────────────────
router.get("/:slug/pricing-rules", async (req, res) => {
  const { slug } = req.params;
  try {
    const { rows: parkRows } = await db.query(
      `SELECT id FROM parks WHERE slug = $1`, [slug]
    );
    if (!parkRows.length) return res.status(404).json({ error: "Park not found" });

    const { rows } = await db.query(
      `SELECT * FROM pricing_rules WHERE park_id = $1 ORDER BY created_at`,
      [parkRows[0].id]
    );
    res.json(rows);
  } catch (err) {
    console.error("Pricing rules error:", err);
    res.status(500).json({ error: "Failed to fetch pricing rules" });
  }
});

// ── PUT /parks/:slug/pricing-rules ───────────────────────────────────────
router.put("/:slug/pricing-rules", async (req, res) => {
  const { slug } = req.params;
  const { rules } = req.body;
  try {
    const { rows: parkRows } = await db.query(
      `SELECT id FROM parks WHERE slug = $1`, [slug]
    );
    if (!parkRows.length) return res.status(404).json({ error: "Park not found" });
    const parkId = parkRows[0].id;

    await db.query(`DELETE FROM pricing_rules WHERE park_id = $1`, [parkId]);
    for (const rule of rules || []) {
      await db.query(
        `INSERT INTO pricing_rules (park_id, name, rate_multiplier, start_date, end_date)
         VALUES ($1, $2, $3, $4, $5)`,
        [parkId, rule.name, rule.rate_multiplier, rule.start_date, rule.end_date]
      );
    }
    res.json({ success: true });
  } catch (err) {
    console.error("Pricing rules update error:", err);
    res.status(500).json({ error: "Failed to update pricing rules" });
  }
});

// ── PUT /parks/:slug/rates ────────────────────────────────────────────────
// Save nightly/weekly/monthly rates to the park record
router.put("/:slug/rates", async (req, res) => {
  const { slug } = req.params;
  const { nightly, weekly, monthly } = req.body;
  if (!nightly) return res.status(400).json({ error: "nightly rate required" });

  try {
    const { rows } = await db.query(
      `UPDATE parks
       SET rate_nightly = $1, rate_weekly = $2, rate_monthly = $3
       WHERE slug = $4
       RETURNING id`,
      [nightly, weekly || null, monthly || null, slug]
    );
    if (!rows.length) return res.status(404).json({ error: "Park not found" });

    res.json({ success: true, nightly, weekly, monthly });
  } catch (err) {
    console.error("Rates update error:", err);
    res.status(500).json({ error: "Failed to update rates" });
  }
});

// ── GET /parks/:slug/rates ───────────────────────────────────────────────
router.get("/:slug/rates", async (req, res) => {
  const { slug } = req.params;
  try {
    const { rows } = await db.query(
      `SELECT rate_nightly AS nightly, rate_weekly AS weekly, rate_monthly AS monthly
       FROM parks WHERE slug = $1`, [slug]
    );
    if (!rows.length) return res.status(404).json({ error: "Park not found" });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch rates" });
  }
});

// ── GET /parks/:slug/settings ─────────────────────────────────────────────
router.get("/:slug/settings", async (req, res) => {
  const { slug } = req.params;
  try {
    const { rows } = await db.query(
      `SELECT name, address, phone, email FROM parks WHERE slug = $1`, [slug]
    );
    if (!rows.length) return res.status(404).json({ error: "Park not found" });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch settings" });
  }
});

// ── PUT /parks/:slug/settings ─────────────────────────────────────────────
// Save park info (name, address, phone, email, check-in time)
router.put("/:slug/settings", async (req, res) => {
  const { slug } = req.params;
  const { name, address, phone, email, checkin_time } = req.body;

  try {
    const { rows } = await db.query(
      `UPDATE parks
       SET name = COALESCE($1, name),
           address = COALESCE($2, address),
           owner_phone = COALESCE($3, owner_phone),
           owner_email = COALESCE($4, owner_email),
           updated_at = NOW()
       WHERE slug = $5
       RETURNING id, name, address, owner_phone, owner_email`,
      [name, address, phone, email, slug]
    );
    if (!rows.length) return res.status(404).json({ error: "Park not found" });
    res.json({ success: true, park: rows[0] });
  } catch (err) {
    console.error("Settings update error:", err);
    res.status(500).json({ error: "Failed to update settings" });
  }
});

// ── PUT /parks/:slug/addons/sms ───────────────────────────────────────────
// Store owner SMS phone number for booking alerts
router.put("/:slug/addons/sms", async (req, res) => {
  const { slug } = req.params;
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: "phone required" });

  try {
    const { rows } = await db.query(
      `UPDATE parks SET owner_phone = $1, updated_at = NOW()
       WHERE slug = $2 RETURNING id`,
      [phone, slug]
    );
    if (!rows.length) return res.status(404).json({ error: "Park not found" });
    res.json({ success: true, message: "SMS phone number saved" });
  } catch (err) {
    console.error("SMS addon error:", err);
    res.status(500).json({ error: "Failed to save SMS phone" });
  }
});

// ── PUT /parks/:slug/guestform ────────────────────────────────────────────
// Save guest application form config (mode, fields, rules)
router.put("/:slug/guestform", async (req, res) => {
  const { slug } = req.params;
  const { config } = req.body;
  if (!config) return res.status(400).json({ error: "config required" });

  try {
    await db.query(
      `UPDATE parks
       SET guest_form_config = $1, updated_at = NOW()
       WHERE slug = $2`,
      [JSON.stringify(config), slug]
    ).catch(async () => {
      // Column may not exist yet — add it
      await db.query(
        `ALTER TABLE parks ADD COLUMN IF NOT EXISTS guest_form_config JSONB`
      );
      await db.query(
        `UPDATE parks SET guest_form_config = $1 WHERE slug = $2`,
        [JSON.stringify(config), slug]
      );
    });

    res.json({ success: true });
  } catch (err) {
    console.error("Guest form config error:", err);
    res.status(500).json({ error: "Failed to save guest form config" });
  }
});

// ── GET /parks/:slug/guestform ────────────────────────────────────────────
// Get guest form config (used by booking page to show the form)
router.get("/:slug/guestform", async (req, res) => {
  const { slug } = req.params;
  try {
    const { rows } = await db.query(
      `SELECT guest_form_config FROM parks WHERE slug = $1`, [slug]
    );
    if (!rows.length) return res.status(404).json({ error: "Park not found" });
    res.json(rows[0].guest_form_config || { mode: "off", fields: {} });
  } catch (err) {
    res.json({ mode: "off", fields: {} }); // fail open — don't block booking
  }
});

// ── POST /parks/:slug/applications ───────────────────────────────────────
// Guest submits application before booking
router.post("/:slug/applications", async (req, res) => {
  const { slug } = req.params;
  const { space_number, guest_email, guest_name, responses } = req.body;

  try {
    // Get park + form config
    const { rows: parkRows } = await db.query(
      `SELECT id, guest_form_config FROM parks WHERE slug = $1`, [slug]
    );
    if (!parkRows.length) return res.status(404).json({ error: "Park not found" });
    const park = parkRows[0];
    const formConfig = park.guest_form_config || { mode: "all", fields: {}, rules: {} };

    // Determine decision
    let decision = "approved";
    let reason = null;

    if (formConfig.mode === "manual") {
      decision = "pending";
    } else if (formConfig.mode === "auto") {
      const rules = formConfig.rules || {};

      if (rules.maxLength && responses.rv_length > rules.maxLength) {
        decision = "denied";
        reason = `RV length ${responses.rv_length}ft exceeds park maximum of ${rules.maxLength}ft`;
      }
      if (rules.minYear && responses.rv_year < rules.minYear) {
        decision = "denied";
        reason = `RV year ${responses.rv_year} is older than the park minimum of ${rules.minYear}`;
      }
      if (rules.pets === "deny" && responses.pets > 0) {
        decision = "denied";
        reason = "This park does not allow pets";
      }
      if (rules.maxPets && responses.pets > rules.maxPets) {
        decision = "denied";
        reason = `Maximum ${rules.maxPets} pet(s) allowed`;
      }
      if (rules.children === "deny" && responses.children > 0) {
        decision = "denied";
        reason = "This is a 55+ community — children are not permitted";
      }
      if (rules.maxAdults && responses.adults > rules.maxAdults) {
        decision = "denied";
        reason = `Maximum ${rules.maxAdults} adult(s) per space`;
      }
      if (rules.maxSlides && responses.slide_outs > rules.maxSlides) {
        decision = "denied";
        reason = `Maximum ${rules.maxSlides} slide-out(s) allowed`;
      }
    }
    // mode === "all" stays approved

    // Store application (add table if needed)
    await db.query(
      `INSERT INTO applications
         (park_id, space_number, guest_email, guest_name, responses, decision, reason, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
      [park.id, space_number, guest_email, guest_name,
       JSON.stringify(responses), decision, reason]
    ).catch(async () => {
      // Table doesn't exist — create it
      await db.query(`
        CREATE TABLE IF NOT EXISTS applications (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          park_id UUID NOT NULL,
          space_number INTEGER,
          guest_email TEXT,
          guest_name TEXT,
          responses JSONB,
          decision TEXT NOT NULL DEFAULT 'pending',
          reason TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await db.query(
        `INSERT INTO applications
           (park_id, space_number, guest_email, guest_name, responses, decision, reason, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
        [park.id, space_number, guest_email, guest_name,
         JSON.stringify(responses), decision, reason]
      );
    });

    res.json({ decision, reason });
  } catch (err) {
    console.error("Application error:", err);
    // Fail open — don't block a booking over a form error
    res.json({ decision: "approved", reason: null });
  }
});

// ── GET /parks/:slug/applications ─────────────────────────────────────────
// Owner views pending applications (manual review mode)
router.get("/:slug/applications", async (req, res) => {
  const { slug } = req.params;
  try {
    const { rows: parkRows } = await db.query(
      `SELECT id FROM parks WHERE slug = $1`, [slug]
    );
    if (!parkRows.length) return res.status(404).json({ error: "Park not found" });

    const { rows } = await db.query(
      `SELECT * FROM applications WHERE park_id = $1 ORDER BY created_at DESC`,
      [parkRows[0].id]
    );
    res.json(rows);
  } catch (err) {
    res.json([]); // table may not exist yet
  }
});

// ── POST /parks/:slug/applications/:id/decide ─────────────────────────────
// Owner manually approves or denies an application
router.post("/:slug/applications/:id/decide", async (req, res) => {
  const { id } = req.params;
  const { decision, reason } = req.body;
  if (!["approved","denied"].includes(decision)) {
    return res.status(400).json({ error: "decision must be approved or denied" });
  }
  try {
    await db.query(
      `UPDATE applications SET decision = $1, reason = $2 WHERE id = $3`,
      [decision, reason || null, id]
    );
    res.json({ success: true });
  } catch (err) {
    console.error("Application decide error:", err);
    res.status(500).json({ error: "Failed to update application" });
  }
});

module.exports = router;
