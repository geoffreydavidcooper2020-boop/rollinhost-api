const { Router } = require("express");
const db = require("../db");

const router = Router();

// ── POST /expenses ────────────────────────────────────────────────────────
// Log a park expense. Sheila/Willie do this on their phone with receipt photos.
// This data feeds the AI Park Manager so it can generate full P&L reports.
router.post("/", async (req, res) => {
  const {
    park_slug, expense_date, category, vendor, description, amount,
    ticket_id, receipt_photo_url, payment_method,
    is_deductible, is_capital_expense,
    notes, entered_by_user_id
  } = req.body;

  if (!park_slug || !category || !description || amount === undefined) {
    return res.status(400).json({ error: "Missing required fields: park_slug, category, description, amount" });
  }

  const validCategories = [
    "maintenance", "supplies", "utilities", "contractor",
    "payroll", "insurance", "taxes_fees", "marketing",
    "fuel", "office", "professional_services",
    "permits_licenses", "repairs", "capital_improvement",
    "travel", "other"
  ];
  if (!validCategories.includes(category)) {
    return res.status(400).json({ error: "Invalid category" });
  }

  if (Number(amount) <= 0) {
    return res.status(400).json({ error: "Amount must be greater than zero" });
  }

  try {
    // Confirm park exists
    const { rows: parkRows } = await db.query(
      `SELECT id FROM parks WHERE slug = $1`,
      [park_slug]
    );
    if (!parkRows.length) {
      return res.status(404).json({ error: "Park not found" });
    }

    const { rows } = await db.query(
      `INSERT INTO expenses (
         park_slug, expense_date, category, vendor, description, amount,
         ticket_id, receipt_photo_url, payment_method,
         is_deductible, is_capital_expense, notes, entered_by_user_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [
        park_slug, expense_date || new Date().toISOString().slice(0, 10),
        category, vendor || null, description, Number(amount),
        ticket_id || null, receipt_photo_url || null, payment_method || null,
        is_deductible !== false, is_capital_expense || false,
        notes || null, entered_by_user_id || null
      ]
    );

    console.log(`Expense logged: ${park_slug} $${amount} ${category} - ${description}`);
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error("Error logging expense:", err);
    res.status(500).json({ error: "Failed to log expense" });
  }
});

// ── GET /expenses?park=mustang-corner&from=2026-01-01&to=2026-04-30 ──────
// List expenses with optional date range and category filter.
// Used by dashboard expense list and the AI Park Manager for P&L reports.
router.get("/", async (req, res) => {
  const { park, from, to, category, ticket_id } = req.query;
  if (!park) return res.status(400).json({ error: "park (slug) is required" });

  try {
    let query = `SELECT * FROM expenses WHERE park_slug = $1`;
    const params = [park];
    let idx = 2;

    if (from) {
      query += ` AND expense_date >= $${idx++}`;
      params.push(from);
    }
    if (to) {
      query += ` AND expense_date <= $${idx++}`;
      params.push(to);
    }
    if (category) {
      query += ` AND category = $${idx++}`;
      params.push(category);
    }
    if (ticket_id) {
      query += ` AND ticket_id = $${idx++}`;
      params.push(ticket_id);
    }

    query += ` ORDER BY expense_date DESC, created_at DESC`;

    const { rows } = await db.query(query, params);
    res.json(rows);
  } catch (err) {
    console.error("Error listing expenses:", err);
    res.status(500).json({ error: "Failed to list expenses" });
  }
});

// ── GET /expenses/summary?park=mustang-corner&from=2026-01-01&to=2026-04-30
// Returns expense totals grouped by category — perfect for dashboards and AI.
router.get("/summary", async (req, res) => {
  const { park, from, to } = req.query;
  if (!park) return res.status(400).json({ error: "park (slug) is required" });

  try {
    let query = `
      SELECT category, COUNT(*) AS count, SUM(amount) AS total
      FROM expenses
      WHERE park_slug = $1`;
    const params = [park];
    let idx = 2;

    if (from) {
      query += ` AND expense_date >= $${idx++}`;
      params.push(from);
    }
    if (to) {
      query += ` AND expense_date <= $${idx++}`;
      params.push(to);
    }

    query += ` GROUP BY category ORDER BY total DESC`;

    const { rows } = await db.query(query, params);
    const grand_total = rows.reduce((s, r) => s + Number(r.total), 0);
    res.json({ by_category: rows, grand_total });
  } catch (err) {
    console.error("Error summarizing expenses:", err);
    res.status(500).json({ error: "Failed to summarize expenses" });
  }
});

// ── GET /expenses/:id ─────────────────────────────────────────────────────
router.get("/:id", async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT * FROM expenses WHERE id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "Expense not found" });
    res.json(rows[0]);
  } catch (err) {
    console.error("Error fetching expense:", err);
    res.status(500).json({ error: "Failed to fetch expense" });
  }
});

// ── PATCH /expenses/:id ───────────────────────────────────────────────────
router.patch("/:id", async (req, res) => {
  const allowedFields = [
    "expense_date", "category", "vendor", "description", "amount",
    "ticket_id", "receipt_photo_url", "payment_method",
    "is_deductible", "is_capital_expense", "notes"
  ];

  const updates = [];
  const values = [];
  let paramIndex = 1;

  for (const field of allowedFields) {
    if (req.body[field] !== undefined) {
      updates.push(`${field} = $${paramIndex}`);
      values.push(req.body[field]);
      paramIndex++;
    }
  }

  if (!updates.length) {
    return res.status(400).json({ error: "No valid fields to update" });
  }

  values.push(req.params.id);

  try {
    const { rows } = await db.query(
      `UPDATE expenses SET ${updates.join(", ")} WHERE id = $${paramIndex} RETURNING *`,
      values
    );
    if (!rows.length) return res.status(404).json({ error: "Expense not found" });
    res.json(rows[0]);
  } catch (err) {
    console.error("Error updating expense:", err);
    res.status(500).json({ error: "Failed to update expense" });
  }
});

// ── DELETE /expenses/:id ──────────────────────────────────────────────────
router.delete("/:id", async (req, res) => {
  try {
    const { rowCount } = await db.query(
      `DELETE FROM expenses WHERE id = $1`,
      [req.params.id]
    );
    if (!rowCount) return res.status(404).json({ error: "Expense not found" });
    res.json({ deleted: true });
  } catch (err) {
    console.error("Error deleting expense:", err);
    res.status(500).json({ error: "Failed to delete expense" });
  }
});

module.exports = router;
