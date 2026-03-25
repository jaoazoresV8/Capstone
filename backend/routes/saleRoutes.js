import express from "express";
import bcrypt from "bcryptjs";
import pool, { getTableColumns } from "../db.js";
import { authenticateToken, requireAdmin } from "../middleware/authMiddleware.js";
import { logChange } from "../changeLog.js";
import { pushPendingChangesToCentralOnce } from "../centralSyncPushOnce.js";

const router = express.Router();

function scheduleCentralPush() {
  void pushPendingChangesToCentralOnce();
}
router.use(authenticateToken);

// Helper: check if local sale_issues table exists (offline flagging support)
function hasSaleIssuesTable() {
  try {
    const cols = getTableColumns("sale_issues");
    return Array.isArray(cols) && cols.length > 0;
  } catch {
    return false;
  }
}

// GET /api/sales/issues/open-count - count of open sale issues (for admin nav indicator)
router.get("/issues/open-count", requireAdmin, async (req, res) => {
  try {
    if (!hasSaleIssuesTable()) {
      return res.json({ open: 0 });
    }
    const [rows] = await pool.query(
      "SELECT COUNT(*) AS open_count FROM sale_issues WHERE status = 'open'"
    );
    const open = rows && rows.length > 0 ? Number(rows[0].open_count) || 0 : 0;
    return res.json({ open });
  } catch (err) {
    console.error("GET /api/sales/issues/open-count:", err);
    return res.status(500).json({ message: "Failed to load open sale issues count." });
  }
});

// GET /api/sales/issues - list flagged sale issues (default: open only) for admin nav modal
router.get("/issues", requireAdmin, async (req, res) => {
  try {
    if (!hasSaleIssuesTable()) {
      return res.json({ issues: [] });
    }

    const status = String(req.query.status || "open").toLowerCase();
    let where = "";
    const params = [];
    if (status === "open") {
      where = "WHERE si.status = 'open'";
    } else if (status === "resolved") {
      where = "WHERE si.status = 'resolved'";
    } else if (status === "voided") {
      where = "WHERE si.status = 'voided'";
    } else if (status === "refunded") {
      where = "WHERE si.status = 'refunded'";
    }

    const [rows] = await pool.query(
      `
      SELECT
        si.issue_id,
        si.sale_id,
        si.reason,
        si.note,
        si.status,
        si.cashier_id,
        si.cashier_name,
        si.created_at,
        si.resolved_by_admin_id,
        si.resolved_by_admin_name,
        si.resolution_note,
        si.resolution_action,
        si.resolved_at,
        s.total_amount,
        s.amount_paid,
        s.remaining_balance,
        s.status AS sale_status,
        s.sale_date,
        s.customer_name
      FROM sale_issues si
      LEFT JOIN sales s ON s.sale_id = si.sale_id
      ${where}
      ORDER BY si.status = 'open' DESC, si.created_at DESC, si.issue_id DESC
      LIMIT 100
      `,
      params
    );

    return res.json({ issues: rows || [] });
  } catch (err) {
    console.error("GET /api/sales/issues:", err);
    return res.status(500).json({ message: "Failed to load sale issues." });
  }
});

// GET /api/sales - list sales with filters + pagination
// Accepts: q (search), status, limit, offset. Returns: { sales, total, hasMore }.
router.get("/", async (req, res) => {
  try {
    const columns = getTableColumns("sales");
    const hasTransactionType = columns.includes("transaction_type");
    const hasCustomerName = columns.includes("customer_name");
    const hasOrNumber = columns.includes("or_number");
    const hasSaleUuid = columns.includes("sale_uuid");
    const hasIssues = hasSaleIssuesTable();

    const q = String(req.query.q || "").trim();
    const status = String(req.query.status || "").trim().toLowerCase();
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const isIssueStatusFilter = status === "voided" || status === "refunded";
    if (isIssueStatusFilter && !hasIssues) {
      return res.json({ sales: [], total: 0, hasMore: false });
    }

    const params = [];
    const whereParts = [];

    if (q) {
      whereParts.push(
        "(CAST(s.sale_id AS TEXT) LIKE ? OR " +
          "LOWER(COALESCE(c.name, s.customer_name)) LIKE ? OR " +
          "LOWER(s.status) LIKE ?)"
      );
      params.push(`%${q}%`, `%${q.toLowerCase()}%`, `%${q.toLowerCase()}%`);
    }

    if (status && !isIssueStatusFilter) {
      whereParts.push("LOWER(s.status) = ?");
      params.push(status);
    }
    if (isIssueStatusFilter) {
      whereParts.push(
        "EXISTS (SELECT 1 FROM sale_issues si WHERE si.sale_id = s.sale_id AND si.status = ?)"
      );
      params.push(status);
    }

    const whereSql = whereParts.length ? "WHERE " + whereParts.join(" AND ") : "";

    // Order: voided/refunded sales at the bottom (when issue table exists)
    const orderByVoidRefundLast = hasIssues
      ? "(SELECT 1 FROM sale_issues si WHERE si.sale_id = s.sale_id AND si.status IN ('voided','refunded') LIMIT 1) ASC, "
      : "";

    const baseSelect = hasCustomerName
      ? `SELECT s.sale_id AS id, s.customer_id, COALESCE(c.name, s.customer_name) AS customer_name,
                s.total_amount, s.amount_paid, s.remaining_balance, s.status,
                s.sale_date, ${hasTransactionType ? "s.transaction_type" : "NULL AS transaction_type"},
                ${hasOrNumber ? "s.or_number" : "NULL AS or_number"},
                ${hasSaleUuid ? "s.sale_uuid" : "NULL AS sale_uuid"},
                s.customer_name AS walk_in_customer_name
         FROM sales s
         LEFT JOIN customers c ON c.customer_id = s.customer_id`
      : `SELECT s.sale_id AS id, s.customer_id, c.name AS customer_name,
                s.total_amount, s.amount_paid, s.remaining_balance, s.status,
                s.sale_date, NULL AS transaction_type, NULL AS walk_in_customer_name,
                ${hasOrNumber ? "s.or_number" : "NULL AS or_number"},
                ${hasSaleUuid ? "s.sale_uuid" : "NULL AS sale_uuid"}
         FROM sales s
         LEFT JOIN customers c ON c.customer_id = s.customer_id`;

    // Count for pagination
    const countSql = `SELECT COUNT(*) AS total FROM (${baseSelect} ${whereSql}) AS sub`;
    const [countRows] = await pool.query(countSql, params);
    const total = countRows[0]?.total ?? 0;

    if (!total) {
      return res.json({ sales: [], total: 0, hasMore: false });
    }

    // Paged query: voided/refunded sales last, then by date desc
    const orderSql = `ORDER BY ${orderByVoidRefundLast}s.sale_date DESC, s.sale_id DESC LIMIT ? OFFSET ?`;
    const query = `${baseSelect} ${whereSql} ${orderSql}`;
    const [rows] = await pool.query(query, [...params, limit, offset]);

    if (!rows.length) {
      return res.json({ sales: [], total, hasMore: false });
    }

    const saleIds = rows.map((r) => r.id);

    const [payments] = await pool.query(
      "SELECT sale_id, reference_number, payment_method FROM payments WHERE sale_id IN (?)",
      [saleIds]
    );
    const payBySale = {};
    const refBySale = {};
    for (const p of payments || []) {
      const methodRaw =
        p.payment_method != null && String(p.payment_method).trim()
          ? String(p.payment_method).trim().toLowerCase()
          : "";
      const refRaw =
        p.reference_number != null && String(p.reference_number).trim()
          ? String(p.reference_number).trim().toLowerCase()
          : "";
      let method = "cash";
      if (methodRaw) {
        method = methodRaw;
      } else if (refRaw === "gcash" || refRaw === "paymaya" || refRaw === "cash") {
        method = refRaw;
      }
      payBySale[p.sale_id] = method;
      refBySale[p.sale_id] =
        p.reference_number != null && String(p.reference_number).trim()
          ? String(p.reference_number).trim()
          : null;
    }

    // Open issue indicator and voided/refunded resolution status per sale (if table exists)
    let openIssuesBySale = {};
    let issueResolutionBySale = {};
    if (hasIssues) {
      const [issueRows] = await pool.query(
        `SELECT sale_id, COUNT(*) AS open_count
         FROM sale_issues
         WHERE status = 'open' AND sale_id IN (?)
         GROUP BY sale_id`,
        [saleIds]
      );
      openIssuesBySale = Object.fromEntries(
        (issueRows || []).map((row) => [row.sale_id, Number(row.open_count) || 0])
      );
      const [resolutionRows] = await pool.query(
        `SELECT sale_id, status
         FROM sale_issues
         WHERE sale_id IN (?) AND status IN ('voided','refunded')
         ORDER BY resolved_at DESC, issue_id DESC`,
        [saleIds]
      );
      for (const row of resolutionRows || []) {
        if (issueResolutionBySale[row.sale_id] == null) {
          issueResolutionBySale[row.sale_id] = row.status;
        }
      }
    }

    const salesWithMethod = rows.map((r) => {
      const st = String(r.status || "").toLowerCase();
      const fromIssues = hasIssues ? issueResolutionBySale[r.id] || null : null;
      const fromSaleRow =
        st === "voided" || st === "refunded" ? st : null;
      return {
        ...r,
        customer_name: r.customer_name || r.walk_in_customer_name || "—",
        payment_method: payBySale[r.id] || "cash",
        reference_number: refBySale[r.id] ?? null,
        has_open_issue: hasIssues ? Boolean(openIssuesBySale[r.id]) : false,
        issue_resolution_status: fromIssues || fromSaleRow,
      };
    });

    return res.json({
      sales: salesWithMethod,
      total,
      hasMore: offset + salesWithMethod.length < total,
    });
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
    const hasSaleUuid = columns.includes("sale_uuid");
    const hasIssues = hasSaleIssuesTable();
    
    let query;
    if (hasCustomerName) {
      query = `SELECT s.sale_id AS id, s.customer_id, COALESCE(c.name, s.customer_name) AS customer_name, 
                      c.contact, c.address, s.customer_name AS walk_in_customer_name,
                      ${hasOrNumber ? "s.or_number" : "NULL AS or_number"},
                      ${hasSaleUuid ? "s.sale_uuid" : "NULL AS sale_uuid"},
                      s.total_amount, s.amount_paid, s.remaining_balance, s.status,
                      s.sale_date, ${hasTransactionType ? "s.transaction_type" : "NULL AS transaction_type"}
               FROM sales s
               LEFT JOIN customers c ON c.customer_id = s.customer_id
               WHERE s.sale_id = ?`;
    } else {
      query = `SELECT s.sale_id AS id, s.customer_id, c.name AS customer_name, 
                      c.contact, c.address, NULL AS walk_in_customer_name,
                      ${hasOrNumber ? "s.or_number" : "NULL AS or_number"},
                      ${hasSaleUuid ? "s.sale_uuid" : "NULL AS sale_uuid"},
                      s.total_amount, s.amount_paid, s.remaining_balance, s.status,
                      s.sale_date, NULL AS transaction_type
               FROM sales s
               LEFT JOIN customers c ON c.customer_id = s.customer_id
               WHERE s.sale_id = ?`;
    }
    
    const [sales] = await pool.query(query, [req.params.id]);
    if (sales.length === 0) return res.status(404).json({ message: "Sale not found." });
    const [payRows] = await pool.query(
      "SELECT reference_number, payment_method FROM payments WHERE sale_id = ? ORDER BY payment_date DESC, payment_id DESC LIMIT 1",
      [req.params.id]
    );
    let payment_method = "cash";
    if (payRows && payRows.length > 0) {
      const methodRaw =
        payRows[0].payment_method != null && String(payRows[0].payment_method).trim()
          ? String(payRows[0].payment_method).trim().toLowerCase()
          : "";
      const refRaw =
        payRows[0].reference_number != null && String(payRows[0].reference_number).trim()
          ? String(payRows[0].reference_number).trim().toLowerCase()
          : "";
      if (methodRaw) {
        payment_method = methodRaw;
      } else if (refRaw === "gcash" || refRaw === "paymaya" || refRaw === "cash") {
        payment_method = refRaw;
      }
    }
    const [items] = await pool.query(
      `SELECT
         si.sale_item_id,
         si.product_id,
         COALESCE(NULLIF(TRIM(p.name), ''), 'Product #' || CAST(si.product_id AS TEXT)) AS product_name,
         si.quantity,
         si.price,
         si.subtotal
       FROM sale_items si
       LEFT JOIN products p ON p.product_id = si.product_id
       WHERE si.sale_id = ?
       ORDER BY si.sale_item_id`,
      [req.params.id]
    );

    let has_open_issue = false;
    let issue_resolution_status = null;
    if (hasIssues) {
      const [openIssues] = await pool.query(
        "SELECT 1 FROM sale_issues WHERE sale_id = ? AND status = 'open' LIMIT 1",
        [req.params.id]
      );
      has_open_issue = openIssues.length > 0;
      const [resRows] = await pool.query(
        `SELECT status FROM sale_issues
         WHERE sale_id = ? AND status IN ('voided','refunded')
         ORDER BY resolved_at DESC, issue_id DESC
         LIMIT 1`,
        [req.params.id]
      );
      if (resRows && resRows.length > 0) {
        issue_resolution_status = resRows[0].status;
      }
    }

    const paymentRefDisplay = payRows && payRows.length > 0 ? (payRows[0].reference_number || null) : null;
    const rowSt = String(sales[0].status || "").toLowerCase();
    const issueResOut =
      issue_resolution_status ||
      (rowSt === "voided" || rowSt === "refunded" ? rowSt : null);
    const sale = {
      ...sales[0],
      customer_name: sales[0].customer_name || sales[0].walk_in_customer_name || "—",
      payment_method,
      reference_number: paymentRefDisplay,
      items,
      has_open_issue,
      issue_resolution_status: issueResOut,
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
    const {
      customer_id,
      customer_name,
      transaction_type,
      items,
      payment_method,
      amount_paid,
      reference_number: bodyRef,
      customer_contact,
      customer_address,
      receipt_number,
      sale_uuid: bodySaleUuid,
      saleUuid: bodySaleUuidAlt,
    } = req.body;
    const referenceNumber = (bodyRef != null && String(bodyRef).trim()) ? String(bodyRef).trim() : null;
    const saleUuidRaw = bodySaleUuid != null ? bodySaleUuid : bodySaleUuidAlt;
    const saleUuidForDb =
      saleUuidRaw != null && String(saleUuidRaw).trim()
        ? String(saleUuidRaw).trim()
        : null;
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
    const hasSaleUuid = columns.includes("sale_uuid");
    const hasSalesContactAddress = columns.includes("customer_contact") && columns.includes("customer_address");
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

    // Generate O.R. / receipt number if column exists.
    // If the client provides a receipt_number (e.g. C01-20260305-000123), use it as-is
    // so that the customer-facing receipt is never replaced.
    let orNumber = null;
    if (hasOrNumber) {
      if (typeof receipt_number === "string" && receipt_number.trim()) {
        orNumber = receipt_number.trim();
      } else {
        const [maxOr] = await conn.query(
          "SELECT MAX(CAST(REPLACE(or_number, 'OR-', '') AS INTEGER)) AS max_num FROM sales WHERE or_number IS NOT NULL AND or_number LIKE 'OR-%'"
        );
        const nextNum = (maxOr[0]?.max_num || 0) + 1;
        orNumber = `OR-${String(nextNum).padStart(3, "0")}`;
      }
    }

    // Build INSERT query based on whether new columns exist
    let insertQuery, insertValues;
    if (hasNewColumns && hasOrNumber && hasSalesContactAddress) {
      insertQuery = `INSERT INTO sales (customer_id, customer_name, transaction_type, customer_contact, customer_address, or_number, total_amount, amount_paid, remaining_balance, status, sale_date)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'))`;
      insertValues = [custId, customer_name.trim(), transaction_type, contact, address, orNumber, totalAmount, paid, remaining, status];
    } else if (hasNewColumns && hasOrNumber) {
      insertQuery = `INSERT INTO sales (customer_id, customer_name, transaction_type, or_number, total_amount, amount_paid, remaining_balance, status, sale_date)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'))`;
      insertValues = [custId, customer_name.trim(), transaction_type, orNumber, totalAmount, paid, remaining, status];
    } else if (hasNewColumns && hasSalesContactAddress) {
      insertQuery = `INSERT INTO sales (customer_id, customer_name, transaction_type, customer_contact, customer_address, total_amount, amount_paid, remaining_balance, status, sale_date)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'))`;
      insertValues = [custId, customer_name.trim(), transaction_type, contact, address, totalAmount, paid, remaining, status];
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

    if (hasSaleUuid && saleUuidForDb) {
      await conn.query("UPDATE sales SET sale_uuid = ? WHERE sale_id = ?", [
        saleUuidForDb,
        saleId,
      ]);
    }

    // Defensive cleanup: if this local sale_id was previously used by stale pulled data
    // (e.g. mapped central issue rows from an older branch session), remove them so a
    // brand-new sale does not appear auto-flagged.
    try {
      await conn.query("DELETE FROM sale_issues WHERE sale_id = ?", [saleId]);
    } catch (_) {}

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
      // Keep only the latest 50 activity entries (local-only, not synced to central)
      await conn.query(
        `DELETE FROM activity_log
         WHERE activity_id NOT IN (
           SELECT activity_id FROM activity_log
           ORDER BY created_at DESC, activity_id DESC
           LIMIT 50
         )`
      );
    } catch (activityErr) {
      console.warn("activity_log insert/trim failed (sale):", activityErr?.message || activityErr);
    }

    await conn.commit();

    // Build SELECT query based on whether new columns exist (reuse variables declared earlier)
    let selectQuery;
    if (hasCustomerName) {
      selectQuery = `SELECT s.sale_id AS id, s.customer_id, COALESCE(c.name, s.customer_name) AS customer_name,
                            s.customer_name AS walk_in_customer_name, ${hasTransactionType ? 's.transaction_type' : 'NULL AS transaction_type'},
                            ${hasOrNumber ? 's.or_number' : 'NULL AS or_number'},
                            ${hasSaleUuid ? 's.sale_uuid' : 'NULL AS sale_uuid'},
                            s.total_amount, s.amount_paid, s.remaining_balance, s.status,
                            s.sale_date,
                            c.contact AS customer_contact,
                            c.address AS customer_address
                     FROM sales s LEFT JOIN customers c ON c.customer_id = s.customer_id
                     WHERE s.sale_id = ?`;
    } else {
      selectQuery = `SELECT s.sale_id AS id, s.customer_id, c.name AS customer_name,
                            NULL AS walk_in_customer_name, NULL AS transaction_type,
                            ${hasOrNumber ? 's.or_number' : 'NULL AS or_number'},
                            ${hasSaleUuid ? 's.sale_uuid' : 'NULL AS sale_uuid'},
                            s.total_amount, s.amount_paid, s.remaining_balance, s.status,
                            s.sale_date,
                            c.contact AS customer_contact,
                            c.address AS customer_address
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
      reference_number: referenceNumber || null,
      or_number: newSale[0].or_number || orNumber || null,
      customer_contact: newSale[0].customer_contact ?? contact ?? null,
      customer_address: newSale[0].customer_address ?? address ?? null,
      items: newItems.map((i) => ({ ...i, product_name: productMap[i.product_id]?.name || "" })),
    };

    // Log sale + items for later central sync (includes actual ref no. for GCash/PayMaya)
    await logChange("sale", saleWithItems.id, "create", saleWithItems);

    return res.status(201).json({ sale: saleWithItems });
  } catch (err) {
    await conn.rollback();
    console.error("POST /api/sales:", err);
    return res.status(400).json({ message: err.message || "Failed to create sale." });
  } finally {
    conn.release();
  }
});

// POST /api/sales/:id/issues - cashier/staff flag an issue on a sale (stored in local SQLite, synced later)
router.post("/:id/issues", async (req, res) => {
  try {
    const saleId = parseInt(req.params.id, 10);
    if (!saleId || Number.isNaN(saleId) || saleId <= 0) {
      return res.status(400).json({ message: "Invalid sale ID." });
    }

    if (!hasSaleIssuesTable()) {
      return res.status(500).json({ message: "Issue tracking is not configured in the local database." });
    }

    const { reason, note } = req.body || {};
    const allowedReasons = ["wrong_item", "pricing_error", "duplicate", "payment_issue", "other"];
    if (!reason || !allowedReasons.includes(reason)) {
      return res.status(400).json({ message: "Reason is required and must be one of: wrong_item, pricing_error, duplicate, payment_issue, other." });
    }
    const trimmedNote = typeof note === "string" ? note.trim() : "";
    if (trimmedNote.length > 2000) {
      return res.status(400).json({ message: "Note must be 2000 characters or fewer." });
    }

    // Ensure sale exists locally
    const [sales] = await pool.query(
      "SELECT sale_id FROM sales WHERE sale_id = ?",
      [saleId]
    );
    if (!sales || sales.length === 0) {
      return res.status(404).json({ message: "Sale not found." });
    }

    // Support different token payload shapes: { id }, { userId }, or { user_id }
    const cashierId =
      req.user?.id ??
      req.user?.userId ??
      req.user?.user_id ??
      null;
    const cashierName = req.user?.name || req.user?.username || null;
    if (!cashierId) {
      return res.status(400).json({ message: "Authenticated user information is missing from token." });
    }

    const [result] = await pool.query(
      `INSERT INTO sale_issues (sale_id, reason, note, status, cashier_id, cashier_name, created_at)
       VALUES (?, ?, ?, 'open', ?, ?, datetime('now','localtime'))`,
      [saleId, reason, trimmedNote || null, cashierId, cashierName]
    );

    const [rows] = await pool.query(
      `SELECT issue_id, sale_id, reason, note, status, cashier_id, cashier_name,
              created_at, resolved_by_admin_id, resolved_by_admin_name,
              resolution_note, resolution_action, resolved_at
       FROM sale_issues
       WHERE issue_id = ?`,
      [result.insertId]
    );

    const issue = rows[0];
    // Log for central sync (entity_type 'sale_issue')
    await logChange("sale_issue", issue.issue_id, "create", issue);

    scheduleCentralPush();
    return res.status(201).json({ issue });
  } catch (err) {
    console.error("POST /api/sales/:id/issues:", err);
    return res.status(500).json({ message: "Failed to flag issue for sale." });
  }
});

// GET /api/sales/:id/issues - admin review of all flags for a sale (from local SQLite)
router.get("/:id/issues", requireAdmin, async (req, res) => {
  try {
    const saleId = parseInt(req.params.id, 10);
    if (!saleId || Number.isNaN(saleId) || saleId <= 0) {
      return res.status(400).json({ message: "Invalid sale ID." });
    }

    if (!hasSaleIssuesTable()) {
      return res.json({ issues: [] });
    }

    const [rows] = await pool.query(
      `SELECT issue_id, sale_id, reason, note, status, cashier_id, cashier_name,
              created_at, resolved_by_admin_id, resolved_by_admin_name,
              resolution_note, resolution_action, resolved_at
       FROM sale_issues
       WHERE sale_id = ?
       ORDER BY created_at DESC, issue_id DESC`,
      [saleId]
    );

    return res.json({ issues: rows || [] });
  } catch (err) {
    console.error("GET /api/sales/:id/issues:", err);
    return res.status(500).json({ message: "Failed to load sale issues." });
  }
});

// PUT /api/sales/:id/issues/:issueId - admin resolves/updates a flagged issue (stored locally + synced)
router.put("/:id/issues/:issueId", requireAdmin, async (req, res) => {
  try {
    const saleId = parseInt(req.params.id, 10);
    const issueId = parseInt(req.params.issueId, 10);
    if (!saleId || Number.isNaN(saleId) || saleId <= 0) {
      return res.status(400).json({ message: "Invalid sale ID." });
    }
    if (!issueId || Number.isNaN(issueId) || issueId <= 0) {
      return res.status(400).json({ message: "Invalid issue ID." });
    }

    if (!hasSaleIssuesTable()) {
      return res.status(400).json({ message: "Issue tracking is not configured in the local database." });
    }

    const { resolution_note, resolution_action, status } = req.body || {};
    const trimmedNote = typeof resolution_note === "string" ? resolution_note.trim() : "";
    if (!trimmedNote) {
      return res.status(400).json({ message: "Resolution note is required." });
    }
    if (trimmedNote.length > 4000) {
      return res.status(400).json({ message: "Resolution note must be 4000 characters or fewer." });
    }

    const allowedActions = ["resolved", "edit", "void", "refund", "other"];
    const action =
      typeof resolution_action === "string" && allowedActions.includes(resolution_action)
        ? resolution_action
        : "resolved";

    let newStatus = "resolved";
    if (status === "voided" || action === "void") newStatus = "voided";
    else if (status === "refunded" || action === "refund") newStatus = "refunded";

    const [issues] = await pool.query(
      "SELECT issue_id, sale_id, status FROM sale_issues WHERE issue_id = ? AND sale_id = ?",
      [issueId, saleId]
    );
    if (!issues || issues.length === 0) {
      return res.status(404).json({ message: "Issue not found for this sale." });
    }

    // Resolve issue using the authenticated admin's identity from the token
    const adminId =
      req.user?.id ??
      req.user?.userId ??
      req.user?.user_id ??
      null;
    const adminName = req.user?.name || req.user?.username || null;

    await pool.query(
      `UPDATE sale_issues
       SET status = ?, resolution_note = ?, resolution_action = ?, 
           resolved_by_admin_id = ?, resolved_by_admin_name = ?, resolved_at = datetime('now','localtime')
       WHERE issue_id = ?`,
      [
        newStatus,
        trimmedNote,
        action,
        adminId,
        adminName,
        issueId,
      ]
    );

    // Keep sales.status aligned with void/refund so customer aggregates and GET /sales/:id match list badges.
    if (newStatus === "voided" || newStatus === "refunded") {
      await pool.query("UPDATE sales SET status = ? WHERE sale_id = ?", [newStatus, saleId]);
      await logChange("sale", saleId, "update", { sale_id: saleId, status: newStatus });
    }

    const [rows] = await pool.query(
      `SELECT issue_id, sale_id, reason, note, status, cashier_id, cashier_name,
              created_at, resolved_by_admin_id, resolved_by_admin_name,
              resolution_note, resolution_action, resolved_at
       FROM sale_issues
       WHERE issue_id = ?`,
      [issueId]
    );

    const issue = rows[0];
    await logChange("sale_issue", issue.issue_id, "update", issue);

    scheduleCentralPush();
    return res.json({ issue });
  } catch (err) {
    console.error("PUT /api/sales/:id/issues/:issueId:", err);
    return res.status(500).json({ message: "Failed to update sale issue." });
  }
});

// PUT /api/sales/:id/restore-status - restore a void/refund sale back to paid/unpaid.
// This endpoint is intentionally NOT requireAdmin-token-only; it verifies the admin password instead,
// so staff can restore without switching accounts.
router.put("/:id/restore-status", async (req, res) => {
  try {
    const saleId = parseInt(req.params.id, 10);
    const { status, admin_password: adminPassword } = req.body || {};

    if (!saleId || Number.isNaN(saleId) || saleId <= 0) {
      return res.status(400).json({ message: "Invalid sale ID." });
    }
    const desiredStatus =
      typeof status === "string" && ["paid", "unpaid"].includes(status.toLowerCase())
        ? status.toLowerCase()
        : null;
    if (!desiredStatus) {
      return res.status(400).json({ message: "status must be 'paid' or 'unpaid'." });
    }
    if (typeof adminPassword !== "string" || !adminPassword.trim()) {
      return res.status(400).json({ message: "Admin password is required." });
    }

    // Verify admin password (any account with role=admin).
    const [adminRows] = await pool.query(
      "SELECT user_id, name, username, password_hash FROM users WHERE role = 'admin' LIMIT 1",
      []
    );
    const adminRow = Array.isArray(adminRows) && adminRows.length ? adminRows[0] : null;
    if (!adminRow || !adminRow.password_hash) {
      return res.status(500).json({ message: "Admin account is not configured." });
    }

    const ok = await bcrypt.compare(String(adminPassword).trim(), adminRow.password_hash);
    if (!ok) {
      return res.status(401).json({ message: "Invalid admin password." });
    }

    const [saleRows] = await pool.query(
      "SELECT sale_id, customer_id, total_amount, amount_paid, remaining_balance FROM sales WHERE sale_id = ? LIMIT 1",
      [saleId]
    );
    if (!saleRows || saleRows.length === 0) {
      return res.status(404).json({ message: "Sale not found." });
    }
    const sale = saleRows[0];
    const totalAmount = Number(sale.total_amount) || 0;
    const customerId = sale.customer_id != null ? Number(sale.customer_id) || null : null;
    const oldRemaining = Number(sale.remaining_balance) || 0;

    const newAmountPaid = desiredStatus === "paid" ? totalAmount : 0;
    const newRemaining = desiredStatus === "paid" ? 0 : totalAmount;

    await pool.query(
      "UPDATE sales SET amount_paid = ?, remaining_balance = ?, status = ? WHERE sale_id = ?",
      [newAmountPaid, newRemaining, desiredStatus, saleId]
    );

    if (customerId && Number.isFinite(customerId) && customerId > 0) {
      await pool.query(
        "UPDATE customers SET total_balance = total_balance - ? + ? WHERE customer_id = ?",
        [oldRemaining, newRemaining, customerId]
      );
    }

    // If there is a last void/refund issue record, mark it resolved so the UI stops treating it as void/refund.
    let restoredIssue = null;
    if (hasSaleIssuesTable()) {
      const [issueRows] = await pool.query(
        "SELECT issue_id, status FROM sale_issues WHERE sale_id = ? AND status IN ('voided','refunded') ORDER BY issue_id DESC LIMIT 1",
        [saleId]
      );
      if (issueRows && issueRows.length) {
        const issue = issueRows[0];
        const restoredFrom = String(issue.status || "").toLowerCase();
        const resolutionNote = `Restored from ${restoredFrom} back to ${desiredStatus}.`;
        await pool.query(
          `UPDATE sale_issues
           SET status = 'resolved',
               resolution_note = ?,
               resolution_action = 'resolved',
               resolved_by_admin_id = ?,
               resolved_by_admin_name = ?,
               resolved_at = datetime('now','localtime')
           WHERE issue_id = ?`,
          [resolutionNote, adminRow.user_id, adminRow.name || adminRow.username || null, issue.issue_id]
        );
        restoredIssue = { issue_id: issue.issue_id, restoredFrom, desiredStatus };
      }
    }

    // Log for sync: update sale + (if exists) sale_issue.
    await logChange("sale", saleId, "update", {
      sale_id: saleId,
      status: desiredStatus,
      total_amount: totalAmount,
      amount_paid: newAmountPaid,
      remaining_balance: newRemaining,
      customer_id: customerId,
    });

    if (restoredIssue && restoredIssue.issue_id) {
      await logChange("sale_issue", restoredIssue.issue_id, "update", {
        issue_id: restoredIssue.issue_id,
        sale_id: saleId,
        status: "resolved",
        resolution_action: "resolved",
      });
    }

    scheduleCentralPush();
    return res.json({ message: `Sale restored to ${desiredStatus}.` });
  } catch (err) {
    console.error("PUT /api/sales/:id/restore-status:", err);
    return res.status(500).json({ message: "Failed to restore sale status." });
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

    // Log payment into activity_log (for dashboard recent activity)
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
      // Keep only the latest 50 activity entries (local-only, not synced to central)
      await conn.query(
        `DELETE FROM activity_log
         WHERE activity_id NOT IN (
           SELECT activity_id FROM activity_log
           ORDER BY created_at DESC, activity_id DESC
           LIMIT 50
         )`
      );
    } catch (activityErr) {
      console.warn("activity_log insert/trim failed (payment):", activityErr?.message || activityErr);
    }

    await conn.commit();

    // Log payment change for sync
    await logChange("payment", saleId, "create", {
      sale_id: saleId,
      amount_paid: amountRounded,
      payment_method: payMethod,
      reference_number: paymentRef,
    });

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
