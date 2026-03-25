import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import pool from "../db.js";
import { authenticateToken } from "../middleware/authMiddleware.js";
import { logChange } from "../changeLog.js";
import { sendMail } from "../utils/mailer.js";

const SQLITE_NOW = "datetime('now','localtime')";
const SQLITE_CURDATE = "date('now','localtime')";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const router = express.Router();
router.use(authenticateToken);

function escapeHtml(s) {
  if (s == null) return "";
  const str = String(s);
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function getLogoAttachment() {
  const baseDirs = [
    path.join(__dirname, "..", "..", "frontend", "images"),
    path.join(process.cwd(), "frontend", "images"),
  ];
  const names = ["DM-logo.jpg", "dm-logo.jpg", "DM-logo.JPG", "DM-logo.jpeg", "DM-logo.png"];
  for (const dir of baseDirs) {
    try {
      if (!fs.existsSync(dir)) continue;
      for (const name of names) {
        const logoPath = path.join(dir, name);
        if (fs.existsSync(logoPath)) {
          const buffer = fs.readFileSync(logoPath);
          return { buffer, filename: name };
        }
      }
      const files = fs.readdirSync(dir);
      const img = files.find((f) => /\.(jpe?g|png)$/i.test(f));
      if (img) {
        const logoPath = path.join(dir, img);
        const buffer = fs.readFileSync(logoPath);
        return { buffer, filename: img };
      }
    } catch {
      // ignore
    }
  }
  return null;
}

const SORT_OPTIONS = {
  name_asc: "p.name ASC",
  name_desc: "p.name DESC",
  price_asc: "p.selling_price ASC",
  price_desc: "p.selling_price DESC",
  stock_asc: "p.stock_quantity ASC",
  stock_desc: "p.stock_quantity DESC",
};

// Must match `adminfinal/backend/routes/productRoutes.js` placeholder naming.
const CATEGORY_PLACEHOLDER_PREFIX = "__dm_category__:";

router.get("/", async (req, res) => {
  try {
    const q = (req.query.q || "").trim();
    const filterToday = req.query.filter === "today";
    const category = (req.query.category || "").trim();
    const sortKey = req.query.sort in SORT_OPTIONS ? req.query.sort : "name_asc";
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    let sql = `SELECT p.product_id AS id, p.name, p.category, p.supplier_id, p.supplier_price, p.selling_price, p.stock_quantity,
               p.recorded_at, p.recorded_by, s.name AS supplier_name, COALESCE(p.recorded_by_name, u.name) AS recorded_by_name
               FROM products p
               LEFT JOIN suppliers s ON s.supplier_id = p.supplier_id
               LEFT JOIN users u ON u.user_id = p.recorded_by WHERE 1=1`;
    const params = [];

    // Hide placeholder products that exist only to carry category values.
    sql += " AND p.name NOT LIKE ?";
    params.push(`${CATEGORY_PLACEHOLDER_PREFIX}%`);
    if (q) {
      sql += " AND (p.name LIKE ? OR p.category LIKE ? OR s.name LIKE ?)";
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    if (filterToday) {
      sql += ` AND date(p.recorded_at) = ${SQLITE_CURDATE}`;
    }
    if (category) {
      sql += " AND p.category = ?";
      params.push(category);
    }
    const orderBy = SORT_OPTIONS[sortKey];
    sql += ` ORDER BY ${orderBy} LIMIT ? OFFSET ?`;

    const countParams = [...params];
    let countSql = `SELECT COUNT(*) AS total FROM products p
      LEFT JOIN suppliers s ON s.supplier_id = p.supplier_id WHERE 1=1`;
    countSql += " AND p.name NOT LIKE ?";
    if (q) {
      countSql += " AND (p.name LIKE ? OR p.category LIKE ? OR s.name LIKE ?)";
    }
    if (filterToday) {
      countSql += ` AND date(p.recorded_at) = ${SQLITE_CURDATE}`;
    }
    if (category) {
      countSql += " AND p.category = ?";
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

router.get("/categories", async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT DISTINCT TRIM(category) AS category FROM products WHERE category IS NOT NULL AND TRIM(category) != '' ORDER BY category"
    );
    const categories = (rows || [])
      .map((r) => (r.category || "").trim())
      .filter(Boolean);
    return res.json({ categories });
  } catch (err) {
    console.error("GET /api/products/categories:", err);
    return res.status(500).json({ message: "Failed to load categories." });
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
    const finalSupId = isNaN(supId) ? null : supId;

    const [existing] = await pool.query(
      "SELECT product_id AS id FROM products WHERE TRIM(name) = TRIM(?) AND ((category IS NULL AND ? IS NULL) OR (category = ?)) AND ((supplier_id IS NULL AND ? IS NULL) OR (supplier_id = ?)) LIMIT 1",
      [name.trim(), categoryStr, categoryStr, finalSupId, finalSupId]
    );
    if (existing.length > 0) {
      return res.status(409).json({
        message: "A product with this name, category and supplier already exists. Edit the existing product instead.",
        existingId: existing[0].id,
      });
    }

    const recordedBy = req.user?.userId ?? null;
    const recordedByName = req.user?.name ?? req.user?.username ?? null;
    const [insertResult] = await pool.query(
      "INSERT INTO products (name, category, supplier_id, supplier_price, selling_price, stock_quantity, recorded_by, recorded_by_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [name.trim(), categoryStr || null, finalSupId, supPrice, price, stock, recordedBy, recordedByName]
    );
    const newId = insertResult?.insertId;
    const [rows] = await pool.query(
       `SELECT p.product_id AS id, p.name, p.category, p.supplier_id, p.supplier_price, p.selling_price, p.stock_quantity,
       p.recorded_at, p.recorded_by, s.name AS supplier_name, COALESCE(p.recorded_by_name, u.name) AS recorded_by_name
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
      // Keep only the latest 10 activity entries (local-only, not synced to central)
      await pool.query(
        `DELETE FROM activity_log
         WHERE activity_id NOT IN (
           SELECT activity_id
           FROM activity_log
           ORDER BY datetime(created_at) DESC, activity_id DESC
           LIMIT 10
         )`
      );
    } catch (_) {}

    await logChange("product", product.id, "create", product);

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
       p.recorded_at, p.recorded_by, s.name AS supplier_name, COALESCE(p.recorded_by_name, u.name) AS recorded_by_name
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
    const finalSupId = isNaN(supId) ? null : supId;

    const [existing] = await pool.query(
      "SELECT product_id AS id FROM products WHERE TRIM(name) = TRIM(?) AND ((category IS NULL AND ? IS NULL) OR (category = ?)) AND ((supplier_id IS NULL AND ? IS NULL) OR (supplier_id = ?)) AND product_id != ? LIMIT 1",
      [name.trim(), categoryStr, categoryStr, finalSupId, finalSupId, id]
    );
    if (existing.length > 0) {
      return res.status(409).json({
        message: "A product with this name, category and supplier already exists.",
        existingId: existing[0].id,
      });
    }

    await pool.query(
      "UPDATE products SET name = ?, category = ?, supplier_id = ?, supplier_price = ?, selling_price = ?, stock_quantity = ? WHERE product_id = ?",
      [name.trim(), categoryStr || null, finalSupId, supPrice, price, stock, id]
    );
    const [rows] = await pool.query(
      `SELECT p.product_id AS id, p.name, p.category, p.supplier_id, p.supplier_price, p.selling_price, p.stock_quantity,
       p.recorded_at, p.recorded_by, s.name AS supplier_name, COALESCE(p.recorded_by_name, u.name) AS recorded_by_name
       FROM products p LEFT JOIN suppliers s ON s.supplier_id = p.supplier_id LEFT JOIN users u ON u.user_id = p.recorded_by WHERE p.product_id = ?`,
      [id]
    );
    const product = rows[0];

    await logChange("product", product.id, "update", product);

    return res.json({ product });
  } catch (err) {
    console.error("PUT /api/products/:id:", err);
    return res.status(500).json({ message: "Failed to update product." });
  }
});

router.post("/:id/reorder-email", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ message: "Invalid product ID." });

    const subjectFromBody =
      typeof req.body?.subject === "string" ? req.body.subject.trim() : "";
    const textFromBody =
      typeof req.body?.text === "string" ? req.body.text.trim() : "";

    const [rows] = await pool.query(
      `SELECT
         p.product_id AS id,
         p.name,
         p.category,
         p.stock_quantity,
         s.supplier_id,
         s.name AS supplier_name,
         s.contact AS supplier_contact
       FROM products p
       LEFT JOIN suppliers s ON s.supplier_id = p.supplier_id
       WHERE p.product_id = ?
       LIMIT 1`,
      [id]
    );
    const product = rows?.[0];
    if (!product) return res.status(404).json({ message: "Product not found." });

    const supplierName = product.supplier_name || "Supplier";
    const contactRaw =
      product.supplier_contact != null ? String(product.supplier_contact).trim() : "";
    const contactLower = contactRaw.toLowerCase();

    const temporarilyUnavailable =
      !contactRaw ||
      contactLower === "no." ||
      contactLower === "no" ||
      contactLower === "n/a" ||
      contactLower === "na" ||
      contactLower === "none" ||
      contactLower === "-";

    const to = !temporarilyUnavailable && contactRaw.includes("@") ? contactRaw : "";
    if (!to) {
      return res.status(400).json({ message: "Temporarily not available" });
    }

    const subject =
      subjectFromBody || `Reorder request: ${product.name || "Product"}`;
    const text =
      textFromBody ||
      `Hi,\n\n` +
        `We would like to reorder ${product.name || "Product"}. Our current stock is ${
          product.stock_quantity != null ? product.stock_quantity : 0
        }.\n\n` +
        `Please confirm availability, price, and lead time. Also let us know if there are any ordering requirements.\n\n` +
        `Thank you.`;

    const logoAttach = getLogoAttachment();
    const logoImgTag = logoAttach
      ? "<img src=\"cid:dmLogo\" alt=\"D&M Construction Supply\" style=\"display:block;width:100%;max-height:72px;height:auto;object-fit:contain;\" />"
      : "<span style='color:#fff;font-weight:bold;font-size:18px'>D&M Construction Supply</span>";

    const messageHtml = escapeHtml(text).replace(/\r?\n/g, "<br/>");

    const html = [
      "<!DOCTYPE html><html><head><meta charset='utf-8'><meta name='viewport' content='width=device-width, initial-scale=1.0'>",
      "<style>",
      "body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; margin: 0; padding: 24px; background: #f5f5f5; }",
      ".email-wrap { max-width: 560px; margin: 0 auto; background: #fff; border-radius: 10px; overflow: hidden; box-shadow: 0 2px 10px rgba(0,0,0,0.08); }",
      ".email-header { background: #2c3e50; padding: 0; line-height: 0; width: 100%; display: block; }",
      ".email-body { padding: 24px; color: #333; line-height: 1.6; font-size: 15px; }",
      ".message-box { background: #ffffff; border: 1px solid #dee2e6; border-radius: 8px; padding: 14px 16px; margin: 12px 0 0; }",
      ".email-footer { padding: 16px 24px; background: #f8f9fa; font-size: 12px; color: #6c757d; }",
      "</style></head><body>",
      "<div class='email-wrap'>",
      "<div class='email-header'>",
      logoImgTag,
      "</div>",
      "<div class='email-body'>",
      `<p style="margin:0 0 8px;">Hi ${escapeHtml(supplierName)},</p>`,
      "<p style=\"margin:0 0 10px;\">We’d like to place a reorder. Please see our message below.</p>",
      `<div class='message-box'>${messageHtml}</div>`,
      "</div>",
      "<div class='email-footer'>— D&M Sales Admin</div>",
      "</div></body></html>",
    ].join("");

    const attachments = logoAttach
      ? [{ filename: logoAttach.filename, content: logoAttach.buffer, cid: "dmLogo" }]
      : undefined;

    await sendMail({ to, subject, text, html, attachments });
    return res.json({ message: `Email sent to ${to}.` });
  } catch (err) {
    console.error("POST /api/products/:id/reorder-email:", err);
    const msg =
      err?.code === "MAIL_NOT_CONFIGURED"
        ? "Email is not configured on the server. Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM."
        : "Failed to send reorder email.";
    return res.status(500).json({ message: msg });
  }
});

export default router;
