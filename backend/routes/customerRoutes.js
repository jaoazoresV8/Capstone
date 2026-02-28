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
    
    let customersFromTable = [];
    let customersFromSales = [];
    
    
    if (q) {
      const [rows] = await pool.query(
        "SELECT customer_id AS id, name, contact, address, total_balance FROM customers WHERE (name LIKE ? OR contact LIKE ?) ORDER BY name",
        [`%${q}%`, `%${q}%`]
      );
      customersFromTable = rows;
    } else {
      const [rows] = await pool.query(
        "SELECT customer_id AS id, name, contact, address, total_balance FROM customers ORDER BY name"
      );
      customersFromTable = rows;
    }
    
    
    if (hasSalesCustomerName) {
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
    
  
    const allCustomers = [...customersFromTable, ...customersFromSales];
    const uniqueCustomers = [];
    const seenNames = new Set();
    
    for (const customer of allCustomers) {
      const nameKey = (customer.name || "").toLowerCase().trim();
      if (nameKey && !seenNames.has(nameKey)) {
        seenNames.add(nameKey);
        uniqueCustomers.push(customer);
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
       JOIN products p ON si.product_id = p.product_id`
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
        transactions = Object.values(data.transactions).sort((a, b) => (String(b.sale_date || "")).localeCompare(String(a.sale_date || "")));
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
