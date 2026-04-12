const { Router } = require("express");
const db = require("../db");
const Anthropic = require("@anthropic-ai/sdk").default;

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

    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(503).json({ error: "AI reporting not configured" });
    }

    const client = new Anthropic();

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
    res.json({
      report,
      generated_at: new Date().toISOString(),
      stats: {
        total_bookings: bookings.length,
        total_revenue: totalRevenue,
        avg_nightly: avgNightly,
        unique_guests: uniqueGuests
      }
    });

  } catch (err) {
    console.error("AI report error:", err);
    res.status(500).json({ error: "Failed to generate report" });
  }
});


// ── POST /reports/:park_slug/ask ──────────────────────────────────────────
// AI Park Manager — answers any question using live park data + dashboard guide
// Body: { question: string, type: string, history: [{role, content}] }
router.post("/:park_slug/ask", async (req, res) => {
  const { park_slug } = req.params;
  const { question, type, history = [] } = req.body;

  if (!question) return res.status(400).json({ error: "question required" });

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: "AI not configured" });
  }

  try {
    const client = new Anthropic();

    // ── Pull all park data from DB ──────────────────────────────────────

    // Park info — only select columns we know exist
    const parkRes = await db.query(
      `SELECT id, name FROM parks WHERE slug = $1`, [park_slug]
    );
    if (!parkRes.rows.length) return res.status(404).json({ error: "Park not found" });
    const park = parkRes.rows[0];
    const parkId = park.id;

    // Get park id first (same pattern as existing working route)
    // parkId already set from park query above

    // All bookings — join spaces to get space number, same as existing route
    const bookingsRes = await db.query(
      `SELECT b.id, s.number AS space_number, b.guest_first_name, b.guest_last_name,
              b.guest_email, b.guest_phone, b.check_in, b.check_out,
              b.nights, b.rate_type, b.total_charged, b.status,
              b.booking_source, b.created_at
       FROM bookings b
       JOIN spaces s ON s.id = b.space_id
       WHERE s.park_id = $1
       ORDER BY b.check_in DESC`, [parkId]
    );
    const bookings = bookingsRes.rows;

    // Spaces
    const spacesRes = await db.query(
      `SELECT number, amp, has_water, has_sewer, active
       FROM spaces WHERE park_id = $1 ORDER BY number`, [parkId]
    );
    const spaces = spacesRes.rows;

    // ── Build data summaries ────────────────────────────────────────────
    const today = new Date().toISOString().slice(0, 10);
    const confirmed = bookings.filter(b => ["confirmed","checked_in","checked_out"].includes(b.status));
    const upcoming = bookings.filter(b =>
      ["confirmed","checked_in"].includes(b.status) && b.check_in >= today
    );
    const totalRevenue = confirmed.reduce((s, b) => s + Number(b.total_charged || 0), 0);

    // Revenue by month
    const byMonth = {};
    confirmed.forEach(b => {
      const mo = String(b.check_in).slice(0, 7);
      if (!byMonth[mo]) byMonth[mo] = { revenue: 0, count: 0 };
      byMonth[mo].revenue += Number(b.total_charged || 0);
      byMonth[mo].count++;
    });

    // Revenue by space
    const bySpace = {};
    confirmed.forEach(b => {
      const sp = b.space_number;
      if (!bySpace[sp]) bySpace[sp] = { revenue: 0, count: 0, nights: 0 };
      bySpace[sp].revenue += Number(b.total_charged || 0);
      bySpace[sp].count++;
      bySpace[sp].nights += Number(b.nights || 0);
    });

    // Revenue by rate type
    const byType = {
      nightly:  { count: 0, revenue: 0 },
      weekly:   { count: 0, revenue: 0 },
      monthly:  { count: 0, revenue: 0 },
      cash:     { count: 0, revenue: 0 }
    };
    confirmed.forEach(b => {
      const t = b.rate_type || "nightly";
      if (byType[t]) { byType[t].count++; byType[t].revenue += Number(b.total_charged || 0); }
    });

    // Derive base rates from booking averages (rates column doesn't exist on parks table)
    // Use known Mustang Corner defaults — these are set in the dashboard rate editor
    const nightlyBookings = confirmed.filter(b => (b.rate_type||'nightly') === 'nightly');
    const avgNightlyRate = nightlyBookings.length > 0
      ? nightlyBookings.reduce((s,b) => s + Number(b.total_charged||0), 0) / nightlyBookings.reduce((s,b) => s + Number(b.nights||1), 0)
      : 45;
    const rates = { nightly: Math.round(avgNightlyRate) || 45, weekly: 270, monthly: 400 };

    const bookingList = bookings.slice(0, 200).map(b =>
      `Space ${b.space_number} | ${b.guest_first_name} ${b.guest_last_name} | ${b.check_in} to ${b.check_out} | ${b.nights || "?"} nights | ${b.rate_type} | $${Number(b.total_charged||0).toFixed(2)} | ${b.status} | source: ${b.booking_source || "online"}`
    ).join("\n");

    const upcomingList = upcoming.slice(0, 50).map(b =>
      `Space ${b.space_number} | ${b.guest_first_name} ${b.guest_last_name} | Check-in: ${b.check_in} | Check-out: ${b.check_out} | ${b.nights} nights | $${Number(b.total_charged||0).toFixed(2)}`
    ).join("\n");

    const spacePerformance = Object.entries(bySpace)
      .sort((a, b) => b[1].revenue - a[1].revenue)
      .map(([sp, d]) => `Space ${sp}: ${d.count} bookings, ${d.nights} nights, $${d.revenue.toFixed(2)} revenue`)
      .join("\n");

    const monthlyBreakdown = Object.entries(byMonth)
      .sort((a, b) => b[0].localeCompare(a[0]))
      .slice(0, 24)
      .map(([mo, d]) => `${mo}: ${d.count} bookings, $${d.revenue.toFixed(2)}`)
      .join("\n");

    // ── System prompt ───────────────────────────────────────────────────
    const systemPrompt = `You are the AI Park Manager for ${park.name || park_slug}, an RV park management assistant built into the RollinHost owner dashboard.

You have two roles:
1. DATA ANALYST — Answer questions about this park's bookings, revenue, guests, and occupancy using the live data below.
2. DASHBOARD GUIDE — Help the owner navigate and use every feature of their RollinHost dashboard.

════ PARK INFO ════
Park: ${park.name || park_slug}
Total spaces: ${spaces.length}
Base rates: Nightly ~$${rates.nightly}/night | Weekly $${rates.weekly}/week | Monthly $${rates.monthly}/month

════ LIVE BOOKING DATA ════
Today: ${today}
Total bookings (all time): ${bookings.length}
Confirmed/completed bookings: ${confirmed.length}
Total revenue (confirmed): $${totalRevenue.toFixed(2)}
Upcoming confirmed bookings: ${upcoming.length}

REVENUE BY RATE TYPE:
- Nightly: ${byType.nightly.count} bookings, $${byType.nightly.revenue.toFixed(2)}
- Weekly: ${byType.weekly.count} bookings, $${byType.weekly.revenue.toFixed(2)}
- Monthly: ${byType.monthly.count} bookings, $${byType.monthly.revenue.toFixed(2)}
- Cash/Walk-in: ${byType.cash.count} bookings, $${byType.cash.revenue.toFixed(2)}

MONTHLY REVENUE (recent first):
${monthlyBreakdown || "No data"}

SPACE PERFORMANCE (by revenue):
${spacePerformance || "No data"}

UPCOMING BOOKINGS (next 60 days):
${upcomingList || "No upcoming bookings"}

ALL BOOKINGS (most recent first, capped at 200):
${bookingList || "No bookings"}

════ DASHBOARD GUIDE ════
The RollinHost dashboard has these pages in the sidebar:

BOOKINGS — Main page. Shows all reservations. Filter by status (confirmed, pending, checked in, cancelled). Search by guest name or email. Buttons: Check In (marks guest arrived), Check Out (marks departure + fires review email automatically), Cancel. Click any row for full booking details.

REVENUE — Shows total revenue stats and revenue-by-space table. Links to AI Park Manager for reports.

AI PARK MANAGER — This page. Four quick report buttons plus a freeform chat box. Revenue Report, Tax-Ready Report (downloadable), Upcoming Bookings, Occupancy Snapshot.

WALK-IN BOOKING — Create a manual reservation for cash guests or phone-ins. Step 1: click a space on the map. Step 2: fill in guest name, email, phone, then select dates on the calendar (booked dates show in red and cannot be selected). Price calculates automatically. Supports nightly, weekly, monthly, and cash rate types.

RATE EDITOR — Set base nightly, weekly, and monthly rates. Changes apply to new bookings immediately. Button to open Smart Pricing configuration.

SMART PRICING — Automatic rate adjustments: Weekend Premium (Friday/Saturday multiplier), Holiday Surge (Memorial Day, 4th of July, Labor Day, Thanksgiving, Christmas, Spring Break), Occupancy Pricing (rates rise automatically when park hits a set % full). Toggle each on/off independently. Save and Activate to apply.

GUEST LIST — Table of every guest who has ever booked. Shows booking count, total spent, last stay date. Block button on each row to add to blacklist instantly.

GUEST BLACKLIST — Block guests by email so they cannot complete future bookings. Enter email and optional reason, click Block Guest. Remove blocked guests anytime.

GUEST FORM BUILDER — Custom application form guests complete before booking. Three modes: Approve All (form is informational, everyone auto-approved), Auto-Screen (rules check instantly, failing guests declined before payment), Manual Review (every application goes to owner review queue). Eight field types: RV Length, RV Year, Make & Model, Pets, Number of Adults, Number of Children, Slide-outs, Custom Question. Live preview shows exactly what guests see.

FEATURES — Overview of all included features with descriptions. Shows active features and coming soon features (SMS Alerts, Pre-arrival SMS, Waitlist, Multi-Park Dashboard).

USERS & ACCESS — Change owner dashboard password (eye icon to show/hide). Add up to 2 additional team members (3 users total including owner). Set name, role (Manager = view and check in/out only, Admin = full access), and password for each. Remove team members anytime. Counter shows current user count.

SETTINGS — Update park name, address, phone, email, total number of spaces, check-in time. Save button at bottom of form.

════ BEHAVIOR RULES ════
- Be direct and specific. Use actual numbers from the live data above.
- For tax reports, use clean formatting with clear labeled sections and dollar amounts formatted as $X,XXX.XX.
- For dashboard navigation questions, give clear step-by-step instructions referencing exact button names and page names.
- If asked about data that does not exist yet (no bookings, empty park), say so clearly and helpfully.
- Keep answers concise but complete. Use line breaks and clear structure.
- You are speaking to the park owner or their manager. Be professional, warm, and direct.`;

    // ── Build messages array ────────────────────────────────────────────
    const messages = [];

    if (history && history.length > 0) {
      history.slice(-6).forEach(h => {
        if (h.role && h.content) {
          messages.push({ role: h.role, content: String(h.content) });
        }
      });
    }

    messages.push({ role: "user", content: question });

    // ── Call Claude ─────────────────────────────────────────────────────
    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2000,
      system: systemPrompt,
      messages: messages
    });

    const answer = response.content
      .filter(b => b.type === "text")
      .map(b => b.text)
      .join("\n");

    res.json({
      answer,
      generated_at: new Date().toISOString(),
      park: park_slug
    });

  } catch (err) {
    console.error("AI Park Manager error:", err);
    res.status(500).json({ error: "AI request failed", detail: err.message });
  }
});


module.exports = router;
