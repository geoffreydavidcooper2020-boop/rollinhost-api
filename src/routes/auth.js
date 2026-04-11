const { Router } = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const db = require("../db");

const router = Router();

const JWT_SECRET = process.env.JWT_SECRET || "rollinhost-dev-secret-change-in-production";
const JWT_EXPIRES = "24h";

// ── POST /auth/login ──────────────────────────────────────────────────────
// Park owner logs in with slug + password
// Returns a JWT token valid for 24 hours
router.post("/login", async (req, res) => {
  const { park_slug, password } = req.body;
  if (!park_slug || !password) {
    return res.status(400).json({ error: "park_slug and password required" });
  }

  try {
    const { rows } = await db.query(
      `SELECT id, slug, name, password_hash FROM parks WHERE slug = $1`,
      [park_slug]
    );

    if (!rows.length) {
      // Generic error — don't reveal if park exists
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const park = rows[0];

    // If no password hash set yet, use default (park slug) and auto-upgrade
    if (!park.password_hash) {
      // First login — accept the slug as default password and set a hash
      if (password !== park_slug) {
        return res.status(401).json({ error: "Invalid credentials" });
      }
      // Auto-set the hash for next time
      const hash = await bcrypt.hash(password, 12);
      await db.query(
        `UPDATE parks SET password_hash = $1 WHERE id = $2`,
        [hash, park.id]
      ).catch(() => {}); // Don't fail if column doesn't exist yet
    } else {
      // Normal login — verify password against stored hash
      const valid = await bcrypt.compare(password, park.password_hash);
      if (!valid) {
        return res.status(401).json({ error: "Invalid credentials" });
      }
    }

    // Issue JWT
    const token = jwt.sign(
      { park_id: park.id, park_slug: park.slug, park_name: park.name },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES }
    );

    res.json({
      token,
      park_slug: park.slug,
      park_name: park.name,
      expires_in: JWT_EXPIRES
    });

  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Login failed" });
  }
});

// ── POST /auth/verify ─────────────────────────────────────────────────────
// Verify a JWT token is still valid
router.post("/verify", (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: "token required" });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    res.json({ valid: true, park_slug: decoded.park_slug, park_name: decoded.park_name });
  } catch (err) {
    res.status(401).json({ valid: false, error: "Token expired or invalid" });
  }
});

// ── POST /auth/change-password ────────────────────────────────────────────
// Change park owner password — requires valid JWT + current password
router.post("/change-password", async (req, res) => {
  const { token, current_password, new_password } = req.body;
  if (!token || !current_password || !new_password) {
    return res.status(400).json({ error: "token, current_password and new_password required" });
  }
  if (new_password.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters" });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);

    const { rows } = await db.query(
      `SELECT id, slug, password_hash FROM parks WHERE id = $1`,
      [decoded.park_id]
    );
    if (!rows.length) return res.status(404).json({ error: "Park not found" });
    const park = rows[0];

    // Verify current password
    let valid = false;
    if (!park.password_hash) {
      valid = current_password === park.slug;
    } else {
      valid = await bcrypt.compare(current_password, park.password_hash);
    }
    if (!valid) return res.status(401).json({ error: "Current password incorrect" });

    // Hash and store new password
    const hash = await bcrypt.hash(new_password, 12);
    await db.query(
      `UPDATE parks SET password_hash = $1 WHERE id = $2`,
      [hash, park.id]
    );

    res.json({ success: true, message: "Password updated successfully" });
  } catch (err) {
    if (err.name === "JsonWebTokenError" || err.name === "TokenExpiredError") {
      return res.status(401).json({ error: "Invalid or expired token" });
    }
    console.error("Change password error:", err);
    res.status(500).json({ error: "Failed to change password" });
  }
});

module.exports = router;
