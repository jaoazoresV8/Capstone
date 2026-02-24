import express from "express";
import pool from "../db.js";
import { authenticateToken } from "../middleware/authMiddleware.js";

const SQLITE_NOW = "datetime('now','localtime')";
const SQLITE_CURDATE = "date('now','localtime')";

const router = express.Router();
router.use(authenticateToken);

const SORT_OPTIONS = {
  name_asc: "p.name ASC",
  name_desc: "p.name DESC",
  price_asc: "p.selling_price ASC",
  price_desc: "p.selling_price DESC",
  stock_asc: "p.stock_quantity ASC",
  stock_desc: "p.stock_quantity DESC",
};

router.get("/", async (req, res) => {
  try {
    const q = (req.query.q || "").trim();
    const filterToday = req.query.filter === "today";
    const sortKey = req.query.sort in SORT_OPTIONS ? req.query.sort : "name_asc";
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    let sql = `SELECT p.product_id AS id, p.name, p.category, p.supplier_id, p.supplier_price, p.selling_price, p.stock_quantity,
               p.recorded_at, p.recorded_by, s.name AS supplier_name, u.name AS recorded_by_name
               FROM products p
               LEFT JOIN suppliers s ON s.supplier_id = p.supplier_id
               LEFT JOIN users u ON u.user_id = p.recorded_by WHERE 1=1`;
    const params = [];
    if (q) {
      sql += " AND (p.name LIKE ? OR p.category LIKE ? OR s.name LIKE ?)";
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    if (filterToday) {
      sql += ` AND date(p.recorded_at) = ${SQLITE_CURDATE}`;
    }
    const orderBy = SORT_OPTIONS[sortKey];
    sql += ` ORDER BY ${orderBy} LIMIT ? OFFSET ?`;

    const countParams = [...params];
    let countSql = `SELECT COUNT(*) AS total FROM products p
      LEFT JOIN suppliers s ON s.supplier_id = p.supplier_id WHERE 1=1`;
    if (q) {
      countSql += " AND (p.name LIKE ? OR p.category LIKE ? OR s.name LIKE ?)";
    }
    if (filterToday) {
      countSql += ` AND date(p.recorded_at) = ${SQLITE_CURDATE}`;
    }
    const [countRows] = await pool.query(countSql, countParams);
    const total = countRows[0]?.total ?? 0;

    params.push(limit, offset);
    const [rows] = await pool.query(sql, params);
    const products = rows.map((r) => ({
      id: r.id,
      name: r.name,
      category: r.category,
      supplier_id: r.supplier_id,
      supplier_name: r.supplier_name,
      supplier_price: r.supplier_price,
      selling_price: r.selling_price,
      stock_quantity: r.stock_quantity,
      recorded_at: r.recorded_at,
      recorded_by: r.recorded_by,
      recorded_by_name: r.recorded_by_name,
    }));
    return res.json({ products, total, hasMore: offset + products.length < total });
  } catch (err) {
    console.error("GET /api/products:", err);
    return res.status(500).json({ message: "Failed to load products." });
  }
});

router.post("/", async (req, res) => {
  try {
    const { name, category, supplier_id, supplier_price, selling_price, stock_quantity } = req.body;
    if (!name || typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ message: "Product name is required." });
    }
    const price = parseFloat(selling_price);
    if (isNaN(price) || price < 0) {
      return res.status(400).json({ message: "Valid selling price is required." });
    }
    const stock = Math.max(0, parseInt(stock_quantity, 10) || 0);
    const categoryStr = (category && typeof category === "string") ? category.trim() : null;
    const supId = supplier_id != null && supplier_id !== "" ? parseInt(supplier_id, 10) : null;
    const supPrice = supplier_price != null && supplier_price !== "" ? parseFloat(supplier_price) : 0;

    const recordedBy = req.user?.userId ?? null;
    const [insertResult] = await pool.query(
      "INSERT INTO products (name, category, supplier_id, supplier_price, selling_price, stock_quantity, recorded_by) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [name.trim(), categoryStr || null, isNaN(supId) ? null : supId, supPrice, price, stock, recordedBy]
    );
    const newId = insertResult?.insertId;
    const [rows] = await pool.query(
       `SELECT p.product_id AS id, p.name, p.category, p.supplier_id, p.supplier_price, p.selling_price, p.stock_quantity,
       p.recorded_at, p.recorded_by, s.name AS supplier_name, u.name AS recorded_by_name
       FROM products p LEFT JOIN suppliers s ON s.supplier_id = p.supplier_id LEFT JOIN users u ON u.user_id = p.recorded_by WHERE p.product_id = ?`,
      [newId]
    );
    const product = rows[0];

   
    try {
      await pool.query(
        "INSERT INTO activity_log (type, title, details, amount, created_at) VALUES (?, ?, ?, ?, datetime('now','localtime'))",
        [
          "product",
          `New product: ${product.name}`,
          product.category ? `Category: ${product.category}` : null,
          product.selling_price ?? null,
        ]
      );
    } catch (_) {}

    return res.status(201).json({ product });
  } catch (err) {
    console.error("POST /api/products:", err);
    return res.status(500).json({ message: "Failed to create product." });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ message: "Invalid product ID." });
    const [rows] = await pool.query(
      `SELECT p.product_id AS id, p.name, p.category, p.supplier_id, p.supplier_price, p.selling_price, p.stock_quantity,
       p.recorded_at, p.recorded_by, s.name AS supplier_name, u.name AS recorded_by_name
       FROM products p LEFT JOIN suppliers s ON s.supplier_id = p.supplier_id LEFT JOIN users u ON u.user_id = p.recorded_by WHERE p.product_id = ?`,
      [id]
    );
    if (rows.length === 0) return res.status(404).json({ message: "Product not found." });
    return res.json({ product: rows[0] });
  } catch (err) {
    console.error("GET /api/products/:id:", err);
    return res.status(500).json({ message: "Failed to load product." });
  }
});

router.put("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ message: "Invalid product ID." });
    const { name, category, supplier_id, supplier_price, selling_price, stock_quantity } = req.body;
    if (!name || typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ message: "Product name is required." });
    }
    const price = parseFloat(selling_price);
    if (isNaN(price) || price < 0) {
      return res.status(400).json({ message: "Valid selling price is required." });
    }
    const stock = Math.max(0, parseInt(stock_quantity, 10) || 0);
    const categoryStr = (category && typeof category === "string") ? category.trim() : null;
    const supId = supplier_id != null && supplier_id !== "" ? parseInt(supplier_id, 10) : null;
    const supPrice = supplier_price != null && supplier_price !== "" ? parseFloat(supplier_price) : 0;

    await pool.query(
      "UPDATE products SET name = ?, category = ?, supplier_id = ?, supplier_price = ?, selling_price = ?, stock_quantity = ? WHERE product_id = ?",
      [name.trim(), categoryStr || null, isNaN(supId) ? null : supId, supPrice, price, stock, id]
    );
    const [rows] = await pool.query(
      `SELECT p.product_id AS id, p.name, p.category, p.supplier_id, p.supplier_price, p.selling_price, p.stock_quantity,
       p.recorded_at, p.recorded_by, s.name AS supplier_name, u.name AS recorded_by_name
       FROM products p LEFT JOIN suppliers s ON s.supplier_id = p.supplier_id LEFT JOIN users u ON u.user_id = p.recorded_by WHERE p.product_id = ?`,
      [id]
    );
    return res.json({ product: rows[0] });
  } catch (err) {
    console.error("PUT /api/products/:id:", err);
    return res.status(500).json({ message: "Failed to update product." });
  }
});

export default router;
