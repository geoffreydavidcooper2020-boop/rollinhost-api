const { Router } = require("express");
const db = require("../db");

const router = Router();

// ── POST /meter-readings ──────────────────────────────────────────────────
// Log a meter reading for a tenancy. Used both for the initial move-in baseline
// and for monthly readings. The mobile-friendly meter reading page in the
// dashboard posts here when Sheila/Willie walks the park.
router.post("/", async (req, res) => {
  const {
    tenancy_id, reading_date, meter_type,
    current_reading, rate_per_unit, photo_url,
    is_initial_reading, recorded_by_user_id, notes
  } = req.body;

  if (!tenancy_id || current_reading === undefined) {
    return res.status(400).json({ error: "Missing required fields: tenancy_id, current_reading" });
  }

  const meterType = meter_type || "electric";
  const validTypes = ["electric", "water", "gas", "sewer"];
  if (!validTypes.includes(meterType)) {
    return res.status(400).json({ error: "Invalid meter_type" });
  }

  try {
    // Look up tenancy to get park_slug and the previous reading
    const { rows: tenRows } = await db.query(
      `SELECT id, park_slug, electric_rate_per_kwh FROM tenancies WHERE id = $1`,
      [tenancy_id]
    );
    if (!tenRows.length) {
      return res.status(404).json({ error: "Tenancy not found" });
    }
    const tenancy = tenRows[0];

    // Find the previous reading of the same meter_type for this tenancy
    const { rows: prevRows } = await db.query(
      `SELECT current_reading FROM meter_readings
       WHERE tenancy_id = $1 AND meter_type = $2
       ORDER BY reading_date DESC, created_at DESC LIMIT 1`,
      [tenancy_id, meterType]
    );
    const previousReading = prevRows.length ? prevRows[0].current_reading : null;

    // If no rate provided, fall back to tenancy's electric rate (for electric only)
    let rate = rate_per_unit;
    if (rate === undefined || rate === null) {
      if (meterType === "electric" && tenancy.electric_rate_per_kwh) {
        rate = tenancy.electric_rate_per_kwh;
      } else {
        return res.status(400).json({ error: "rate_per_unit required (no default rate set on tenancy)" });
      }
    }

    const { rows } = await db.query(
      `INSERT INTO meter_readings (
         tenancy_id, park_slug, reading_date, meter_type,
         current_reading, previous_reading, rate_per_unit,
         photo_url, is_initial_reading, recorded_by_user_id, notes
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [
        tenancy_id, tenancy.park_slug,
        reading_date || new Date().toISOString().slice(0, 10),
        meterType,
        Number(current_reading), previousReading,
        Number(rate),
        photo_url || null,
        is_initial_reading || false,
        recorded_by_user_id || null,
        notes || null
      ]
    );

    const reading = rows[0];
    const usage = previousReading !== null
      ? Number(reading.current_reading) - Number(previousReading)
      : 0;
    const amount = usage * Number(rate);

    console.log(`Meter reading: tenancy ${tenancy_id} ${meterType} ${current_reading} (usage: ${usage}, $${amount.toFixed(2)})`);

    res.status(201).json({
      ...reading,
      computed_usage: usage,
      computed_amount: Number(amount.toFixed(2))
    });
  } catch (err) {
    console.error("Error logging meter reading:", err);
    res.status(500).json({ error: "Failed to log meter reading" });
  }
});

// ── GET /meter-readings?tenancy_id=xxx&meter_type=electric ────────────────
router.get("/", async (req, res) => {
  const { tenancy_id, meter_type, park_slug, unbilled } = req.query;

  if (!tenancy_id && !park_slug) {
    return res.status(400).json({ error: "tenancy_id or park_slug required" });
  }

  try {
    let query = `SELECT * FROM meter_readings WHERE 1=1`;
    const params = [];
    let idx = 1;

    if (tenancy_id) {
      query += ` AND tenancy_id = $${idx++}`;
      params.push(tenancy_id);
    }
    if (park_slug) {
      query += ` AND park_slug = $${idx++}`;
      params.push(park_slug);
    }
    if (meter_type) {
      query += ` AND meter_type = $${idx++}`;
      params.push(meter_type);
    }
    if (unbilled === "true") {
      query += ` AND invoice_item_id IS NULL AND is_initial_reading = FALSE`;
    }

    query += ` ORDER BY reading_date DESC, created_at DESC`;

    const { rows } = await db.query(query, params);
    res.json(rows);
  } catch (err) {
    console.error("Error listing meter readings:", err);
    res.status(500).json({ error: "Failed to list meter readings" });
  }
});

// ── GET /meter-readings/:id ───────────────────────────────────────────────
router.get("/:id", async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT * FROM meter_readings WHERE id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "Meter reading not found" });
    res.json(rows[0]);
  } catch (err) {
    console.error("Error fetching meter reading:", err);
    res.status(500).json({ error: "Failed to fetch meter reading" });
  }
});

module.exports = router;
