import express from "express";
import pool from "../db.js";
import { authenticateToken } from "../middleware/authMiddleware.js";
import { logChange } from "../changeLog.js";

const router = express.Router();
router.use(authenticateToken);

router.get("/", async (req, res) => {
  try {
    const q = (req.query.q != null && typeof req.query.q === "string") ? req.query.q.trim() : "";
    let rows;
    if (q) {
      const like = `%${q.replace(/%/g, "\\%").replace(/_/g, "\\_")}%`;
      const [r] = await pool.query(
        "SELECT supplier_id AS id, name, contact, address FROM suppliers WHERE name LIKE ? ESCAPE '\\' ORDER BY name LIMIT 30",
        [like]
      );
      rows = r;
    } else {
      const [r] = await pool.query(
        "SELECT supplier_id AS id, name, contact, address FROM suppliers ORDER BY name"
      );
      rows = r;
    }
    return res.json({ suppliers: rows });
  } catch (err) {
    console.error("GET /api/suppliers:", err);
    return res.status(500).json({ message: "Failed to load suppliers." });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ message: "Invalid supplier ID." });
    const [rows] = await pool.query(
      "SELECT supplier_id AS id, name, contact, address FROM suppliers WHERE supplier_id = ?",
      [id]
    );
    if (rows.length === 0) return res.status(404).json({ message: "Supplier not found." });
    return res.json({ supplier: rows[0] });
  } catch (err) {
    console.error("GET /api/suppliers/:id:", err);
    return res.status(500).json({ message: "Failed to load supplier." });
  }
});

router.post("/", async (req, res) => {
  try {
    const { name, contact, address } = req.body;
    const nameStr = name != null && typeof name === "string" ? name.trim() : "";
    if (!nameStr) {
      return res.status(400).json({ message: "Supplier name is required." });
    }
    const contactStr = (contact != null && typeof contact === "string") ? contact.trim() || null : null;
    const addressStr = (address != null && typeof address === "string") ? address.trim() || null : null;

    const [result] = await pool.query(
      "INSERT INTO suppliers (name, contact, address) VALUES (?, ?, ?)",
      [nameStr, contactStr, addressStr]
    );
    const [rows] = await pool.query(
      "SELECT supplier_id AS id, name, contact, address FROM suppliers WHERE supplier_id = ?",
      [result.insertId]
    );
    const supplier = rows[0];

    // Log local change for later central sync
    await logChange("supplier", supplier.id, "create", supplier);

    return res.status(201).json({ supplier });
  } catch (err) {
    console.error("POST /api/suppliers:", err);
    return res.status(500).json({ message: "Failed to create supplier." });
  }
});

router.put("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ message: "Invalid supplier ID." });
    const { name, contact, address } = req.body;
    const nameStr = name != null && typeof name === "string" ? name.trim() : "";
    if (!nameStr) {
      return res.status(400).json({ message: "Supplier name is required." });
    }
    const contactStr = (contact != null && typeof contact === "string") ? contact.trim() || null : null;
    const addressStr = (address != null && typeof address === "string") ? address.trim() || null : null;

    const [result] = await pool.query(
      "UPDATE suppliers SET name = ?, contact = ?, address = ? WHERE supplier_id = ?",
      [nameStr, contactStr, addressStr, id]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Supplier not found." });
    }
    const [rows] = await pool.query(
      "SELECT supplier_id AS id, name, contact, address FROM suppliers WHERE supplier_id = ?",
      [id]
    );
    const supplier = rows[0];

    await logChange("supplier", supplier.id, "update", supplier);

    return res.json({ supplier });
  } catch (err) {
    console.error("PUT /api/suppliers/:id:", err);
    return res.status(500).json({ message: "Failed to update supplier." });
  }
});

export default router;
