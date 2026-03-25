import express from "express";
import os from "os";
import pool from "../db.js";
import { authenticateToken, requireAdmin } from "../middleware/authMiddleware.js";
import { logChange } from "../changeLog.js";

const router = express.Router();

router.get("/", authenticateToken, async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('markup_percent', 'client_id', 'central_api_url', 'pref_allow_hotkeys', 'pref_enable_modal_drag')"
    );
    const map = new Map((rows || []).map((r) => [r.setting_key, r.setting_value]));

    const markupRaw = map.get("markup_percent") ?? "10";
    const markup_percent = parseFloat(markupRaw) || 10;

    const defaultClientId =
      (process.env.CLIENT_ID && String(process.env.CLIENT_ID).trim()) ||
      os.hostname() ||
      "client";
    const client_id = (map.get("client_id") ?? defaultClientId).toString().trim() || defaultClientId;

    const defaultCentralUrl =
      (process.env.CENTRAL_API_URL && String(process.env.CENTRAL_API_URL).trim()) || "";
    const central_api_url =
      (map.get("central_api_url") ?? defaultCentralUrl).toString().trim() || "";

    const parseBool = (raw, defaultVal) => {
      if (raw == null) return defaultVal;
      const s = String(raw).trim().toLowerCase();
      if (s === "1" || s === "true" || s === "yes" || s === "on") return true;
      if (s === "0" || s === "false" || s === "no" || s === "off") return false;
      return defaultVal;
    };

    const pref_allow_hotkeys = parseBool(map.get("pref_allow_hotkeys"), true);
    const pref_enable_modal_drag = parseBool(map.get("pref_enable_modal_drag"), true);

    return res.json({ markup_percent, client_id, central_api_url, pref_allow_hotkeys, pref_enable_modal_drag });
  } catch (err) {
    console.error("GET /api/settings:", err);
    return res.status(500).json({ message: "Failed to load settings." });
  }
});

router.put("/", authenticateToken, requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const { markup_percent, client_id, central_api_url } = body;

    const updates = {};

    // Only validate margin when the client explicitly sends this field. (Using
    // `!= null` would treat "" as present — empty string is not null — and fail
    // parseFloat, returning a misleading margin error on mixed payloads.)
    if (Object.prototype.hasOwnProperty.call(body, "markup_percent")) {
      const pct = parseFloat(markup_percent);
      if (isNaN(pct) || pct < 0 || pct >= 100) {
        return res.status(400).json({ message: "Margin percentage must be between 0 and 99.99 (profit margin)." });
      }
      const value = String(Math.round(pct * 100) / 100);
      const marginNum = parseFloat(value);
      await pool.query(
        "INSERT OR REPLACE INTO settings (setting_key, setting_value) VALUES ('markup_percent', ?)",
        [value]
      );
      // Margin-based: Selling Price = Cost / (1 - Margin). Stored as markup_percent but used as margin.
      await pool.query(
        "UPDATE products SET selling_price = ROUND(supplier_price / (1 - ? / 100), 2)",
        [marginNum]
      );
      updates.markup_percent = marginNum;
    }

    if (client_id != null) {
      const cid = String(client_id).trim();
      if (!cid) {
        return res.status(400).json({ message: "Client ID cannot be empty." });
      }
      if (cid.length > 64) {
        return res.status(400).json({ message: "Client ID must be 64 characters or less." });
      }
      await pool.query(
        "INSERT OR REPLACE INTO settings (setting_key, setting_value) VALUES ('client_id', ?)",
        [cid]
      );
      updates.client_id = cid;
    }

    if (central_api_url != null) {
      const raw = String(central_api_url).trim();
      if (raw.length > 0 && !/^https?:\/\//i.test(raw)) {
        return res
          .status(400)
          .json({ message: "Central server address must start with http:// or https://, or be left blank to disable." });
      }
      if (raw.length > 255) {
        return res
          .status(400)
          .json({ message: "Central server address is too long (max 255 characters)." });
      }
      await pool.query(
        "INSERT OR REPLACE INTO settings (setting_key, setting_value) VALUES ('central_api_url', ?)",
        [raw]
      );
      updates.central_api_url = raw;
    }

    const parseBoolTo01 = (raw) => {
      if (typeof raw === "boolean") return raw ? "1" : "0";
      if (typeof raw === "number" && (raw === 0 || raw === 1)) return raw ? "1" : "0";
      const s = String(raw).trim().toLowerCase();
      if (s === "1" || s === "true" || s === "yes" || s === "on") return "1";
      if (s === "0" || s === "false" || s === "no" || s === "off") return "0";
      return null;
    };

    if (Object.prototype.hasOwnProperty.call(body, "pref_allow_hotkeys")) {
      const v = parseBoolTo01(body.pref_allow_hotkeys);
      if (v == null) return res.status(400).json({ message: "pref_allow_hotkeys must be true/false." });
      await pool.query(
        "INSERT OR REPLACE INTO settings (setting_key, setting_value) VALUES ('pref_allow_hotkeys', ?)",
        [v]
      );
      updates.pref_allow_hotkeys = v;
    }

    if (Object.prototype.hasOwnProperty.call(body, "pref_enable_modal_drag")) {
      const v = parseBoolTo01(body.pref_enable_modal_drag);
      if (v == null) return res.status(400).json({ message: "pref_enable_modal_drag must be true/false." });
      await pool.query(
        "INSERT OR REPLACE INTO settings (setting_key, setting_value) VALUES ('pref_enable_modal_drag', ?)",
        [v]
      );
      updates.pref_enable_modal_drag = v;
    }

    if (Object.keys(updates).length) {
      await logChange("settings", 0, "update", updates);
    }

    // Return the updated view of settings.
    const [rows] = await pool.query(
      "SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('markup_percent', 'client_id', 'central_api_url', 'pref_allow_hotkeys', 'pref_enable_modal_drag')"
    );
    const map = new Map((rows || []).map((r) => [r.setting_key, r.setting_value]));
    const markupRaw = map.get("markup_percent") ?? "10";
    const markupOut = parseFloat(markupRaw) || 10;
    const defaultClientId =
      (process.env.CLIENT_ID && String(process.env.CLIENT_ID).trim()) ||
      os.hostname() ||
      "client";
    const clientOut = (map.get("client_id") ?? defaultClientId).toString().trim() || defaultClientId;
    const defaultCentralUrl =
      (process.env.CENTRAL_API_URL && String(process.env.CENTRAL_API_URL).trim()) || "";
    const centralOut =
      (map.get("central_api_url") ?? defaultCentralUrl).toString().trim() || "";

    const parseBool = (raw, defaultVal) => {
      if (raw == null) return defaultVal;
      const s = String(raw).trim().toLowerCase();
      if (s === "1" || s === "true" || s === "yes" || s === "on") return true;
      if (s === "0" || s === "false" || s === "no" || s === "off") return false;
      return defaultVal;
    };

    const pref_allow_hotkeys = parseBool(map.get("pref_allow_hotkeys"), true);
    const pref_enable_modal_drag = parseBool(map.get("pref_enable_modal_drag"), true);

    return res.json({
      markup_percent: markupOut,
      client_id: clientOut,
      central_api_url: centralOut,
      pref_allow_hotkeys,
      pref_enable_modal_drag,
    });
  } catch (err) {
    console.error("PUT /api/settings:", err);
    return res.status(500).json({ message: "Failed to update settings." });
  }
});

export default router;
