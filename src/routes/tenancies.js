const { Router } = require("express");
const db = require("../db");

const router = Router();

// ── POST /tenancies ───────────────────────────────────────────────────────
// Submit a long-term application. Creates a tenancy in 'pending' status.
// This is the public-facing endpoint that the long-term application form posts to.
router.post("/", async (req, res) => {
  console.log("Received tenancy application:", JSON.stringify(req.body));
  const {
    park_slug, space_number,
    tenant_first_name, tenant_last_name, tenant_email, tenant_phone,
    tenant_address, tenant_dl_number, tenant_dl_state,
    cotenant_first_name, cotenant_last_name, cotenant_email, cotenant_phone,
    additional_occupants,
    rv_make, rv_model, rv_year, rv_length, rv_license_plate, rv_license_state,
    has_pets, pet_details,
    vehicle_count, has_boat,
    requested_start_date,
  } = req.body;

  if (!park_slug || !space_number || !tenant_first_name || !tenant_last_name ||
      !tenant_email || !tenant_phone) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    // Look up park to get monthly_rent default
    const { rows: parkRows } = await client.query(
      `SELECT id, name, rate_monthly, electric_rate_per_kwh
       FROM parks WHERE slug = $1`,
      [park_slug]
    );
    if (!parkRows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Park not found" });
    }
    const park = parkRows[0];

    // Look up space (to get space_id)
    const { rows: spaceRows } = await client.query(
      `SELECT id, status FROM spaces WHERE park_id = $1 AND number = $2`,
      [park.id, parseInt(space_number, 10)]
    );
    if (!spaceRows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Space not found" });
    }
    const space = spaceRows[0];

    // Check space isn't already leased
    if (space.status === "leased") {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Space is already under a long-term lease" });
    }

    // Check blacklist (same protection as bookings)
    try {
      const { rows: blacklisted } = await client.query(
        `SELECT id FROM blacklist WHERE park_id = $1 AND email = $2`,
        [park.id, (tenant_email || "").toLowerCase()]
      );
      if (blacklisted.length > 0) {
        await client.query("ROLLBACK");
        return res.status(403).json({ error: "Unable to process application. Please contact the park directly." });
      }
    } catch(e) { /* blacklist may not exist yet — fail open */ }

    const monthlyRent = Number(park.rate_monthly) || 400;
    const electricRate = Number(park.electric_rate_per_kwh) || null;

    // Create tenancy in 'pending' status
    const { rows: tenancyRows } = await client.query(
      `INSERT INTO tenancies (
         park_slug, space_id, space_number,
         tenant_first_name, tenant_last_name, tenant_email, tenant_phone,
         tenant_address, tenant_dl_number, tenant_dl_state,
         cotenant_first_name, cotenant_last_name, cotenant_email, cotenant_phone,
         additional_occupants,
         rv_make, rv_model, rv_year, rv_length, rv_license_plate, rv_license_state,
         has_pets, pet_details,
         vehicle_count, has_boat,
         start_date,
         monthly_rent, security_deposit, electric_rate_per_kwh,
         status
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,
         $22,$23,$24,$25,$26,$27,$28,$29,'pending'
       )
       RETURNING id, created_at`,
      [
        park_slug, space.id, String(space_number),
        tenant_first_name, tenant_last_name, tenant_email, tenant_phone,
        tenant_address || null, tenant_dl_number || null, tenant_dl_state || null,
        cotenant_first_name || null, cotenant_last_name || null, cotenant_email || null, cotenant_phone || null,
        additional_occupants || null,
        rv_make || null, rv_model || null, rv_year || null, rv_length || null,
        rv_license_plate || null, rv_license_state || null,
        has_pets || false, pet_details || null,
        vehicle_count || 1, has_boat || false,
        requested_start_date || null,
        monthlyRent, 0, electricRate
      ]
    );

    await client.query("COMMIT");
    console.log(`New tenancy application: ${tenancyRows[0].id} for ${park_slug} space ${space_number}`);

    res.status(201).json({
      tenancy_id: tenancyRows[0].id,
      status: "pending",
      message: "Application submitted. The park will review and contact you within 1-2 business days."
    });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Error creating tenancy:", err);
    res.status(500).json({ error: "Failed to submit application" });
  } finally {
    client.release();
  }
});

// ── GET /tenancies?park=mustang-corner ────────────────────────────────────
// List all tenancies for a park (dashboard view)
router.get("/", async (req, res) => {
  const { park, status } = req.query;
  if (!park) return res.status(400).json({ error: "park (slug) is required" });

  try {
    let query = `SELECT * FROM tenancies WHERE park_slug = $1`;
    const params = [park];

    if (status) {
      query += ` AND status = $2`;
      params.push(status);
    }

    query += ` ORDER BY created_at DESC`;

    const { rows } = await db.query(query, params);
    res.json(rows);
  } catch (err) {
    console.error("Error listing tenancies:", err);
    res.status(500).json({ error: "Failed to list tenancies" });
  }
});

// ── GET /tenancies/:id ────────────────────────────────────────────────────
// Get a single tenancy with all its details
router.get("/:id", async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT * FROM tenancies WHERE id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "Tenancy not found" });
    res.json(rows[0]);
  } catch (err) {
    console.error("Error fetching tenancy:", err);
    res.status(500).json({ error: "Failed to fetch tenancy" });
  }
});

// ── PATCH /tenancies/:id ──────────────────────────────────────────────────
// Update a tenancy (approve, deny, set move-in date, etc.)
// Used by the dashboard to advance applications through the workflow.
router.patch("/:id", async (req, res) => {
  const allowedFields = [
    "status", "background_check_status", "background_check_notes",
    "monthly_rent", "security_deposit", "pet_deposit", "pet_monthly_rent",
    "electric_rate_per_kwh",
    "start_date", "end_date", "move_in_date", "move_out_date",
    "is_month_to_month",
    "stripe_customer_id", "stripe_subscription_id", "payment_method_type",
    "notes"
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
      `UPDATE tenancies SET ${updates.join(", ")} WHERE id = $${paramIndex} RETURNING *`,
      values
    );
    if (!rows.length) return res.status(404).json({ error: "Tenancy not found" });

    // If status changed to 'active' and move_in_date set, mark space as leased
    if (req.body.status === "active" && rows[0].move_in_date) {
      await db.query(
        `UPDATE spaces SET status = 'leased', current_tenancy_id = $1 WHERE id = $2`,
        [rows[0].id, rows[0].space_id]
      );
      console.log(`Space ${rows[0].space_id} marked as leased for tenancy ${rows[0].id}`);
    }

    // If status changed to 'ended' or 'evicted', free the space
    if (["ended", "evicted"].includes(req.body.status)) {
      await db.query(
        `UPDATE spaces SET status = 'available', current_tenancy_id = NULL WHERE id = $1`,
        [rows[0].space_id]
      );
      console.log(`Space ${rows[0].space_id} freed from tenancy ${rows[0].id}`);
    }

    res.json(rows[0]);
  } catch (err) {
    console.error("Error updating tenancy:", err);
    res.status(500).json({ error: "Failed to update tenancy" });
  }
});

// ── POST /tenancies/:id/sign ──────────────────────────────────────────────
// Record a signed agreement (lease, waiver, addendum) against a tenancy.
// Captures the document snapshot, signature, IP, and version for legal record.
router.post("/:id/sign", async (req, res) => {
  const {
    agreement_type, document_title, document_text, document_version,
    signer_email, signer_name, signed_name, is_co_signer
  } = req.body;

  if (!agreement_type || !document_title || !document_text || !document_version ||
      !signer_email || !signer_name || !signed_name) {
    return res.status(400).json({ error: "Missing required fields for signature" });
  }

  const validTypes = ["short_waiver", "long_lease", "long_waiver",
                      "pet_addendum", "crime_free_addendum", "rules_acknowledgement"];
  if (!validTypes.includes(agreement_type)) {
    return res.status(400).json({ error: "Invalid agreement_type" });
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    // Confirm tenancy exists
    const { rows: tenancyRows } = await client.query(
      `SELECT id, park_slug FROM tenancies WHERE id = $1`,
      [req.params.id]
    );
    if (!tenancyRows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Tenancy not found" });
    }
    const tenancy = tenancyRows[0];

    // Capture IP and user agent for legal proof
    const ip = req.ip || req.headers["x-forwarded-for"] || req.connection.remoteAddress;
    const userAgent = req.headers["user-agent"] || null;

    const { rows: agreementRows } = await client.query(
      `INSERT INTO agreements (
         park_slug, agreement_type, tenancy_id,
         signer_email, signer_name, signed_name, is_co_signer,
         document_title, document_text, document_version,
         ip_address, user_agent
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING id, signed_at`,
      [
        tenancy.park_slug, agreement_type, tenancy.id,
        signer_email, signer_name, signed_name, is_co_signer || false,
        document_title, document_text, document_version,
        ip, userAgent
      ]
    );

    await client.query("COMMIT");
    console.log(`Agreement signed: ${agreement_type} for tenancy ${tenancy.id} by ${signer_email}`);

    res.status(201).json({
      agreement_id: agreementRows[0].id,
      signed_at: agreementRows[0].signed_at,
      message: "Agreement signed and recorded"
    });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Error signing agreement:", err);
    res.status(500).json({ error: "Failed to record signature" });
  } finally {
    client.release();
  }
});

// ── GET /tenancies/:id/agreements ─────────────────────────────────────────
// List all signed agreements for a tenancy
router.get("/:id/agreements", async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, agreement_type, document_title, document_version,
              signer_email, signer_name, signed_name, is_co_signer,
              ip_address, signed_at, pdf_url
       FROM agreements
       WHERE tenancy_id = $1
       ORDER BY signed_at DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    console.error("Error listing agreements:", err);
    res.status(500).json({ error: "Failed to list agreements" });
  }
});

module.exports = router;
