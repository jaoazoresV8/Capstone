import express from "express";
import pool from "../db.js";
import { authenticateToken, requireAdmin } from "../middleware/authMiddleware.js";

const router = express.Router();

router.get("/", authenticateToken, async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT setting_key, setting_value FROM settings WHERE setting_key = 'markup_percent'"
    );
    const value = rows[0]?.setting_value ?? "10";
    const markup_percent = parseFloat(value) || 10;
    return res.json({ markup_percent });
  } catch (err) {
    console.error("GET /api/settings:", err);
    return res.status(500).json({ message: "Failed to load settings." });
  }
});

router.put("/", authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { markup_percent } = req.body;
    const pct = parseFloat(markup_percent);
    if (isNaN(pct) || pct < 0 || pct > 999) {
      return res.status(400).json({ message: "Markup percentage must be between 0 and 999." });
    }
    const value = String(Math.round(pct * 100) / 100);
    const markupNum = parseFloat(value);
    await pool.query(
      "INSERT OR REPLACE INTO settings (setting_key, setting_value) VALUES ('markup_percent', ?)",
      [value]
    );
    await pool.query(
      "UPDATE products SET selling_price = ROUND(supplier_price * (1 + ? / 100), 2)",
      [markupNum]
    );
    return res.json({ markup_percent: markupNum });
  } catch (err) {
    console.error("PUT /api/settings:", err);
    return res.status(500).json({ message: "Failed to update settings." });
  }
});

export default router;
