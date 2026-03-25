import express from "express";
import pool, { tableHasColumn, getTableColumns } from "../db.js";
import { authenticateToken } from "../middleware/authMiddleware.js";
import { logChange } from "../changeLog.js";
import { sendMail } from "../utils/mailer.js";

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

function formatMoneyPhp(n) {
  const v = Number(n || 0);
  return `₱${v.toFixed(2)}`;
}

async function hasSaleIssuesTable() {
  try {
    const cols = getTableColumns("sale_issues");
    return Array.isArray(cols) && cols.length > 0;
  } catch {
    return false;
  }
}

async function loadLatestSaleForCustomer(customerId) {
  const id = Number(customerId);
  if (!Number.isInteger(id) || id <= 0) return null;

  const hasOrNumber = tableHasColumn("sales", "or_number");
  const hasCustomerName = tableHasColumn("sales", "customer_name");
  const hasPaymentMethod = tableHasColumn("sales", "payment_method");

  const selectCustomerName = hasCustomerName
    ? "s.customer_name AS customer_name,"
    : "NULL AS customer_name,";
  const selectOr = hasOrNumber ? "s.or_number AS or_number," : "NULL AS or_number,";
  const selectPaymentMethod = hasPaymentMethod
    ? "s.payment_method AS payment_method,"
    : "NULL AS payment_method,";

  const [rows] = await pool.query(
    `SELECT
        s.sale_id AS id,
        s.sale_date,
        s.customer_id,
        ${selectCustomerName}
        ${selectOr}
        ${selectPaymentMethod}
        s.total_amount,
        s.amount_paid,
        s.remaining_balance,
        s.status
     FROM sales s
     WHERE s.customer_id = ?
     ORDER BY datetime(s.sale_date) DESC, s.sale_id DESC
     LIMIT 1`,
    [id]
  );

  const sale = rows && rows[0] ? rows[0] : null;
  if (!sale) return null;

  const [itemRows] = await pool.query(
    `SELECT p.name AS product_name, si.quantity, si.price, si.subtotal
     FROM sale_items si
     LEFT JOIN products p ON p.product_id = si.product_id
     WHERE si.sale_id = ?
     ORDER BY si.sale_item_id ASC`,
    [sale.id]
  );
  sale.items = Array.isArray(itemRows) ? itemRows : [];
  return sale;
}

function buildReceiptHtmlForEmail({ customerName, sale }) {
  if (!sale) return "";
  const totalAmount = Number(sale.total_amount || 0);
  const amountPaid = Number(sale.amount_paid || 0);
  const balance = Number(sale.remaining_balance || 0);
  const orNumber = sale.or_number || "";

  const items = (Array.isArray(sale.items) ? sale.items : [])
    .map(
      (i) =>
        `<tr><td style="padding:6px 8px;border-bottom:1px solid #eee;">${escapeHtml(
          i.product_name || ""
        )}</td><td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right;">${Number(
          i.quantity || 0
        )}</td><td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right;white-space:nowrap;">${escapeHtml(
          formatMoneyPhp(i.price || 0)
        )}</td><td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right;white-space:nowrap;">${escapeHtml(
          formatMoneyPhp(i.subtotal || 0)
        )}</td></tr>`
    )
    .join("");

  return `
    <div style="margin-top:16px;border-top:1px solid #eee;padding-top:12px;">
      <div style="font-weight:700;margin-bottom:6px;">Receipt (latest outstanding sale)</div>
      <div style="font-size:13px;color:#444;margin-bottom:8px;">
        <div><strong>Sale #</strong> ${escapeHtml(String(orNumber || sale.id || "—"))}</div>
        <div><strong>Customer</strong> ${escapeHtml(customerName || sale.customer_name || "—")}</div>
      </div>
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:13px;">
        <thead>
          <tr>
            <th align="left" style="padding:6px 8px;border-bottom:1px solid #ddd;background:#f8f9fa;">Description</th>
            <th align="right" style="padding:6px 8px;border-bottom:1px solid #ddd;background:#f8f9fa;">Qty</th>
            <th align="right" style="padding:6px 8px;border-bottom:1px solid #ddd;background:#f8f9fa;">Unit</th>
            <th align="right" style="padding:6px 8px;border-bottom:1px solid #ddd;background:#f8f9fa;">Amount</th>
          </tr>
        </thead>
        <tbody>${items}</tbody>
      </table>
      <div style="margin-top:10px;font-size:13px;">
        <div style="display:flex;justify-content:space-between;"><span>Total</span><span style="white-space:nowrap;">${escapeHtml(formatMoneyPhp(totalAmount))}</span></div>
        <div style="display:flex;justify-content:space-between;"><span>Paid</span><span style="white-space:nowrap;">${escapeHtml(formatMoneyPhp(amountPaid))}</span></div>
        <div style="display:flex;justify-content:space-between;font-weight:700;"><span>Balance</span><span style="white-space:nowrap;">${escapeHtml(formatMoneyPhp(Math.max(0, balance)))}</span></div>
      </div>
    </div>
  `;
}

router.get("/", async (req, res) => {
  try {
    const q = (req.query.q || "").trim();
    const hasSalesCustomerName = tableHasColumn("sales", "customer_name");
    const hasSalesContactAddress = tableHasColumn("sales", "customer_contact") && tableHasColumn("sales", "customer_address");
    const hasOrNumber = tableHasColumn("sales", "or_number");

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
      `SELECT s.customer_id, s.customer_name, s.sale_id, ${hasOrNumber ? "s.or_number AS or_number" : "NULL AS or_number"}, s.sale_date, s.total_amount, s.amount_paid, s.remaining_balance, s.status,
              p.name AS product_name, si.quantity, si.price, si.subtotal
       FROM sale_items si
       JOIN sales s ON si.sale_id = s.sale_id
       JOIN products p ON si.product_id = p.product_id
       ORDER BY s.sale_date DESC, s.sale_id DESC`
    );

    let issueStatusBySale = {};
    const issuesEnabled = await hasSaleIssuesTable();
    if (issuesEnabled && Array.isArray(detailRows) && detailRows.length > 0) {
      const saleIds = Array.from(
        new Set(
          detailRows
            .map((r) => r.sale_id)
            .filter((id) => id != null)
        )
      );
      if (saleIds.length) {
        const [issueRows] = await pool.query(
          `SELECT sale_id, status
           FROM sale_issues
           WHERE sale_id IN (?)
           ORDER BY datetime(created_at) DESC, issue_id DESC`,
          [saleIds]
        );
        for (const row of issueRows || []) {
          if (!row || row.sale_id == null) continue;
          const s = String(row.status || "").toLowerCase();
          if (!issueStatusBySale[row.sale_id] && (s === "voided" || s === "refunded")) {
            issueStatusBySale[row.sale_id] = s;
          }
        }
      }
    }

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
        const mergedStatus = issueStatusBySale[sid] || row.status;
        byCustomer[k].transactions[sid] = {
          sale_id: sid,
          or_number: row.or_number || null,
          sale_date: row.sale_date,
          total_amount: row.total_amount,
          amount_paid: row.amount_paid,
          remaining_balance: row.remaining_balance,
          status: mergedStatus,
          issue_resolution_status: issueStatusBySale[sid] || null,
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

router.post("/:id/remind-balance", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ message: "Invalid customer ID." });

    const subjectFromBody =
      typeof req.body?.subject === "string" ? req.body.subject.trim() : "";
    const textFromBody =
      typeof req.body?.text === "string" ? req.body.text.trim() : "";

    const hasEmailCol = tableHasColumn("customers", "email");
    const selectEmail = hasEmailCol ? ", email" : "";
    const [rows] = await pool.query(
      `SELECT customer_id AS id, name, contact, total_balance${selectEmail}
       FROM customers
       WHERE customer_id = ?
       LIMIT 1`,
      [id]
    );
    const customer = rows?.[0];
    if (!customer) return res.status(404).json({ message: "Customer not found." });

    const balance = Number(customer.total_balance || 0);
    if (!(balance > 0)) {
      return res.status(400).json({ message: "Customer has no outstanding balance." });
    }

    const contact = customer.contact != null ? String(customer.contact).trim() : "";
    const emailCol = hasEmailCol ? (customer.email != null ? String(customer.email).trim() : "") : "";
    const to = (emailCol && emailCol.includes("@")) ? emailCol : (contact.includes("@") ? contact : "");
    if (!to) {
      return res.status(400).json({
        message:
          "No email found for this customer. Set the customer's contact to an email address (or add an email field).",
      });
    }

    const name = customer.name || "Customer";
    const amount = `₱${balance.toFixed(2)}`;
    const text =
      textFromBody ||
      `Hi ${name},\n\n` +
        `This is a reminder that you have an outstanding balance of ${amount}.\n\n` +
        `If you already paid, please ignore this message.\n\n` +
        `Thank you.`;
    const subject = subjectFromBody || "Outstanding Balance Reminder";

    const messageHtml = escapeHtml(text).replace(/\r?\n/g, "<br/>");
    const sale = await loadLatestSaleForCustomer(id);
    const receiptHtml = buildReceiptHtmlForEmail({ customerName: name, sale });
    const html = [
      "<!DOCTYPE html><html><head><meta charset='utf-8'><meta name='viewport' content='width=device-width, initial-scale=1.0'>",
      "<style>",
      "body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; margin: 0; padding: 24px; background: #f5f5f5; }",
      ".email-wrap { max-width: 560px; margin: 0 auto; background: #fff; border-radius: 10px; overflow: hidden; box-shadow: 0 2px 10px rgba(0,0,0,0.08); }",
      ".email-header { background: #2c3e50; padding: 14px 18px; color: #fff; font-weight: 700; }",
      ".email-body { padding: 20px 22px; color: #333; line-height: 1.6; font-size: 15px; }",
      ".message-box { background: #ffffff; border: 1px solid #dee2e6; border-radius: 8px; padding: 14px 16px; margin: 12px 0 0; }",
      ".email-footer { padding: 14px 22px; background: #f8f9fa; font-size: 12px; color: #6c757d; }",
      "</style></head><body>",
      "<div class='email-wrap'>",
      "<div class='email-header'>D&M Sales</div>",
      "<div class='email-body'>",
      `<p style="margin:0 0 8px;">Hi ${escapeHtml(name)},</p>`,
      `<div class='message-box'>${messageHtml}</div>`,
      receiptHtml || "",
      "</div>",
      "<div class='email-footer'>— D&M Sales Admin</div>",
      "</div></body></html>",
    ].join("");

    await sendMail({ to, subject, text, html });
    return res.json({ message: `Reminder sent to ${to}.` });
  } catch (err) {
    console.error("POST /api/customers/:id/remind-balance:", err);
    const msg =
      err?.code === "MAIL_NOT_CONFIGURED"
        ? "Email is not configured on the server. Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM."
        : "Failed to send reminder email.";
    return res.status(500).json({ message: msg });
  }
});

router.post("/remind-balance-bulk", async (req, res) => {
  try {
    const subjectFromBody =
      typeof req.body?.subject === "string" ? req.body.subject.trim() : "";
    const textFromBody =
      typeof req.body?.text === "string" ? req.body.text.trim() : "";
    const subject = subjectFromBody || "Outstanding Balance Reminder";

    const hasEmailCol = tableHasColumn("customers", "email");
    const selectEmail = hasEmailCol ? ", email" : "";
    const [rows] = await pool.query(
      `SELECT customer_id AS id, name, contact, total_balance${selectEmail}
       FROM customers
       WHERE total_balance > 0
       ORDER BY name`
    );
    const list = Array.isArray(rows) ? rows : [];
    if (list.length === 0) {
      return res.json({
        message: "No customers with outstanding balance.",
        sent: 0,
        skipped: 0,
        emailed: [],
        phoneOnly: [],
        noContact: [],
      });
    }

    const emailed = [];
    const phoneOnly = [];
    const noContact = [];

    const baseText =
      textFromBody ||
      `Hi,\n\n` +
        `This is a reminder that you have an outstanding balance with us.\n\n` +
        `If you already paid, please ignore this message.\n\n` +
        `Thank you.`;

    for (const c of list) {
      const name = c?.name || "Customer";
      const balance = Number(c?.total_balance || 0);
      if (!(balance > 0)) continue;

      const contact = c?.contact != null ? String(c.contact).trim() : "";
      const emailCol = hasEmailCol ? (c?.email != null ? String(c.email).trim() : "") : "";
      const to = (emailCol && emailCol.includes("@")) ? emailCol : (contact.includes("@") ? contact : "");
      if (!to) {
        const digits = contact.replace(/\D/g, "");
        if (digits.length >= 10) phoneOnly.push({ id: c.id, name, contact });
        else noContact.push({ id: c.id, name, contact });
        continue;
      }

      const text = baseText.replace(/^Hi\b.*?,/m, `Hi ${name},`);
      const messageHtml = escapeHtml(text).replace(/\r?\n/g, "<br/>");
      const sale = await loadLatestSaleForCustomer(c.id);
      const receiptHtml = buildReceiptHtmlForEmail({ customerName: name, sale });

      const html = [
        "<!DOCTYPE html><html><head><meta charset='utf-8'><meta name='viewport' content='width=device-width, initial-scale=1.0'>",
        "<style>",
        "body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; margin: 0; padding: 24px; background: #f5f5f5; }",
        ".email-wrap { max-width: 560px; margin: 0 auto; background: #fff; border-radius: 10px; overflow: hidden; box-shadow: 0 2px 10px rgba(0,0,0,0.08); }",
        ".email-header { background: #2c3e50; padding: 14px 18px; color: #fff; font-weight: 700; }",
        ".email-body { padding: 20px 22px; color: #333; line-height: 1.6; font-size: 15px; }",
        ".message-box { background: #ffffff; border: 1px solid #dee2e6; border-radius: 8px; padding: 14px 16px; margin: 12px 0 0; }",
        ".email-footer { padding: 14px 22px; background: #f8f9fa; font-size: 12px; color: #6c757d; }",
        "</style></head><body>",
        "<div class='email-wrap'>",
        "<div class='email-header'>D&M Sales</div>",
        "<div class='email-body'>",
        `<p style="margin:0 0 8px;">Hi ${escapeHtml(name)},</p>`,
        `<div class='message-box'>${messageHtml}</div>`,
        receiptHtml || "",
        "</div>",
        "<div class='email-footer'>— D&M Sales Admin</div>",
        "</div></body></html>",
      ].join("");

      await sendMail({ to, subject, text, html });
      emailed.push({ id: c.id, name, to });
    }

    return res.json({
      message: `Sent ${emailed.length} email(s).`,
      sent: emailed.length,
      skipped: phoneOnly.length + noContact.length,
      emailed,
      phoneOnly,
      noContact,
    });
  } catch (err) {
    console.error("POST /api/customers/remind-balance-bulk:", err);
    const msg =
      err?.code === "MAIL_NOT_CONFIGURED"
        ? "Email is not configured on the server. Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM."
        : "Failed to send bulk reminder emails.";
    return res.status(500).json({ message: msg });
  }
});

export default router;
