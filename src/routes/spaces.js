const { Router } = require("express");
const db = require("../db");

const router = Router();

// GET /spaces?park_id=&check_in=&check_out=
// Returns all spaces for a park with availability status
router.get("/", async (req, res) => {
  const { park_id, check_in, check_out } = req.query;

  if (!park_id) {
    return res.status(400).json({ error: "park_id is required" });
  }

  try {
    const { rows: spaces } = await db.query(
      `SELECT s.*,
        CASE WHEN b.id IS NOT NULL THEN false ELSE true END AS available
       FROM spaces s
       LEFT JOIN bookings b
         ON b.space_id = s.id
         AND b.status IN ('confirmed', 'pending')
         AND b.check_in < $3
         AND b.check_out > $2
       WHERE s.park_id = $1
       ORDER BY s.name`,
      [park_id, check_in || "1970-01-01", check_out || "9999-12-31"]
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

module.exports = router;
