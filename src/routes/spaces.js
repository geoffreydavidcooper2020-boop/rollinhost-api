const { Router } = require("express");
const db = require("../db");

const router = Router();

// GET /spaces?park=mustang-corner&check_in=&check_out=
// Returns all spaces for a park (by slug) with availability status
router.get("/", async (req, res) => {
  const { park, check_in, check_out } = req.query;

  if (!park) {
    return res.status(400).json({ error: "park (slug) is required" });
  }

  try {
    const { rows: spaces } = await db.query(
      `SELECT s.*,
        CASE WHEN b.id IS NOT NULL THEN false ELSE true END AS available
       FROM spaces s
       INNER JOIN parks p ON p.id = s.park_id
       LEFT JOIN bookings b
         ON b.space_id = s.id
         AND b.status IN ('confirmed', 'pending')
         AND b.check_in < $3
         AND b.check_out > $2
       WHERE p.slug = $1
       ORDER BY s.number`,
      [park,
       check_in || new Date().toISOString().slice(0, 10),
       check_out || (() => { const d = new Date(); d.setDate(d.getDate() + 1); return d.toISOString().slice(0, 10); })()]
    );

    res.json(spaces);
  } catch (err) {
    console.error("Error fetching spaces:", err);
    res.status(500).json({ error: "Failed to fetch spaces" });
  }
});

// GET /spaces/:id/availability?check_in=&check_out=
router.get("/:id/availability", async (req, res) => {
  const { id } = req.params;
  const { check_in, check_out } = req.query;

  if (!check_in || !check_out) {
    return res.status(400).json({ error: "check_in and check_out are required" });
  }

  try {
    const { rows } = await db.query(
      `SELECT COUNT(*) AS conflicts
       FROM bookings
       WHERE space_id = $1
         AND status IN ('confirmed', 'pending')
         AND check_in < $3
         AND check_out > $2`,
      [id, check_in, check_out]
    );

    const available = parseInt(rows[0].conflicts) === 0;
    res.json({ space_id: id, available, check_in, check_out });
  } catch (err) {
    console.error("Error checking availability:", err);
    res.status(500).json({ error: "Failed to check availability" });
  }
});

// GET /spaces/:parkSlug/:spaceNumber/calendar
// Returns booked date ranges for a specific space
router.get("/:parkSlug/:spaceNumber/calendar", async (req, res) => {
  const { parkSlug, spaceNumber } = req.params;

  try {
    const { rows } = await db.query(
      `SELECT b.check_in, b.check_out
       FROM bookings b
       JOIN spaces s ON s.id = b.space_id
       JOIN parks p ON p.id = s.park_id
       WHERE p.slug = $1
         AND s.number = $2
         AND b.status IN ('confirmed', 'pending')
         AND b.check_out >= CURRENT_DATE
       ORDER BY b.check_in`,
      [parkSlug, parseInt(spaceNumber, 10)]
    );

    res.json(rows);
  } catch (err) {
    console.error("Error fetching calendar:", err);
    res.status(500).json({ error: "Failed to fetch calendar" });
  }
});

module.exports = router;
