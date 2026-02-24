import express from "express";
import pool, { getTableColumns } from "../db.js";
import { authenticateToken } from "../middleware/authMiddleware.js";

const router = express.Router();
router.use(authenticateToken);

// GET /api/sales - list sales with customer name (payment_method from payments.reference_number or 'cash')
router.get("/", async (req, res) => {
  try {
    const columns = getTableColumns("sales");
    const hasTransactionType = columns.includes("transaction_type");
    const hasCustomerName = columns.includes("customer_name");
    const hasOrNumber = columns.includes("or_number");
    
    let query;
    if (hasCustomerName) {
      query = `SELECT s.sale_id AS id, s.customer_id, COALESCE(c.name, s.customer_name) AS customer_name,
                      s.total_amount, s.amount_paid, s.remaining_balance, s.status,
                      s.sale_date, ${hasTransactionType ? 's.transaction_type' : 'NULL AS transaction_type'}, 
                      ${hasOrNumber ? 's.or_number' : 'NULL AS or_number'},
                      s.customer_name AS walk_in_customer_name
               FROM sales s
               LEFT JOIN customers c ON c.customer_id = s.customer_id
               ORDER BY s.sale_date DESC`;
    } else {
      query = `SELECT s.sale_id AS id, s.customer_id, c.name AS customer_name,
                      s.total_amount, s.amount_paid, s.remaining_balance, s.status,
                      s.sale_date, NULL AS transaction_type, NULL AS walk_in_customer_name,
                      ${hasOrNumber ? 's.or_number' : 'NULL AS or_number'}
               FROM sales s
               LEFT JOIN customers c ON c.customer_id = s.customer_id
               ORDER BY s.sale_date DESC`;
    }
    
    const [rows] = await pool.query(query);
    if (rows.length === 0) return res.json({ sales: [] });
    const [payments] = await pool.query(
      "SELECT sale_id, reference_number FROM payments WHERE sale_id IN (?)",
      [rows.map((r) => r.id)]
    );
    const payBySale = Object.fromEntries(
      (payments || []).map((p) => [p.sale_id, p.reference_number || "cash"])
    );
    const salesWithMethod = rows.map((r) => ({
      ...r,
      customer_name: r.customer_name || r.walk_in_customer_name || "—",
      payment_method: payBySale[r.id] || "cash",
    }));
    return res.json({ sales: salesWithMethod });
  } catch (err) {
    console.error("GET /api/sales:", err);
    return res.status(500).json({ message: "Failed to load sales." });
  }
});

// GET /api/sales/payments - list all payments for Payments page
router.get("/payments", async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT p.payment_id, p.sale_id, p.amount_paid, p.payment_date, p.reference_number, p.payment_method
       FROM payments p
       ORDER BY p.payment_date DESC, p.payment_id DESC`
    );
    return res.json({ payments: rows });
  } catch (err) {
    console.error("GET /api/sales/payments:", err);
    return res.status(500).json({ message: "Failed to load payments." });
  }
});

// GET /api/sales/:id
router.get("/:id", async (req, res) => {
  try {
    const columns = getTableColumns("sales");
    const hasTransactionType = columns.includes("transaction_type");
    const hasCustomerName = columns.includes("customer_name");
    const hasOrNumber = columns.includes("or_number");
    
    let query;
    if (hasCustomerName) {
      query = `SELECT s.sale_id AS id, s.customer_id, COALESCE(c.name, s.customer_name) AS customer_name, 
                      c.contact, c.address, s.customer_name AS walk_in_customer_name,
                      ${hasOrNumber ? 's.or_number' : 'NULL AS or_number'},
                      s.total_amount, s.amount_paid, s.remaining_balance, s.status,
                      s.sale_date, ${hasTransactionType ? 's.transaction_type' : 'NULL AS transaction_type'}
               FROM sales s
               LEFT JOIN customers c ON c.customer_id = s.customer_id
               WHERE s.sale_id = ?`;
    } else {
      query = `SELECT s.sale_id AS id, s.customer_id, c.name AS customer_name, 
                      c.contact, c.address, NULL AS walk_in_customer_name,
                      ${hasOrNumber ? 's.or_number' : 'NULL AS or_number'},
                      s.total_amount, s.amount_paid, s.remaining_balance, s.status,
                      s.sale_date, NULL AS transaction_type
               FROM sales s
               LEFT JOIN customers c ON c.customer_id = s.customer_id
               WHERE s.sale_id = ?`;
    }
    
    const [sales] = await pool.query(query, [req.params.id]);
    if (sales.length === 0) return res.status(404).json({ message: "Sale not found." });
    const [payRows] = await pool.query(
      "SELECT reference_number FROM payments WHERE sale_id = ? LIMIT 1",
      [req.params.id]
    );
    const payment_method = payRows[0]?.reference_number || "cash";
    const [items] = await pool.query(
      `SELECT si.sale_item_id, si.product_id, p.name AS product_name,
              si.quantity, si.price, si.subtotal
       FROM sale_items si
       JOIN products p ON p.product_id = si.product_id
       WHERE si.sale_id = ? ORDER BY si.sale_item_id`,
      [req.params.id]
    );
    const sale = {
      ...sales[0],
      customer_name: sales[0].customer_name || sales[0].walk_in_customer_name || "—",
      payment_method,
      items
    };
    return res.json({ sale });
  } catch (err) {
    console.error("GET /api/sales/:id:", err);
    return res.status(500).json({ message: "Failed to load sale." });
  }
});

// POST /api/sales - create sale with items
router.post("/", async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { customer_id, customer_name, transaction_type, items, payment_method, amount_paid, reference_number: bodyRef, customer_contact, customer_address } = req.body;
    const referenceNumber = (bodyRef != null && String(bodyRef).trim()) ? String(bodyRef).trim() : null;
    const contact = customer_contact != null
      ? (typeof customer_contact === "number" ? String(customer_contact) : (typeof customer_contact === "string" ? customer_contact.trim() : null))
      : null;
    const address = (customer_address != null && typeof customer_address === "string") ? customer_address.trim() : null;
    // Normalize customer_id: only use if it's a positive integer (avoids SQLite FK constraint when 0 or invalid)
    let custIdRaw = customer_id != null && customer_id !== "" ? parseInt(customer_id, 10) : NaN;
    let custId = Number.isInteger(custIdRaw) && custIdRaw > 0 ? custIdRaw : null;
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: "At least one item is required." });
    }
    const columns = getTableColumns("sales");
    const hasTransactionType = columns.includes("transaction_type");
    const hasCustomerName = columns.includes("customer_name");
    const hasOrNumber = columns.includes("or_number");
    const hasNewColumns = hasTransactionType && hasCustomerName;
    
    // Validate new fields only if columns exist
    if (hasNewColumns) {
      if (!customer_name || typeof customer_name !== "string" || customer_name.trim().length === 0) {
        return res.status(400).json({ message: "Customer name is required." });
      }
      if (!transaction_type || !["walk-in", "online"].includes(transaction_type)) {
        return res.status(400).json({ message: "Transaction type must be 'walk-in' or 'online'." });
      }
    }

    await conn.beginTransaction();

    // Reject if contact is already used by another customer
    if (contact != null && contact !== "") {
      const [existing] = await conn.query(
        "SELECT customer_id FROM customers WHERE contact = ? AND (? IS NULL OR customer_id != ?) LIMIT 1",
        [contact, custId, custId]
      );
      if (existing && existing.length > 0) {
        await conn.rollback();
        conn.release();
        return res.status(400).json({ message: "That contact is already used by another customer." });
      }
    }

    // Create or update customer so contact/address/total_balance show on Customers page
    if (hasNewColumns && customer_name && customer_name.trim()) {
      const name = customer_name.trim();
      if (custId) {
        if (contact !== null || address !== null) {
          const updates = [];
          const values = [];
          if (contact !== null) {
            updates.push("contact = ?");
            values.push(contact);
          }
          if (address !== null) {
            updates.push("address = ?");
            values.push(address);
          }
          if (updates.length) {
            values.push(custId);
            await conn.query(
              `UPDATE customers SET ${updates.join(", ")} WHERE customer_id = ?`,
              values
            );
          }
        }
      } else {
        const [ins] = await conn.query(
          "INSERT INTO customers (name, contact, address, total_balance) VALUES (?, ?, ?, 0)",
          [name, contact || null, address || null]
        );
        custId = ins.insertId;
      }
    }

    let totalAmount = 0;
    const productIds = items.map((i) => i.product_id);
    const [products] = await conn.query(
      "SELECT product_id, name, selling_price, stock_quantity FROM products WHERE product_id IN (?)",
      [productIds]
    );
    const productMap = Object.fromEntries(products.map((p) => [p.product_id, p]));

    const lineItems = [];
    for (const it of items) {
      const p = productMap[it.product_id];
      if (!p) throw new Error(`Product ${it.product_id} not found.`);
      const qty = Math.max(1, parseInt(it.quantity, 10) || 1);
      if (p.stock_quantity < qty) throw new Error(`Insufficient stock for ${p.name}.`);
      const price = p.selling_price;
      const subtotal = price * qty;
      totalAmount += subtotal;
      lineItems.push({ product_id: p.product_id, name: p.name, quantity: qty, price, subtotal });
    }

    const paid = parseFloat(amount_paid) || 0;
    const remaining = Math.max(0, totalAmount - paid);
    const status = remaining <= 0 ? "paid" : paid > 0 ? "partial" : "unpaid";
    const payMethod = payment_method && ["cash", "gcash", "paymaya", "credit"].includes(payment_method) ? payment_method : "cash";

    // Generate O.R. number if column exists (SQLite: no REGEXP by default; use LIKE)
    let orNumber = null;
    if (hasOrNumber) {
      const [maxOr] = await conn.query(
        "SELECT MAX(CAST(REPLACE(or_number, 'OR-', '') AS INTEGER)) AS max_num FROM sales WHERE or_number IS NOT NULL AND or_number LIKE 'OR-%'"
      );
      const nextNum = (maxOr[0]?.max_num || 0) + 1;
      orNumber = `OR-${String(nextNum).padStart(3, "0")}`;
    }

    // Build INSERT query based on whether new columns exist
    let insertQuery, insertValues;
    if (hasNewColumns && hasOrNumber) {
      insertQuery = `INSERT INTO sales (customer_id, customer_name, transaction_type, or_number, total_amount, amount_paid, remaining_balance, status, sale_date)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'))`;
      insertValues = [custId, customer_name.trim(), transaction_type, orNumber, totalAmount, paid, remaining, status];
    } else if (hasNewColumns) {
      insertQuery = `INSERT INTO sales (customer_id, customer_name, transaction_type, total_amount, amount_paid, remaining_balance, status, sale_date)
                     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'))`;
      insertValues = [custId, customer_name.trim(), transaction_type, totalAmount, paid, remaining, status];
    } else {
      insertQuery = `INSERT INTO sales (customer_id, total_amount, amount_paid, remaining_balance, status, sale_date)
                     VALUES (?, ?, ?, ?, ?, datetime('now','localtime'))`;
      insertValues = [custId, totalAmount, paid, remaining, status];
    }

    const [saleResult] = await conn.query(insertQuery, insertValues);
    const saleId = saleResult.insertId;

    for (const it of lineItems) {
      await conn.query(
        "INSERT INTO sale_items (sale_id, product_id, quantity, price, subtotal) VALUES (?, ?, ?, ?, ?)",
        [saleId, it.product_id, it.quantity, it.price, it.subtotal]
      );
      await conn.query(
        "UPDATE products SET stock_quantity = stock_quantity - ? WHERE product_id = ?",
        [it.quantity, it.product_id]
      );
    }

    if (custId && remaining > 0) {
      await conn.query(
        "UPDATE customers SET total_balance = total_balance + ? WHERE customer_id = ?",
        [remaining, custId]
      );
    }

    if (paid > 0) {
      const paymentRef = referenceNumber || payMethod;
      await conn.query(
        "INSERT INTO payments (sale_id, amount_paid, payment_date, reference_number, payment_method) VALUES (?, ?, datetime('now','localtime'), ?, ?)",
        [saleId, paid, paymentRef, payMethod]
      );
    }

    // Log sale into activity_log (for dashboard recent activity)
    try {
      await conn.query(
        "INSERT INTO activity_log (type, title, details, amount, created_at) VALUES (?, ?, ?, ?, datetime('now','localtime'))",
        [
          "sale",
          `New sale #${saleId}`,
          `${lineItems.length} item(s) for ${customer_name?.trim?.() || "Customer"}`,
          totalAmount,
        ]
      );
    } catch (_) {
      // Activity log failure should not break main transaction
    }

    await conn.commit();

    // Build SELECT query based on whether new columns exist (reuse variables declared earlier)
    let selectQuery;
    if (hasCustomerName) {
      selectQuery = `SELECT s.sale_id AS id, s.customer_id, COALESCE(c.name, s.customer_name) AS customer_name,
                            s.customer_name AS walk_in_customer_name, ${hasTransactionType ? 's.transaction_type' : 'NULL AS transaction_type'},
                            ${hasOrNumber ? 's.or_number' : 'NULL AS or_number'},
                            s.total_amount, s.amount_paid, s.remaining_balance, s.status,
                            s.sale_date
                     FROM sales s LEFT JOIN customers c ON c.customer_id = s.customer_id
                     WHERE s.sale_id = ?`;
    } else {
      selectQuery = `SELECT s.sale_id AS id, s.customer_id, c.name AS customer_name,
                            NULL AS walk_in_customer_name, NULL AS transaction_type,
                            ${hasOrNumber ? 's.or_number' : 'NULL AS or_number'},
                            s.total_amount, s.amount_paid, s.remaining_balance, s.status,
                            s.sale_date
                     FROM sales s LEFT JOIN customers c ON c.customer_id = s.customer_id
                     WHERE s.sale_id = ?`;
    }
    
    const [newSale] = await pool.query(selectQuery, [saleId]);
    const [newItems] = await pool.query(
      "SELECT product_id, quantity, price, subtotal FROM sale_items WHERE sale_id = ? ORDER BY sale_item_id",
      [saleId]
    );
    const saleWithItems = {
      ...newSale[0],
      customer_name: newSale[0].customer_name || newSale[0].walk_in_customer_name || "—",
      payment_method: payMethod,
      or_number: newSale[0].or_number || orNumber || null,
      items: newItems.map((i) => ({ ...i, product_name: productMap[i.product_id]?.name || "" })),
    };
    return res.status(201).json({ sale: saleWithItems });
  } catch (err) {
    await conn.rollback();
    console.error("POST /api/sales:", err);
    return res.status(400).json({ message: err.message || "Failed to create sale." });
  } finally {
    conn.release();
  }
});

// POST /api/sales/:id/payments - record a payment for an existing sale (e.g. from Customers Pay)
router.post("/:id/payments", async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const saleId = parseInt(req.params.id, 10);
    const { amount_paid: bodyAmount, payment_method, reference_number: bodyRef } = req.body;

    if (!saleId || isNaN(saleId) || saleId <= 0) {
      return res.status(400).json({ message: "Invalid sale ID." });
    }

    const amount = parseFloat(bodyAmount);
    if (isNaN(amount) || amount <= 0) {
      return res.status(400).json({ message: "Amount paid must be a positive number." });
    }

    const payMethod = payment_method && ["cash", "gcash", "paymaya"].includes(payment_method) ? payment_method : "cash";
    const referenceNumber = (bodyRef != null && String(bodyRef).trim()) ? String(bodyRef).trim() : null;
    if (payMethod === "gcash" || payMethod === "paymaya") {
      if (!referenceNumber) {
        return res.status(400).json({ message: "Reference number is required for GCash/PayMaya." });
      }
    }

    await conn.beginTransaction();

    const [sales] = await conn.query(
      "SELECT sale_id, customer_id, amount_paid, remaining_balance FROM sales WHERE sale_id = ?",
      [saleId]
    );
    if (sales.length === 0) {
      await conn.rollback();
      conn.release();
      return res.status(404).json({ message: "Sale not found." });
    }
    const sale = sales[0];
    const remaining = parseFloat(sale.remaining_balance) || 0;
    const amountRounded = Math.round(amount * 100) / 100;
    const remainingRounded = Math.round(remaining * 100) / 100;
    if (amountRounded > remainingRounded) {
      await conn.rollback();
      conn.release();
      return res.status(400).json({ message: `Amount cannot exceed remaining balance (₱${remainingRounded.toFixed(2)}).` });
    }

    const paymentRef = referenceNumber || payMethod;
    await conn.query(
      "INSERT INTO payments (sale_id, amount_paid, payment_date, reference_number, payment_method) VALUES (?, ?, datetime('now','localtime'), ?, ?)",
      [saleId, amountRounded, paymentRef, payMethod]
    );

    const newPaid = (parseFloat(sale.amount_paid) || 0) + amountRounded;
    const newRemaining = Math.max(0, remainingRounded - amountRounded);
    const status = newRemaining <= 0 ? "paid" : "partial";
    await conn.query(
      "UPDATE sales SET amount_paid = ?, remaining_balance = ?, status = ? WHERE sale_id = ?",
      [newPaid, newRemaining, status, saleId]
    );

    if (sale.customer_id && newRemaining >= 0) {
      await conn.query(
        "UPDATE customers SET total_balance = total_balance - ? WHERE customer_id = ?",
        [amountRounded, sale.customer_id]
      );
    }

    // Log payment into activity_log
    try {
      await conn.query(
        "INSERT INTO activity_log (type, title, details, amount, created_at) VALUES (?, ?, ?, ?, datetime('now','localtime'))",
        [
          "payment",
          `Payment for sale #${saleId}`,
          `Method: ${payMethod}`,
          amountRounded,
        ]
      );
    } catch (_) {}

    await conn.commit();
    return res.json({ message: "Payment recorded successfully." });
  } catch (err) {
    await conn.rollback();
    console.error("POST /api/sales/:id/payments:", err);
    return res.status(500).json({ message: err.message || "Failed to record payment." });
  } finally {
    conn.release();
  }
});

// PUT /api/sales/:id/payment-confirm - securely update payment reference number
router.put("/:id/payment-confirm", async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const saleId = parseInt(req.params.id, 10);
    const { reference_number } = req.body;

    if (!saleId || isNaN(saleId) || saleId <= 0) {
      return res.status(400).json({ message: "Invalid sale ID." });
    }

    if (!reference_number || typeof reference_number !== "string") {
      return res.status(400).json({ message: "Reference number is required." });
    }

    const refTrimmed = reference_number.trim();
    if (refTrimmed.length === 0 || refTrimmed.length > 100) {
      return res.status(400).json({ message: "Reference number must be 1-100 characters." });
    }

    await conn.beginTransaction();

    const [sales] = await conn.query(
      "SELECT sale_id FROM sales WHERE sale_id = ?",
      [saleId]
    );
    if (sales.length === 0) {
      await conn.rollback();
      return res.status(404).json({ message: "Sale not found." });
    }

    const [payments] = await conn.query(
      "SELECT payment_id, reference_number FROM payments WHERE sale_id = ? ORDER BY payment_date DESC LIMIT 1",
      [saleId]
    );

    if (payments.length > 0) {
      await conn.query(
        "UPDATE payments SET reference_number = ? WHERE payment_id = ?",
        [refTrimmed, payments[0].payment_id]
      );
    } else {
      const [saleInfo] = await conn.query(
        "SELECT amount_paid FROM sales WHERE sale_id = ?",
        [saleId]
      );
      const amountPaid = saleInfo[0]?.amount_paid || 0;
      if (amountPaid > 0) {
        await conn.query(
          "INSERT INTO payments (sale_id, amount_paid, payment_date, reference_number) VALUES (?, ?, datetime('now','localtime'), ?)",
          [saleId, amountPaid, refTrimmed]
        );
      }
    }

    await conn.commit();

    return res.json({ message: "Payment reference updated successfully." });
  } catch (err) {
    await conn.rollback();
    console.error("PUT /api/sales/:id/payment-confirm:", err);
    return res.status(500).json({ message: "Failed to update payment reference." });
  } finally {
    conn.release();
  }
});

export default router;
