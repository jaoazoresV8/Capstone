import express from "express";
import bcrypt from "bcryptjs";

import pool from "../db.js";
import { authenticateToken, requireAdmin } from "../middleware/authMiddleware.js";

const router = express.Router();

router.use(authenticateToken, requireAdmin);

// GET /api/users - list all users (basic info only)
router.get("/", async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT user_id AS id, name, username, email, role, allowed_pages, created_at FROM users ORDER BY created_at DESC",
    );
    const users = (rows || []).map((u) => ({
      ...u,
      allowed_pages: u.allowed_pages != null && String(u.allowed_pages).trim() !== "" ? String(u.allowed_pages).split(",").map((p) => p.trim()).filter(Boolean) : null,
    }));
    return res.json({ users });
  } catch (error) {
    console.error("Error in GET /api/users:", error);
    return res.status(500).json({ message: "Failed to load users." });
  }
});

// POST /api/users - create new user
router.post("/", async (req, res) => {
  try {
    const { name, username, email, password, role, allowed_pages } = req.body;

    if (!name || !username || !password) {
      return res
        .status(400)
        .json({ message: "Name, username, and password are required." });
    }

    const [existing] = await pool.query(
      "SELECT user_id FROM users WHERE username = ? LIMIT 1",
      [username],
    );
    if (existing.length > 0) {
      return res
        .status(409)
        .json({ message: "Username is already taken. Please choose another." });
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    const userRole = role && ["admin", "staff"].includes(role) ? role : "staff";
    const allowedPagesStr =
      Array.isArray(allowed_pages) && allowed_pages.length > 0
        ? allowed_pages.map((p) => String(p).trim()).filter(Boolean).join(",")
        : null;

    const [result] = await pool.query(
      `INSERT INTO users (name, username, email, password_hash, role, allowed_pages, created_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now','localtime'))`,
      [name, username, email || null, passwordHash, userRole, allowedPagesStr],
    );

    return res.status(201).json({
      user: {
        id: result.insertId,
        name,
        username,
        email: email || null,
        role: userRole,
        allowed_pages: allowed_pages && allowed_pages.length > 0 ? allowed_pages : null,
      },
    });
  } catch (error) {
    console.error("Error in POST /api/users:", error);
    return res.status(500).json({ message: "Failed to create user." });
  }
});

// PUT /api/users/:id - update user info (and optionally password)
router.put("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { name, username, email, role, password, allowed_pages } = req.body;

    if (!name || !username) {
      return res
        .status(400)
        .json({ message: "Name and username are required." });
    }

    const [existing] = await pool.query(
      "SELECT user_id FROM users WHERE username = ? AND user_id <> ? LIMIT 1",
      [username, id],
    );
    if (existing.length > 0) {
      return res
        .status(409)
        .json({ message: "Username is already taken by another user." });
    }

    const userRole = role && ["admin", "staff"].includes(role) ? role : "staff";
    const allowedPagesStr =
      Array.isArray(allowed_pages) && allowed_pages.length > 0
        ? allowed_pages.map((p) => String(p).trim()).filter(Boolean).join(",")
        : null;

    if (password && password.trim() !== "") {
      const salt = await bcrypt.genSalt(10);
      const passwordHash = await bcrypt.hash(password, salt);

      await pool.query(
        `UPDATE users
         SET name = ?, username = ?, email = ?, role = ?, allowed_pages = ?, password_hash = ?
         WHERE user_id = ?`,
        [name, username, email || null, userRole, allowedPagesStr, passwordHash, id],
      );
    } else {
      await pool.query(
        `UPDATE users
         SET name = ?, username = ?, email = ?, role = ?, allowed_pages = ?
         WHERE user_id = ?`,
        [name, username, email || null, userRole, allowedPagesStr, id],
      );
    }

    return res.json({
      user: {
        id: Number(id),
        name,
        username,
        email: email || null,
        role: userRole,
        allowed_pages: allowed_pages && allowed_pages.length > 0 ? allowed_pages : null,
      },
    });
  } catch (error) {
    console.error("Error in PUT /api/users/:id:", error);
    return res.status(500).json({ message: "Failed to update user." });
  }
});

// DELETE /api/users/:id - delete user (admin only; cannot delete self)
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const currentUserId = req.user && String(req.user.userId ?? req.user.user_id ?? req.user.id ?? "");

    if (String(id) === currentUserId) {
      return res
        .status(400)
        .json({ message: "You cannot delete your own account." });
    }

    const [result] = await pool.query(
      "DELETE FROM users WHERE user_id = ?",
      [id],
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "User not found." });
    }

    return res.status(200).json({ message: "User deleted successfully." });
  } catch (error) {
    console.error("Error in DELETE /api/users/:id:", error);
    return res.status(500).json({ message: "Failed to delete user." });
  }
});

export default router;

