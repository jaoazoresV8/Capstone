import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

import pool from "../db.js";
import { authenticateToken } from "../middleware/authMiddleware.js";
import { createRateLimit } from "../middleware/rateLimit.js";
import { logChange } from "../changeLog.js";

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || "dev_secret_change_me";
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "7d";


(async function ensureDefaultAdmin() {
  try {
    const [rows] = await pool.query("SELECT user_id FROM users WHERE username = ? LIMIT 1", ["Admin"]);
    const exists = Array.isArray(rows) && rows.length > 0;
    if (exists) return;
    const passwordHash = await bcrypt.hash("Admin123", await bcrypt.genSalt(10));
    await pool.query(
      `INSERT INTO users (name, username, email, password_hash, role, created_at)
       VALUES (?, ?, ?, ?, 'admin', datetime('now','localtime'))`,
      ["Admin", "Admin", "admin@gmail.com", passwordHash],
    );
    console.log("[auth] Temporary default admin created: username=Admin, password=Admin123");
  } catch (e) {
    console.warn("[auth] ensureDefaultAdmin:", e?.message || e);
  }
})();


function sendJson(res, status, data) {
  if (res.headersSent) return;
  const id = data.user?.id;
  const safe = {
    message: String(data.message ?? ""),
  };
  if (data.token != null) safe.token = String(data.token);
  if (data.user != null) {
    safe.user = {
      id: id != null && !Number.isNaN(Number(id)) ? Number(id) : 0,
      name: String(data.user.name ?? ""),
      username: String(data.user.username ?? ""),
      role: String(data.user.role ?? ""),
    };
    if (data.user.allowed_pages != null) {
      safe.user.allowed_pages = Array.isArray(data.user.allowed_pages)
        ? data.user.allowed_pages
        : [];
    }
  }
  if (data.detail != null) safe.detail = String(data.detail).slice(0, 500);
  try {
    res.status(status).setHeader("Content-Type", "application/json").send(JSON.stringify(safe));
  } catch (_) {}
}

// Generate JWT token
const signToken = (user) => {
  return jwt.sign(
    {
      userId: user.user_id,
      name: user.name,
      username: user.username,
      role: user.role,
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN },
  );
};

// Limit login + forgot-password attempts per IP to reduce brute-force.
const loginLimiter = createRateLimit({ windowMs: 60_000, max: 10 });
const forgotLimiter = createRateLimit({ windowMs: 60_000, max: 5 });

router.post("/register", async (req, res) => {
  try {
    const body = req.body ?? {};
    const { name, username, email, password, role } = body;

    if (!name || !username || !password) {
      return sendJson(res, 400, { message: "Name, username, and password are required." });
    }

    const emailVal = (email || "").toString().trim();
    if (!emailVal) {
      return sendJson(res, 400, { message: "Email is required." });
    }

    const [existingUsername] = await pool.query(
      "SELECT user_id FROM users WHERE username = ? LIMIT 1",
      [username],
    );

    if (existingUsername.length > 0) {
      return sendJson(res, 409, { message: "Username is already taken. Please choose another." });
    }

    const [existingEmail] = await pool.query(
      "SELECT user_id FROM users WHERE email = ? LIMIT 1",
      [emailVal],
    );

    if (existingEmail.length > 0) {
      return sendJson(res, 409, { message: "Email is already registered. Please use another." });
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    const userRole = role && ["admin", "staff"].includes(role) ? role : "staff";

    const [result] = await pool.query(
      `INSERT INTO users (name, username, email, password_hash, role, created_at)
       VALUES (?, ?, ?, ?, ?, datetime('now','localtime'))`,
      [name, username, emailVal, passwordHash, userRole],
    );

    const userId = result?.insertId != null ? Number(result.insertId) : null;
    if (userId == null) {
      throw new Error("Database did not return the new user id.");
    }

    const newUser = {
      user_id: userId,
      name,
      username,
      role: userRole,
    };

    const token = signToken(newUser);

    sendJson(res, 201, {
      message: "Registration successful.",
      token,
      user: { id: userId, name: String(name), username: String(username), role: userRole },
    });
  } catch (error) {
    const msg = error?.message ?? error?.toString?.() ?? "Registration failed.";
    sendJson(res, 500, { message: msg });
  }
});


router.post("/login", loginLimiter, (req, res, next) => {
  const run = async () => {
    try {
      const body = req.body ?? {};
      const { username, password } = body;

      if (!username || !password) {
        return sendJson(res, 400, { message: "Username and password are required." });
      }

      let rows;
      try {
        const result = await pool.query(
          "SELECT user_id, name, username, password_hash, role, allowed_pages FROM users WHERE username = ? LIMIT 1",
          [username],
        );
        rows = Array.isArray(result?.[0]) ? result[0] : result;
      } catch (queryErr) {
        return sendJson(res, 500, { message: queryErr?.message || "Database error." });
      }

      if (!Array.isArray(rows)) {
        return sendJson(res, 500, { message: "Database returned unexpected result." });
      }

      if (rows.length === 0) {
        return sendJson(res, 401, { message: "Invalid username or password." });
      }

      const row = rows[0];
      const get = (obj, ...keys) => {
        if (!obj || typeof obj !== "object") return undefined;
        for (const k of keys) {
          if (obj[k] !== undefined && obj[k] !== null) return obj[k];
          const lower = String(k).toLowerCase();
          const found = Object.keys(obj).find((key) => key.toLowerCase() === lower);
          if (found) return obj[found];
        }
        return undefined;
      };
      const user_id = get(row, "user_id") != null ? Number(get(row, "user_id")) : null;
      const password_hash = get(row, "password_hash") != null ? String(get(row, "password_hash")) : "";
      const name = get(row, "name") != null ? String(get(row, "name")) : "";
      const userName = get(row, "username") != null ? String(get(row, "username")) : "";
      const role = get(row, "role") != null ? String(get(row, "role")) : "staff";
      const allowedPagesRaw = get(row, "allowed_pages");
      const allowed_pages =
        allowedPagesRaw != null && String(allowedPagesRaw).trim() !== ""
          ? String(allowedPagesRaw)
              .split(",")
              .map((p) => p.trim())
              .filter(Boolean)
          : null;

      if (!password_hash) {
        return sendJson(res, 500, { message: "User record is invalid (missing password)." });
      }

      let isMatch = false;
      try {
        isMatch = await bcrypt.compare(password, password_hash);
      } catch (bcryptErr) {
        return sendJson(res, 500, { message: bcryptErr?.message || "Password check failed." });
      }
      if (!isMatch) {
        return sendJson(res, 401, { message: "Invalid username or password." });
      }

      let token;
      const safeUserId = user_id != null && !Number.isNaN(Number(user_id)) ? Number(user_id) : 0;
      try {
        const userForToken = { user_id: safeUserId, name, username: userName, role, allowed_pages };
        token = signToken(userForToken);
      } catch (jwtErr) {
        return sendJson(res, 500, { message: jwtErr?.message || "Token creation failed." });
      }

      sendJson(res, 200, {
        message: "Login successful.",
        token,
        user: { id: safeUserId, name, username: userName, role, allowed_pages },
      });
    } catch (error) {
      const errMsg = error?.message ?? error?.toString?.() ?? String(error);
      if (!res.headersSent) {
        sendJson(res, 500, {
          message: errMsg || "Login failed.",
          ...(error?.stack && { detail: String(error.stack).slice(0, 300) }),
        });
      }
    }
  };
  run().catch((err) => {
    if (!res.headersSent) {
      sendJson(res, 500, {
        message: err?.message ?? err?.toString?.() ?? "Login failed.",
      });
    } else {
      next(err);
    }
  });
});


router.post("/forgot-password", forgotLimiter, async (req, res) => {
  try {
    const username = (req.body?.username || "").toString().trim();
    if (!username) {
      return res.status(400).json({ message: "Username is required." });
    }

    const result = await pool.query(
      "SELECT user_id, username FROM users WHERE username = ? LIMIT 1",
      [username],
    );
    const rows = Array.isArray(result?.[0]) ? result[0] : result;
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.json({
        message: "If the username exists, a reset request has been sent to the admin.",
      });
    }

    const user = rows[0];
    const userId = user.user_id ?? user.USER_ID;
    const uname = user.username ?? user.USERNAME;

    const existingResult = await pool.query(
      "SELECT request_id FROM password_reset_requests WHERE user_id = ? AND status = 'pending' LIMIT 1",
      [userId],
    );
    const existing = Array.isArray(existingResult?.[0]) ? existingResult[0] : existingResult;
    let requestId = null;

    if (!Array.isArray(existing) || existing.length === 0) {
      const [insertResult] = await pool.query(
        `INSERT INTO password_reset_requests (user_id, username, requested_at, status)
         VALUES (?, ?, datetime('now','localtime'), 'pending')`,
        [userId, uname],
      );
      requestId = insertResult.insertId;
    } else {
      requestId = existing[0].request_id ?? existing[0].REQUEST_ID ?? null;
    }

    // Log for central sync so admins in central see the request.
    if (requestId != null) {
      await logChange("password_reset", requestId, "create", {
        id: requestId,
        user_id: userId,
        username: uname,
        status: "pending",
      });
    }

    return res.json({
      message: "If the username exists, a reset request has been sent to the admin.",
    });
  } catch (error) {
    const msg = error?.message ?? error?.toString?.() ?? "Request failed.";
    if (!res.headersSent) sendJson(res, 500, { message: msg });
  }
});

// POST /api/auth/admin/verify-password
// Lightweight password gate for sensitive admin actions from staff UI.
router.post("/admin/verify-password", authenticateToken, async (req, res) => {
  try {
    const adminPassword = req.body?.admin_password ?? req.body?.password ?? "";
    if (typeof adminPassword !== "string" || !adminPassword.trim()) {
      return res.status(400).json({ message: "Admin password is required." });
    }

    const [rows] = await pool.query(
      "SELECT user_id, name, username, password_hash FROM users WHERE role = 'admin'",
      []
    );
    const admins = Array.isArray(rows) ? rows : [];

    for (const row of admins) {
      if (!row?.password_hash) continue;
      // eslint-disable-next-line no-await-in-loop
      const ok = await bcrypt.compare(String(adminPassword).trim(), row.password_hash);
      if (ok) return res.json({ ok: true });
    }

    return res.status(401).json({ message: "Invalid admin password." });
  } catch (err) {
    console.error("POST /api/auth/admin/verify-password:", err);
    return res.status(500).json({ message: "Failed to verify admin password." });
  }
});


router.get("/me", authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.userId ?? req.user?.user_id;
    if (userId == null) {
      return res.status(401).json({ message: "Invalid token." });
    }
    const [rows] = await pool.query(
      "SELECT user_id AS id, name, username, role, allowed_pages FROM users WHERE user_id = ? LIMIT 1",
      [userId],
    );
    if (!rows || rows.length === 0) {
      return res.status(401).json({ message: "User not found." });
    }
    const row = rows[0];
    const allowedPagesRaw = row.allowed_pages;
    const allowed_pages =
      allowedPagesRaw != null && String(allowedPagesRaw).trim() !== ""
        ? String(allowedPagesRaw).split(",").map((p) => p.trim()).filter(Boolean)
        : null;
    const user = {
      id: row.id,
      name: row.name,
      username: row.username,
      role: row.role,
      allowed_pages,
    };
    return res.json({ user });
  } catch (err) {
    console.error("GET /me:", err?.message);
    return res.status(500).json({ message: "Failed to load profile." });
  }
});

export default router;

