const { Router } = require("express");
const db = require("../db");

const router = Router();

// GET /parks/:id/dashboard
// Returns stats for the park owner dashboard
router.get("/:id/dashboard", async (req, res) => {
  const { id } = req.params;

  try {
    const [occupancy, revenue, upcoming] = await Promise.all([
      // Current occupancy
      db.query(
        `SELECT
           COUNT(*) FILTER (WHERE b.id IS NOT NULL) AS occupied,
           COUNT(*) AS total
         FROM spaces s
         LEFT JOIN bookings b
           ON b.space_id = s.id
           AND b.status = 'confirmed'
           AND b.check_in <= CURRENT_DATE
           AND b.check_out > CURRENT_DATE
         WHERE s.park_id = $1`,
        [id]
      ),
      // Revenue this month
      db.query(
        `SELECT COALESCE(SUM(total), 0) AS monthly_revenue
         FROM bookings
         WHERE space_id IN (SELECT id FROM spaces WHERE park_id = $1)
           AND status = 'confirmed'
           AND check_in >= date_trunc('month', CURRENT_DATE)`,
        [id]
      ),
      // Upcoming check-ins (next 7 days)
      db.query(
        `SELECT b.*, s.name AS space_name
         FROM bookings b
         JOIN spaces s ON s.id = b.space_id
         WHERE s.park_id = $1
           AND b.status = 'confirmed'
           AND b.check_in BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '7 days'
         ORDER BY b.check_in`,
        [id]
      ),
    ]);

    res.json({
      occupancy: {
        occupied: parseInt(occupancy.rows[0].occupied),
        total: parseInt(occupancy.rows[0].total),
      },
      monthly_revenue: parseInt(revenue.rows[0].monthly_revenue),
      upcoming_checkins: upcoming.rows,
    });
  } catch (err) {
    console.error("Error fetching dashboard:", err);
    res.status(500).json({ error: "Failed to fetch dashboard" });
  }
});

// GET /parks/:id/pricing-rules
router.get("/:id/pricing-rules", async (req, res) => {
  try {
    const { rows } = await db.query(
      "SELECT * FROM pricing_rules WHERE park_id = $1 ORDER BY min_nights",
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    console.error("Error fetching pricing rules:", err);
    res.status(500).json({ error: "Failed to fetch pricing rules" });
  }
});

// PUT /parks/:id/pricing-rules
router.put("/:id/pricing-rules", async (req, res) => {
  const { id } = req.params;
  const { rules } = req.body; // [{ min_nights, discount_pct }]

  if (!Array.isArray(rules)) {
    return res.status(400).json({ error: "rules must be an array" });
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM pricing_rules WHERE park_id = $1", [id]);

    for (const rule of rules) {
      await client.query(
        "INSERT INTO pricing_rules (park_id, min_nights, discount_pct) VALUES ($1, $2, $3)",
        [id, rule.min_nights, rule.discount_pct]
      );
    }

    await client.query("COMMIT");

    const { rows } = await db.query(
      "SELECT * FROM pricing_rules WHERE park_id = $1 ORDER BY min_nights",
      [id]
    );
    res.json(rows);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Error updating pricing rules:", err);
    res.status(500).json({ error: "Failed to update pricing rules" });
  } finally {
    client.release();
  }
});

module.exports = router;
