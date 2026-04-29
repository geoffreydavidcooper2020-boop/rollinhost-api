const { Router } = require("express");
const rateLimit = require("express-rate-limit");
const db = require("../db");

const router = Router();

// Stricter rate limit just for ticket submissions — prevents spam abuse
// while still allowing legitimate guests to submit issues.
const ticketSubmitLimit = rateLimit({
  windowMs: 60 * 60 * 1000,  // 1 hour
  max: 10,                    // 10 tickets per IP per hour
  message: { error: "Too many tickets submitted. Please contact the park directly." }
});

// ── POST /tickets ─────────────────────────────────────────────────────────
// PUBLIC endpoint — no auth. Anyone can submit a ticket from the booking site.
// Honeypot field: "website" should always be empty. If a bot fills it, we silently
// accept the submission but don't actually save it.
router.post("/", ticketSubmitLimit, async (req, res) => {
  const {
    park_slug, reporter_name, reporter_email, reporter_phone,
    space_number, category, priority, subject, description,
    photo_urls, source,
    website  // honeypot — humans don't fill this; bots do
  } = req.body;

  // Honeypot check — if this field is filled, it's a bot. Pretend success silently.
  if (website && website.trim() !== "") {
    console.log("Honeypot triggered, dropping ticket from IP:", req.ip);
    return res.status(201).json({ ticket_number: "TKT-PENDING", message: "Submitted" });
  }

  if (!park_slug || !reporter_name || !subject) {
    return res.status(400).json({ error: "Missing required fields: park_slug, reporter_name, subject" });
  }

  if (!reporter_email && !reporter_phone) {
    return res.status(400).json({ error: "Provide either email or phone so we can reach you" });
  }

  const validCategories = ["maintenance", "electrical", "plumbing", "water_sewer",
                           "grounds", "noise", "billing", "safety", "other"];
  const validPriorities = ["low", "normal", "urgent"];

  const cat = validCategories.includes(category) ? category : "maintenance";
  const pri = validPriorities.includes(priority) ? priority : "normal";

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    // Confirm park exists
    const { rows: parkRows } = await client.query(
      `SELECT id, name, sms_ticket_recipients FROM parks WHERE slug = $1`,
      [park_slug]
    );
    if (!parkRows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Park not found" });
    }
    const park = parkRows[0];

    // Generate ticket number — park initials + sequential
    // Get count of existing tickets for this park to compute next number
    const { rows: countRows } = await client.query(
      `SELECT COUNT(*) AS n FROM tickets WHERE park_slug = $1`,
      [park_slug]
    );
    const ticketNum = String(parseInt(countRows[0].n, 10) + 1).padStart(4, "0");
    const initials = park.name.split(/\s+/).map(w => w[0]).join("").toUpperCase().slice(0, 4);
    const ticket_number = `${initials}-T-${ticketNum}`;

    // Try to link to a known tenancy if reporter email matches
    let tenancyId = null;
    if (reporter_email) {
      const { rows: tenRows } = await client.query(
        `SELECT id FROM tenancies
         WHERE park_slug = $1 AND tenant_email = $2 AND status = 'active'
         LIMIT 1`,
        [park_slug, reporter_email.toLowerCase()]
      );
      if (tenRows.length) tenancyId = tenRows[0].id;
    }

    const { rows: ticketRows } = await client.query(
      `INSERT INTO tickets (
         park_slug, ticket_number,
         reporter_name, reporter_email, reporter_phone, space_number,
         tenancy_id, source, category, priority, subject, description, photo_urls, status
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'new')
       RETURNING id, ticket_number, created_at`,
      [
        park_slug, ticket_number,
        reporter_name, reporter_email || null, reporter_phone || null,
        space_number || null,
        tenancyId, source || "public_form", cat, pri, subject, description || null,
        photo_urls && photo_urls.length ? photo_urls : null
      ]
    );

    await client.query("COMMIT");
    console.log(`New ticket ${ticket_number} for ${park_slug}: ${subject}`);

    // Send confirmation email to reporter (best-effort, don't fail the request)
    if (reporter_email && process.env.RESEND_API_KEY && !reporter_email.includes(".local")) {
      try {
        const { Resend } = require("resend");
        const resend = new Resend(process.env.RESEND_API_KEY);
        await resend.emails.send({
          from: process.env.RESEND_FROM_EMAIL || "reservations@rollinhost.com",
          to: reporter_email,
          subject: `Ticket received — ${ticket_number}`,
          html: `
            <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px">
              <h2 style="color:#1a0d04">We got your message, ${reporter_name}!</h2>
              <p>Your ticket has been submitted to <strong>${park.name}</strong>.</p>
              <div style="background:#f5eed8;border-radius:8px;padding:16px;margin:20px 0">
                <p><strong>Ticket #:</strong> ${ticket_number}</p>
                <p><strong>Subject:</strong> ${subject}</p>
                <p><strong>Priority:</strong> ${pri}</p>
              </div>
              <p>Park management will be in touch with you shortly. For urgent issues, please contact the park directly.</p>
              <p style="color:#aaa;font-size:11px;margin-top:24px">Powered by Roll In Host LLC · rollinhost.com</p>
            </div>
          `
        });
      } catch (emailErr) {
        console.error("Ticket confirmation email failed:", emailErr.message);
      }
    }

    // TODO: trigger SMS to park.sms_ticket_recipients once SMS provider is selected

    res.status(201).json({
      ticket_id: ticketRows[0].id,
      ticket_number: ticketRows[0].ticket_number,
      message: "Ticket submitted. The park has been notified and will follow up with you."
    });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Error creating ticket:", err);
    res.status(500).json({ error: "Failed to submit ticket" });
  } finally {
    client.release();
  }
});

// ── GET /tickets?park=mustang-corner&status=new ───────────────────────────
// Dashboard endpoint to list tickets, filterable by status, priority, category
router.get("/", async (req, res) => {
  const { park, status, priority, category } = req.query;
  if (!park) return res.status(400).json({ error: "park (slug) is required" });

  try {
    let query = `SELECT * FROM tickets WHERE park_slug = $1`;
    const params = [park];
    let idx = 2;

    if (status) {
      query += ` AND status = $${idx++}`;
      params.push(status);
    }
    if (priority) {
      query += ` AND priority = $${idx++}`;
      params.push(priority);
    }
    if (category) {
      query += ` AND category = $${idx++}`;
      params.push(category);
    }

    query += ` ORDER BY
                 CASE priority WHEN 'urgent' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
                 created_at DESC`;

    const { rows } = await db.query(query, params);
    res.json(rows);
  } catch (err) {
    console.error("Error listing tickets:", err);
    res.status(500).json({ error: "Failed to list tickets" });
  }
});

// ── GET /tickets/:id ──────────────────────────────────────────────────────
router.get("/:id", async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT * FROM tickets WHERE id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "Ticket not found" });
    res.json(rows[0]);
  } catch (err) {
    console.error("Error fetching ticket:", err);
    res.status(500).json({ error: "Failed to fetch ticket" });
  }
});

// ── PATCH /tickets/:id ────────────────────────────────────────────────────
// Update a ticket — change status, assign, add resolution notes, attach cost
router.patch("/:id", async (req, res) => {
  const allowedFields = [
    "status", "priority", "category", "assigned_to_user_id",
    "resolution_notes", "cost", "cost_billed_to_tenant",
    "subject", "description"
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

  // Auto-set resolved_at when status changes to 'resolved'
  if (req.body.status === "resolved") {
    updates.push(`resolved_at = NOW()`);
  }
  if (req.body.status === "closed") {
    updates.push(`closed_at = NOW()`);
  }

  if (!updates.length) {
    return res.status(400).json({ error: "No valid fields to update" });
  }

  values.push(req.params.id);

  try {
    const { rows } = await db.query(
      `UPDATE tickets SET ${updates.join(", ")} WHERE id = $${paramIndex} RETURNING *`,
      values
    );
    if (!rows.length) return res.status(404).json({ error: "Ticket not found" });
    res.json(rows[0]);
  } catch (err) {
    console.error("Error updating ticket:", err);
    res.status(500).json({ error: "Failed to update ticket" });
  }
});

module.exports = router;
