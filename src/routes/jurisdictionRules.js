const { Router } = require("express");
const db = require("../db");

const router = Router();

// ── GET /jurisdiction-rules?jurisdiction=AZ ───────────────────────────────
// Returns all rules for a given jurisdiction. Read-only.
// Used by the dashboard's Legal Compliance page and by API logic that
// needs to enforce jurisdiction-specific behavior (e.g. late fee caps).
router.get("/", async (req, res) => {
  const { jurisdiction } = req.query;

  try {
    let query = `SELECT jurisdiction, rule_key, rule_value, rule_type, notes, source_url
                 FROM jurisdiction_rules`;
    const params = [];

    if (jurisdiction) {
      query += ` WHERE jurisdiction = $1`;
      params.push(jurisdiction);
    }

    query += ` ORDER BY jurisdiction, rule_key`;

    const { rows } = await db.query(query, params);

    // Convert to a more usable shape for the frontend:
    // { "AZ": { "long_term_threshold_days": "180", ... } }
    const grouped = {};
    for (const r of rows) {
      if (!grouped[r.jurisdiction]) grouped[r.jurisdiction] = {};
      grouped[r.jurisdiction][r.rule_key] = {
        value: r.rule_value,
        type: r.rule_type,
        notes: r.notes,
        source_url: r.source_url
      };
    }

    res.json({ rules: rows, grouped });
  } catch (err) {
    console.error("Error fetching jurisdiction rules:", err);
    res.status(500).json({ error: "Failed to fetch jurisdiction rules" });
  }
});

// ── GET /jurisdiction-rules/for-park/:slug ────────────────────────────────
// Returns the rules that apply to a specific park, looked up by their jurisdiction.
// This is what the dashboard's Legal Compliance page calls.
router.get("/for-park/:slug", async (req, res) => {
  try {
    const { rows: parkRows } = await db.query(
      `SELECT slug, name, jurisdiction FROM parks WHERE slug = $1`,
      [req.params.slug]
    );
    if (!parkRows.length) return res.status(404).json({ error: "Park not found" });
    const park = parkRows[0];

    const { rows: ruleRows } = await db.query(
      `SELECT jurisdiction, rule_key, rule_value, rule_type, notes, source_url
       FROM jurisdiction_rules
       WHERE jurisdiction = $1 OR jurisdiction LIKE $2
       ORDER BY rule_key`,
      [park.jurisdiction, park.jurisdiction + "-%"]
    );

    // Build a flat object for easy frontend consumption
    const rules = {};
    for (const r of ruleRows) {
      rules[r.rule_key] = {
        value: r.rule_value,
        type: r.rule_type,
        notes: r.notes,
        source_url: r.source_url,
        jurisdiction: r.jurisdiction
      };
    }

    res.json({
      park_slug: park.slug,
      park_name: park.name,
      jurisdiction: park.jurisdiction,
      rules
    });
  } catch (err) {
    console.error("Error fetching park jurisdiction rules:", err);
    res.status(500).json({ error: "Failed to fetch park rules" });
  }
});

module.exports = router;
