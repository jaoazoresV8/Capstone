import express from "express";
import pool, { tableHasColumn } from "../db.js";
import { authenticateToken } from "../middleware/authMiddleware.js";
import { logChange } from "../changeLog.js";

const router = express.Router();
router.use(authenticateToken);

router.get("/", async (req, res) => {
  try {
    const q = (req.query.q || "").trim();
    const hasSalesCustomerName = tableHasColumn("sales", "customer_name");
    const hasSalesContactAddress = tableHasColumn("sales", "customer_contact") && tableHasColumn("sales", "customer_address");

    let customersFromTable = [];
    let customersFromSales = [];

    if (q) {
      const [rows] = await pool.query(
        "SELECT customer_id AS id, name, contact, address, total_balance FROM customers WHERE (name LIKE ? OR contact LIKE ? OR address LIKE ?) ORDER BY name",
        [`%${q}%`, `%${q}%`, `%${q}%`]
      );
      customersFromTable = rows;
    } else {
      const [rows] = await pool.query(
        "SELECT customer_id AS id, name, contact, address, total_balance FROM customers ORDER BY name"
      );
      customersFromTable = rows;
    }

    if (hasSalesCustomerName) {
      if (hasSalesContactAddress) {
        const likeArg = `%${q}%`;
        if (q) {
          const [rows] = await pool.query(
            `SELECT s.customer_name AS name, s.customer_contact AS contact, s.customer_address AS address
             FROM sales s
             INNER JOIN (
               SELECT customer_name, MAX(sale_id) AS sale_id
               FROM sales
               WHERE customer_name IS NOT NULL AND customer_name != '' AND (customer_name LIKE ? OR customer_contact LIKE ? OR customer_address LIKE ?)
               GROUP BY customer_name
             ) t ON s.customer_name = t.customer_name AND s.sale_id = t.sale_id
             ORDER BY s.customer_name`,
            [likeArg, likeArg, likeArg]
          );
          customersFromSales = rows.map(row => ({
            id: null,
            name: row.name,
            contact: row.contact ?? null,
            address: row.address ?? null,
            total_balance: 0.00
          }));
        } else {
          const [rows] = await pool.query(
            `SELECT s.customer_name AS name, s.customer_contact AS contact, s.customer_address AS address
             FROM sales s
             INNER JOIN (
               SELECT customer_name, MAX(sale_id) AS sale_id
               FROM sales
               WHERE customer_name IS NOT NULL AND customer_name != ''
               GROUP BY customer_name
             ) t ON s.customer_name = t.customer_name AND s.sale_id = t.sale_id
             ORDER BY s.customer_name`
          );
          customersFromSales = rows.map(row => ({
            id: null,
            name: row.name,
            contact: row.contact ?? null,
            address: row.address ?? null,
            total_balance: 0.00
          }));
        }
      } else {
        if (q) {
          const [rows] = await pool.query(
            `SELECT DISTINCT customer_name AS name 
             FROM sales 
             WHERE customer_name IS NOT NULL AND customer_name != '' AND customer_name LIKE ?
             ORDER BY customer_name`,
            [`%${q}%`]
          );
          customersFromSales = rows.map(row => ({
            id: null,
            name: row.name,
            contact: null,
            address: null,
            total_balance: 0.00
          }));
        } else {
          const [rows] = await pool.query(
            `SELECT DISTINCT customer_name AS name 
             FROM sales 
             WHERE customer_name IS NOT NULL AND customer_name != ''
             ORDER BY customer_name`
          );
          customersFromSales = rows.map(row => ({
            id: null,
            name: row.name,
            contact: null,
            address: null,
            total_balance: 0.00
          }));
        }
      }
    }
    
  
    const allCustomers = [...customersFromTable, ...customersFromSales];
    const uniqueCustomers = [];
    const seenNames = new Set();
    const tableByName = new Map();
    for (const c of customersFromTable) {
      const nameKey = (c.name || "").toLowerCase().trim();
      if (nameKey) tableByName.set(nameKey, c);
    }

    for (const customer of allCustomers) {
      const nameKey = (customer.name || "").toLowerCase().trim();
      if (nameKey && !seenNames.has(nameKey)) {
        seenNames.add(nameKey);
        let out = { ...customer };
        if (out.id == null && (out.contact == null || out.contact === "") && (out.address == null || out.address === "")) {
          const fromTable = tableByName.get(nameKey);
          if (fromTable) {
            out = { ...out, contact: fromTable.contact ?? null, address: fromTable.address ?? null };
          }
        }
        uniqueCustomers.push(out);
      }
    }

    uniqueCustomers.sort((a, b) => {
      const nameA = (a.name || "").toLowerCase();
      const nameB = (b.name || "").toLowerCase();
      return nameA.localeCompare(nameB);
    });

    const [detailRows] = await pool.query(
      `SELECT s.customer_id, s.customer_name, s.sale_id, s.sale_date, s.total_amount, s.amount_paid, s.remaining_balance, s.status,
              p.name AS product_name, si.quantity, si.price, si.subtotal
       FROM sale_items si
       JOIN sales s ON si.sale_id = s.sale_id
       JOIN products p ON si.product_id = p.product_id
       ORDER BY s.sale_date DESC, s.sale_id DESC`
    );

    const key = (row) => row.customer_id != null ? `id:${row.customer_id}` : `name:${(row.customer_name || "").trim().toLowerCase()}`;
    const byCustomer = {};
    for (const row of detailRows || []) {
      const k = key(row);
      if (!byCustomer[k]) {
        byCustomer[k] = { productTotals: {}, transactions: {} };
      }
      const pname = row.product_name != null ? String(row.product_name).trim() : "";
      if (pname) {
        byCustomer[k].productTotals[pname] = (byCustomer[k].productTotals[pname] || 0) + (row.quantity || 0);
      }
      const sid = row.sale_id;
      if (!byCustomer[k].transactions[sid]) {
        byCustomer[k].transactions[sid] = {
          sale_id: sid,
          sale_date: row.sale_date,
          total_amount: row.total_amount,
          amount_paid: row.amount_paid,
          remaining_balance: row.remaining_balance,
          status: row.status,
          items: [],
        };
      }
      if (pname) {
        byCustomer[k].transactions[sid].items.push({
          product_name: pname,
          quantity: row.quantity,
          price: row.price,
          subtotal: row.subtotal,
        });
      }
    }

    const out = uniqueCustomers.slice(0, 50).map((c) => {
      const k = c.id != null ? `id:${c.id}` : `name:${(c.name || "").trim().toLowerCase()}`;
      const data = byCustomer[k];
      let products_bought = null;
      let products_detail = [];
      let transactions = [];
      if (data) {
        products_detail = Object.entries(data.productTotals).map(([product_name, total_quantity]) => ({ product_name, total_quantity }));
        products_bought = products_detail.length
          ? products_detail.map((p) => `${p.product_name} (${p.total_quantity})`).join(", ")
          : null;
        // Most recent sales first (by date, then by sale_id for same-day)
        transactions = Object.values(data.transactions).sort((a, b) => {
          const tA = a.sale_date ? new Date(a.sale_date).getTime() : 0;
          const tB = b.sale_date ? new Date(b.sale_date).getTime() : 0;
          if (tB !== tA) return tB - tA;
          return (Number(b.sale_id) || 0) - (Number(a.sale_id) || 0);
        });
      }
      return { ...c, products_bought, products_detail, transactions };
    });

    return res.json({ customers: out });
  } catch (err) {
    console.error("GET /api/customers:", err);
    return res.status(500).json({ message: "Failed to load customers." });
  }
});


router.get("/check-contact", async (req, res) => {
  try {
    const contact = (req.query.contact != null && typeof req.query.contact === "string") ? req.query.contact.trim() : "";
    const excludeIdRaw = req.query.exclude_customer_id != null ? parseInt(req.query.exclude_customer_id, 10) : NaN;
    const excludeCustomerId = Number.isInteger(excludeIdRaw) && excludeIdRaw > 0 ? excludeIdRaw : null;
    if (!contact) {
      return res.json({ available: true });
    }
    const [rows] = await pool.query(
      "SELECT customer_id FROM customers WHERE contact = ? AND (? IS NULL OR customer_id != ?) LIMIT 1",
      [contact, excludeCustomerId, excludeCustomerId]
    );
    const available = !rows || rows.length === 0;
    return res.json({
      available,
      ...(available ? {} : { message: "That contact is already used by another customer." }),
    });
  } catch (err) {
    console.error("GET /api/customers/check-contact:", err);
    return res.status(500).json({ message: "Failed to check contact.", available: false });
  }
});


// Create or update customer by name (for sales-only customers who have no id yet)
router.post("/", async (req, res) => {
  try {
    const { name, contact, address } = req.body || {};
    const nameStr = (name != null && typeof name === "string") ? name.trim() : "";
    if (!nameStr) {
      return res.status(400).json({ message: "Name is required." });
    }
    const contactStr = (contact != null && typeof contact === "string") ? contact.trim() || null : null;
    const addressStr = (address != null && typeof address === "string") ? address.trim() || null : null;

    const [existing] = await pool.query(
      "SELECT customer_id AS id, name, contact, address, total_balance FROM customers WHERE LOWER(TRIM(name)) = LOWER(?) LIMIT 1",
      [nameStr]
    );
    if (existing && existing.length > 0) {
      const existingId = existing[0].id;
      const updates = [];
      const values = [];
      if (contactStr != null) {
        if (contactStr !== "") {
          const [dup] = await pool.query(
            "SELECT customer_id FROM customers WHERE contact = ? AND customer_id != ? LIMIT 1",
            [contactStr, existingId]
          );
          if (dup && dup.length > 0) {
            return res.status(400).json({ message: "That contact is already used by another customer." });
          }
          updates.push("contact = ?");
          values.push(contactStr);
        } else {
          updates.push("contact = NULL");
        }
      }
      if (addressStr != null) {
        updates.push("address = ?");
        values.push(addressStr || null);
      }
      if (updates.length > 0) {
        values.push(existingId);
        await pool.query(
          `UPDATE customers SET ${updates.join(", ")} WHERE customer_id = ?`,
          values
        );
      }
      const [rows] = await pool.query(
        "SELECT customer_id AS id, name, contact, address, total_balance FROM customers WHERE customer_id = ?",
        [existingId]
      );
      const customer = rows[0] || existing[0];
      await logChange("customer", customer.id, "update", customer);
      return res.status(200).json({ message: "Customer updated.", customer });
    }

    if (contactStr && contactStr !== "") {
      const [taken] = await pool.query(
        "SELECT customer_id FROM customers WHERE contact = ? LIMIT 1",
        [contactStr]
      );
      if (taken && taken.length > 0) {
        return res.status(400).json({ message: "That contact is already used by another customer." });
      }
    }
    await pool.query(
      "INSERT INTO customers (name, contact, address, total_balance) VALUES (?, ?, ?, 0)",
      [nameStr, contactStr, addressStr]
    );
    const [insertResult] = await pool.query(
      "SELECT customer_id AS id, name, contact, address, total_balance FROM customers WHERE name = ? ORDER BY customer_id DESC LIMIT 1",
      [nameStr]
    );
    const customer = insertResult[0] || { id: null, name: nameStr, contact: contactStr, address: addressStr, total_balance: 0 };
    await logChange("customer", customer.id, "create", customer);
    return res.status(201).json({ message: "Customer created.", customer });
  } catch (err) {
    console.error("POST /api/customers:", err);
    return res.status(500).json({ message: "Failed to save customer." });
  }
});

router.put("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ message: "Invalid customer ID." });
    }
    const { name, contact, address } = req.body;
    const updates = [];
    const values = [];
    if (name != null && typeof name === "string" && name.trim()) {
      updates.push("name = ?");
      values.push(name.trim());
    }
    if (contact != null) {
      const contactStr = typeof contact === "number" ? String(contact) : (typeof contact === "string" ? contact.trim() : null);
      if (contactStr != null && contactStr !== "") {
        const [existing] = await pool.query(
          "SELECT customer_id FROM customers WHERE contact = ? AND customer_id != ? LIMIT 1",
          [contactStr, id]
        );
        if (existing && existing.length > 0) {
          return res.status(400).json({ message: "That contact is already used by another customer." });
        }
        updates.push("contact = ?");
        values.push(contactStr);
      }
    }
    if (address != null && typeof address === "string") {
      updates.push("address = ?");
      values.push(address.trim());
    }
    if (updates.length === 0) {
      return res.status(400).json({ message: "Provide at least one of name, contact, or address." });
    }
    values.push(id);
    const [result] = await pool.query(
      `UPDATE customers SET ${updates.join(", ")} WHERE customer_id = ?`,
      values
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Customer not found." });
    }
    const [rows] = await pool.query(
      "SELECT customer_id AS id, name, contact, address, total_balance FROM customers WHERE customer_id = ?",
      [id]
    );
    const customer = rows[0] || { id };

    await logChange("customer", customer.id, "update", customer);

    return res.json({ message: "Customer updated.", customer });
  } catch (err) {
    console.error("PUT /api/customers/:id:", err);
    return res.status(500).json({ message: "Failed to update customer." });
  }
});

export default router;
