const { Router } = require("express");
const db = require("../db");

const router = Router();

// ── POST /reports/:slug/ai-revenue ────────────────────────────────────────
// Generate AI revenue report for the park
router.post("/:slug/ai-revenue", async (req, res) => {
  const { slug } = req.params;

  try {
    const { rows: parkRows } = await db.query(
      `SELECT id, name FROM parks WHERE slug = $1`, [slug]
    );
    if (!parkRows.length) return res.status(404).json({ error: "Park not found" });
    const park = parkRows[0];

    // Get last 90 days of booking data
    const { rows: bookings } = await db.query(
      `SELECT b.check_in, b.check_out, b.nights, b.rate_type,
              b.total_charged, b.status, b.guest_email,
              s.amp as amp_service
       FROM bookings b
       JOIN spaces s ON s.id = b.space_id
       WHERE s.park_id = $1
         AND b.created_at >= NOW() - INTERVAL '90 days'
         AND b.status IN ('confirmed','checked_in','checked_out')
       ORDER BY b.check_in DESC`,
      [park.id]
    );

    // Get occupancy data
    const { rows: spaces } = await db.query(
      `SELECT COUNT(*) AS total FROM spaces WHERE park_id = $1`, [park.id]
    );
    const totalSpaces = parseInt(spaces[0].total);

    // Calculate stats
    const totalRevenue = bookings.reduce((s, b) => s + Number(b.total_charged || 0), 0);
    const totalNights = bookings.reduce((s, b) => s + (b.nights || 0), 0);
    const avgNightly = bookings.length > 0 ? totalRevenue / Math.max(totalNights, 1) : 0;
    const rateTypes = bookings.reduce((acc, b) => { acc[b.rate_type] = (acc[b.rate_type]||0)+1; return acc; }, {});
    const uniqueGuests = new Set(bookings.map(b => b.guest_email)).size;

    // Build data summary for AI
    const dataSummary = `
Park: ${park.name}
Period: Last 90 days
Total bookings: ${bookings.length}
Total revenue: $${totalRevenue.toFixed(2)}
Total nights booked: ${totalNights}
Average nightly rate: $${avgNightly.toFixed(2)}
Unique guests: ${uniqueGuests}
Total spaces: ${totalSpaces}
Rate type breakdown: ${JSON.stringify(rateTypes)}
Recent bookings sample: ${JSON.stringify(bookings.slice(0,5).map(b => ({
  check_in: b.check_in, nights: b.nights, rate_type: b.rate_type, total: b.total_charged
})))}
    `.trim();

    // Call Anthropic API
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(503).json({ error: "AI reporting not configured" });
    }

    const Anthropic = require("@anthropic-ai/sdk");
    const client = new Anthropic.default();

    const message = await client.messages.create({
      model: "claude-opus-4-5",
      max_tokens: 1024,
      messages: [{
        role: "user",
        content: `You are a friendly business analyst helping an independent RV park owner understand their revenue performance. 
        
Here is their park data for the last 90 days:
${dataSummary}

Write a brief, friendly, plain-English revenue report (4-6 paragraphs) that:
1. Summarizes how the park performed
2. Highlights any positive trends
3. Points out opportunities to improve (e.g. more weeknight bookings, promote monthly stays if nightly dominates)
4. Gives 2-3 specific actionable tips
5. Ends on an encouraging note

Keep it conversational, warm, and helpful. No bullet points — write in paragraphs. Address the owner directly as "you".`
      }]
    });

    const report = message.content[0].text;
    res.json({ report, generated_at: new Date().toISOString(), stats: {
      total_bookings: bookings.length,
      total_revenue: totalRevenue,
      avg_nightly: avgNightly,
      unique_guests: uniqueGuests
    }});

  } catch (err) {
    console.error("AI report error:", err);
    res.status(500).json({ error: "Failed to generate report" });
  }
});

module.exports = router;
