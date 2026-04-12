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

// ════════════════════════════════════════════════════════════════════════
// ADD THIS TO: src/routes/reports.js
// Place it after your existing ai-revenue route
// ════════════════════════════════════════════════════════════════════════

const Anthropic = require('@anthropic-ai/sdk');

// POST /reports/:park_slug/ask
// Body: { question: string, type: string, history: [{role, content}] }
router.post('/:park_slug/ask', async (req, res) => {
  const { park_slug } = req.params;
  const { question, type, history = [] } = req.body;

  if (!question) return res.status(400).json({ error: 'question required' });

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    // ── Pull all park data from DB ──────────────────────────────────────
    const db = req.db || require('../db');

    // Park info
    const parkRes = await db.query(
      `SELECT name, address, phone, email, rates, addons, guest_form_config
       FROM parks WHERE slug = $1`, [park_slug]
    );
    if (!parkRes.rows.length) return res.status(404).json({ error: 'Park not found' });
    const park = parkRes.rows[0];

    // All bookings
    const bookingsRes = await db.query(
      `SELECT b.id, b.space_number, b.guest_first_name, b.guest_last_name,
              b.guest_email, b.guest_phone, b.check_in, b.check_out,
              b.nights, b.rate_type, b.total_charged, b.status,
              b.booking_source, b.created_at
       FROM bookings b
       JOIN parks p ON b.park_id = p.id
       WHERE p.slug = $1
       ORDER BY b.check_in DESC`, [park_slug]
    );
    const bookings = bookingsRes.rows;

    // Spaces
    const spacesRes = await db.query(
      `SELECT s.number, s.amp_service, s.has_water, s.has_sewer, s.active
       FROM spaces s
       JOIN parks p ON s.park_id = p.id
       WHERE p.slug = $1 ORDER BY s.number`, [park_slug]
    );
    const spaces = spacesRes.rows;

    // ── Build data summary for Claude ───────────────────────────────────
    const today = new Date().toISOString().slice(0, 10);
    const confirmed = bookings.filter(b => ['confirmed','checked_in','checked_out'].includes(b.status));
    const upcoming = bookings.filter(b =>
      ['confirmed','checked_in'].includes(b.status) && b.check_in >= today
    );
    const totalRevenue = confirmed.reduce((s, b) => s + Number(b.total_charged || 0), 0);

    // Revenue by month (last 12 months)
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
    const byType = { nightly: { count: 0, revenue: 0 }, weekly: { count: 0, revenue: 0 }, monthly: { count: 0, revenue: 0 }, cash: { count: 0, revenue: 0 } };
    confirmed.forEach(b => {
      const t = b.rate_type || 'nightly';
      if (byType[t]) { byType[t].count++; byType[t].revenue += Number(b.total_charged || 0); }
    });

    const rates = park.rates || {};

    // Format booking list for context (cap at 200 to keep tokens reasonable)
    const bookingList = bookings.slice(0, 200).map(b =>
      `Space ${b.space_number} | ${b.guest_first_name} ${b.guest_last_name} | ${b.check_in} to ${b.check_out} | ${b.nights || '?'} nights | ${b.rate_type} | $${Number(b.total_charged||0).toFixed(2)} | ${b.status} | source: ${b.booking_source || 'online'}`
    ).join('\n');

    const upcomingList = upcoming.slice(0, 50).map(b =>
      `Space ${b.space_number} | ${b.guest_first_name} ${b.guest_last_name} | Check-in: ${b.check_in} | Check-out: ${b.check_out} | ${b.nights} nights | $${Number(b.total_charged||0).toFixed(2)}`
    ).join('\n');

    const spacePerformance = Object.entries(bySpace)
      .sort((a, b) => b[1].revenue - a[1].revenue)
      .map(([sp, d]) => `Space ${sp}: ${d.count} bookings, ${d.nights} nights, $${d.revenue.toFixed(2)} revenue`)
      .join('\n');

    const monthlyBreakdown = Object.entries(byMonth)
      .sort((a, b) => b[0].localeCompare(a[0]))
      .slice(0, 24)
      .map(([mo, d]) => `${mo}: ${d.count} bookings, $${d.revenue.toFixed(2)}`)
      .join('\n');

    // ── System prompt ────────────────────────────────────────────────────
    const systemPrompt = `You are the AI Park Manager for ${park.name || park_slug}, an RV park management assistant built into the RollinHost owner dashboard.

You have two roles:
1. DATA ANALYST — Answer questions about this park's bookings, revenue, guests, and occupancy using the live data below.
2. DASHBOARD GUIDE — Help the owner navigate and use every feature of their RollinHost dashboard.

════ PARK INFO ════
Park: ${park.name || park_slug}
Address: ${park.address || 'Not set'}
Total spaces: ${spaces.length}
Base rates: Nightly $${rates.nightly || 45}/night | Weekly $${rates.weekly || 270}/week | Monthly $${rates.monthly || 400}/month

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
${monthlyBreakdown || 'No data'}

SPACE PERFORMANCE (by revenue):
${spacePerformance || 'No data'}

UPCOMING BOOKINGS (next 60 days):
${upcomingList || 'No upcoming bookings'}

ALL BOOKINGS (most recent first, capped at 200):
${bookingList || 'No bookings'}

════ DASHBOARD GUIDE ════
The RollinHost dashboard has these pages in the sidebar:

BOOKINGS — Main page. Shows all reservations. Filter by status (confirmed, pending, checked in, cancelled). Search by guest name or email. Buttons: Check In (marks guest arrived), Check Out (marks departure + fires review email), Cancel. Click any row for full booking details.

REVENUE — Shows total revenue stats and revenue-by-space table. Links to AI Park Manager for reports.

AI PARK MANAGER — This page. Quick report buttons + freeform chat.

WALK-IN BOOKING — Create a manual reservation. Step 1: click a space on the map. Step 2: fill in guest info and select dates on the calendar (booked dates are shown in red and cannot be selected). Calculates price automatically. Supports nightly, weekly, monthly, and cash rate types.

RATE EDITOR — Set base nightly, weekly, and monthly rates. Changes apply to new bookings immediately. Also has a button to go to Smart Pricing configuration.

SMART PRICING — Configure automatic rate adjustments: Weekend Premium (Friday/Saturday multiplier), Holiday Surge (6 major RV holidays auto-detected), Occupancy Pricing (rates rise when park hits a % threshold). Toggle each on/off. Save & Activate to apply.

GUEST LIST — Table of all guests who have ever booked. Shows booking count, total spent, last stay. Block button to add to blacklist instantly.

GUEST BLACKLIST — Add guest emails to block them from completing future bookings. Enter email + optional reason, click Block Guest. Remove anytime.

GUEST FORM BUILDER — Build a custom application form guests complete before booking. Three modes: Approve All (informational only), Auto-Screen (rules-based instant decisions), Manual Review (every application goes to your queue). Eight field types: RV Length, RV Year, Make & Model, Pets, Adults, Children, Slide-outs, Custom Question. Live preview shows exactly what guests will see.

FEATURES — Overview of all included features: Walk-in Booking, Guest Screening, Smart Pricing, Guest Blacklist, Returning Guest Discount, AI Revenue Report, Review Request Email, Multi-User Access. Also shows Coming Soon features: SMS Alerts, Pre-arrival SMS, Waitlist, Multi-Park Dashboard.

USERS & ACCESS — Change your dashboard password. Add up to 2 additional team members (3 total including owner). Each gets name, role (Manager or Admin), and their own password. Remove users anytime.

SETTINGS — Update park name, address, phone, email, total spaces, check-in time.

════ BEHAVIOR RULES ════
- Be direct and specific. Use actual numbers from the data above.
- For tax reports, format cleanly with clear sections and dollar amounts.
- For navigation questions, give step-by-step instructions.
- If asked about data you don't have, say so clearly rather than guessing.
- Keep answers concise but complete. Use line breaks and structure for readability.
- You are talking to the park owner, not a guest. Be professional but friendly.`;

    // ── Build messages ───────────────────────────────────────────────────
    const messages = [];

    // Include recent chat history if provided
    if (history && history.length > 0) {
      history.slice(-6).forEach(h => {
        if (h.role && h.content) {
          messages.push({ role: h.role, content: String(h.content) });
        }
      });
    }

    // Add the current question
    messages.push({ role: 'user', content: question });

    // ── Call Claude ──────────────────────────────────────────────────────
    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      system: systemPrompt,
      messages: messages
    });

    const answer = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n');

    res.json({
      answer,
      generated_at: new Date().toISOString(),
      park: park_slug
    });

  } catch (err) {
    console.error('AI Park Manager error:', err);
    res.status(500).json({ error: 'AI request failed', detail: err.message });
  }
});

module.exports = router;
