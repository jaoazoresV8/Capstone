import express from "express";
import { authenticateToken, requireAdmin } from "../middleware/authMiddleware.js";
import { getReportsDb, pingMongo } from "../mongoReports.js";
import pool from "../db.js";

const router = express.Router();

// All report endpoints require an authenticated admin.
router.use(authenticateToken, requireAdmin);

const REBUILD_TTL_MS = 30_000;
let lastRebuildAtMs = 0;
let rebuildPromise = null;

function toISODateOnly(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

function safeParseDateOnly(value) {
  if (!value) return null;
  const s = String(value).slice(0, 10);
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function normalizeProductName(name) {
  return (name || "").toString().replace(/\s+/g, " ").trim();
}

function isTestLikeName(name) {
  const n = normalizeProductName(name).toLowerCase();
  return n.includes("test") || n.includes("sample") || n.includes("dummy");
}

// Health check: verify Mongo is reachable.
router.get("/health", async (req, res) => {
  try {
    await pingMongo();
    res.json({ ok: true });
  } catch (err) {
    console.error("reports /health error", err);
    res.status(503).json({ ok: false, message: "MongoDB not reachable." });
  }
});

// Rebuild aggregated report collections in MongoDB from the central MySQL data.
async function rebuildAggregatedReports(db) {
  // ---- Daily sales & payments ----
  const [saleRows] = await pool.query(
    `SELECT DATE(s.sale_date) AS d, SUM(s.total_amount) AS total_sales
     FROM sales s
     WHERE NOT EXISTS (
       SELECT 1
       FROM sale_issues si
       WHERE si.sale_id = s.sale_id
         AND si.status IN ('voided','refunded')
     )
     GROUP BY DATE(s.sale_date)
     ORDER BY d`
  );
  const [paymentRows] = await pool.query(
    `SELECT DATE(payment_date) AS d, SUM(amount_paid) AS total_payments
     FROM payments
     GROUP BY DATE(payment_date)
     ORDER BY d`
  );

  const dailyMap = new Map();
  for (const row of saleRows || []) {
    const key = row.d ? row.d.toISOString().slice(0, 10) : "";
    if (!key) continue;
    if (!dailyMap.has(key)) dailyMap.set(key, { date: key, total_sales: 0, total_payments: 0 });
    dailyMap.get(key).total_sales += Number(row.total_sales || 0);
  }
  for (const row of paymentRows || []) {
    const key = row.d ? row.d.toISOString().slice(0, 10) : "";
    if (!key) continue;
    if (!dailyMap.has(key)) dailyMap.set(key, { date: key, total_sales: 0, total_payments: 0 });
    dailyMap.get(key).total_payments += Number(row.total_payments || 0);
  }
  const dailyDocs = Array.from(dailyMap.values()).sort((a, b) =>
    a.date.localeCompare(b.date)
  );

  const dailyCol = db.collection("daily_sales");
  await dailyCol.createIndex({ date: 1 });
  await dailyCol.deleteMany({});
  if (dailyDocs.length) {
    await dailyCol.insertMany(dailyDocs);
  }

  // ---- Top products by quantity sold ----
  const [topRows] = await pool.query(
    `SELECT p.product_id,
            p.name,
            IFNULL(SUM(si.quantity), 0) AS total_qty
     FROM sale_items si
     JOIN sales s ON s.sale_id = si.sale_id
     JOIN products p ON p.product_id = si.product_id
     WHERE NOT EXISTS (
       SELECT 1
       FROM sale_issues si2
       WHERE si2.sale_id = s.sale_id
         AND si2.status IN ('voided','refunded')
     )
     GROUP BY p.product_id, p.name`
  );
  const topDocs = (topRows || [])
    .map((r) => {
      const productName = normalizeProductName(r.name);
      return {
        product_id: r.product_id,
        product_name: productName,
        total_qty: Number(r.total_qty || 0),
      };
    })
    .filter((d) => d.product_name && !isTestLikeName(d.product_name));
  const topCol = db.collection("top_products");
  await topCol.createIndex({ total_qty: -1 });
  await topCol.deleteMany({});
  if (topDocs.length) {
    await topCol.insertMany(topDocs);
  }

  // ---- Customer balances ----
  const [custRows] = await pool.query(
    `SELECT customer_id AS id, name, total_balance
     FROM customers
     WHERE total_balance IS NOT NULL AND total_balance <> 0`
  );
  const balDocs = (custRows || []).map((r) => ({
    customer_id: r.id,
    customer_name: (r.name || "").toString().trim(),
    total_balance: Number(r.total_balance || 0),
  }));
  const balCol = db.collection("customer_balances");
  await balCol.createIndex({ total_balance: -1 });
  await balCol.deleteMany({});
  if (balDocs.length) {
    await balCol.insertMany(balDocs);
  }

  // ---- Voided & refunded sales (for separate reporting) ----
  const [voidRows] = await pool.query(
    `SELECT
       s.sale_id,
       s.or_number,
       s.customer_name,
       s.total_amount,
       s.amount_paid,
       s.remaining_balance,
       s.status AS sale_status,
       s.sale_date,
       si.issue_id,
       si.status AS issue_status,
       si.reason,
       si.note,
       si.resolution_note,
       si.resolution_action,
       si.cashier_name,
       si.resolved_by_admin_name,
       si.created_at,
       si.resolved_at
     FROM sale_issues si
     JOIN sales s ON s.sale_id = si.sale_id
     WHERE si.status IN ('voided','refunded')
     ORDER BY
       si.resolved_at IS NULL DESC,
       si.resolved_at DESC,
       si.created_at DESC`
  );

  const voidDocs = (voidRows || []).map((r) => ({
    sale_id: r.sale_id,
    or_number: r.or_number,
    customer_name: (r.customer_name || "").toString().trim(),
    total_amount: Number(r.total_amount || 0),
    amount_paid: Number(r.amount_paid || 0),
    remaining_balance: Number(r.remaining_balance || 0),
    sale_status: r.sale_status || null,
    sale_date: r.sale_date || null,
    issue_id: r.issue_id,
    issue_status: r.issue_status,
    reason: r.reason,
    note: r.note || null,
    resolution_note: r.resolution_note || null,
    resolution_action: r.resolution_action || null,
    cashier_name: r.cashier_name || null,
    resolved_by_admin_name: r.resolved_by_admin_name || null,
    created_at: r.created_at || null,
    resolved_at: r.resolved_at || null,
  }));

  const voidCol = db.collection("voided_refunded_sales");
  await voidCol.createIndex({ issue_status: 1, resolved_at: -1, created_at: -1 });
  await voidCol.deleteMany({});
  if (voidDocs.length) {
    await voidCol.insertMany(voidDocs);
  }
}

async function ensureAggregatesFresh(db, { force = false } = {}) {
  const now = Date.now();
  if (!force && now - lastRebuildAtMs < REBUILD_TTL_MS) return;

  if (rebuildPromise) {
    await rebuildPromise;
    return;
  }

  rebuildPromise = (async () => {
    await rebuildAggregatedReports(db);
    lastRebuildAtMs = Date.now();
  })();

  try {
    await rebuildPromise;
  } finally {
    rebuildPromise = null;
  }
}

async function computeSummary({ start, end, prevStart, prevEnd }) {
  const [salesRows] = await pool.query(
    `SELECT IFNULL(SUM(s.total_amount), 0) AS total_sales,
            COUNT(*) AS tx_count
     FROM sales s
     WHERE DATE(s.sale_date) BETWEEN ? AND ?
       AND NOT EXISTS (
         SELECT 1
         FROM sale_issues si
         WHERE si.sale_id = s.sale_id
           AND si.status IN ('voided','refunded')
       )`,
    [start, end]
  );

  const [paymentRows] = await pool.query(
    `SELECT IFNULL(SUM(amount_paid), 0) AS total_payments,
            COUNT(*) AS payment_count
     FROM payments
     WHERE DATE(payment_date) BETWEEN ? AND ?`,
    [start, end]
  );

  const [prevSalesRows] = await pool.query(
    `SELECT IFNULL(SUM(s.total_amount), 0) AS total_sales,
            COUNT(*) AS tx_count
     FROM sales s
     WHERE DATE(s.sale_date) BETWEEN ? AND ?
       AND NOT EXISTS (
         SELECT 1
         FROM sale_issues si
         WHERE si.sale_id = s.sale_id
           AND si.status IN ('voided','refunded')
       )`,
    [prevStart, prevEnd]
  );

  const [prevPaymentRows] = await pool.query(
    `SELECT IFNULL(SUM(amount_paid), 0) AS total_payments,
            COUNT(*) AS payment_count
     FROM payments
     WHERE DATE(payment_date) BETWEEN ? AND ?`,
    [prevStart, prevEnd]
  );

  const [outstandingRows] = await pool.query(
    `SELECT IFNULL(SUM(total_balance), 0) AS outstanding_balance
     FROM customers`
  );

  return {
    totals: {
      totalSales: Number(salesRows?.[0]?.total_sales || 0),
      totalPayments: Number(paymentRows?.[0]?.total_payments || 0),
      outstandingBalance: Number(outstandingRows?.[0]?.outstanding_balance || 0),
      totalTransactions: Number(salesRows?.[0]?.tx_count || 0),
      salesTransactions: Number(salesRows?.[0]?.tx_count || 0),
      paymentTransactions: Number(paymentRows?.[0]?.payment_count || 0),
    },
    previous: {
      totalSales: Number(prevSalesRows?.[0]?.total_sales || 0),
      totalPayments: Number(prevPaymentRows?.[0]?.total_payments || 0),
      totalTransactions: Number(prevSalesRows?.[0]?.tx_count || 0),
      salesTransactions: Number(prevSalesRows?.[0]?.tx_count || 0),
      paymentTransactions: Number(prevPaymentRows?.[0]?.payment_count || 0),
    },
  };
}

async function persistSummaryToMongo(db, summaryDoc) {
  if (!db || !summaryDoc) return;
  const col = db.collection("reports_summary");
  await col.createIndex({ computed_at: -1 });
  await col.updateOne(
    { _id: "kpi:latest" },
    { $set: summaryDoc },
    { upsert: true }
  );
  // Also keep a range-specific snapshot (helps debugging and auditing).
  if (summaryDoc?.range?.start && summaryDoc?.range?.end) {
    const rangeId = `kpi:${summaryDoc.range.start}:${summaryDoc.range.end}`;
    await col.updateOne(
      { _id: rangeId },
      { $set: summaryDoc },
      { upsert: true }
    );
  }
}

// Generic "all reports" endpoint – rebuilds from MySQL, then returns Mongo collections.
router.get("/all", async (req, res) => {
  const maxPerCollection = Math.min(Number(req.query.limit || 500), 5000);
  const force = String(req.query.force || "") === "1";

  const endDate = safeParseDateOnly(req.query.end) || new Date();
  const startDate =
    safeParseDateOnly(req.query.start) || addDays(endDate, -29);

  const start = toISODateOnly(startDate);
  const end = toISODateOnly(endDate);

  const rangeDays =
    Math.max(1, Math.round((endDate.getTime() - startDate.getTime()) / 86400000) + 1);
  const prevEndDate = addDays(startDate, -1);
  const prevStartDate = addDays(prevEndDate, -(rangeDays - 1));
  const prevStart = toISODateOnly(prevStartDate);
  const prevEnd = toISODateOnly(prevEndDate);

  try {
    const db = await getReportsDb();

    // Rebuild aggregates periodically (or when forced) so it stays fresh but fast.
    await ensureAggregatesFresh(db, { force });

    // Return only the collections used by the charts (no raw collection dump).
    const [dailySales, topProducts, customerBalances, voidedRefunded, summary] = await Promise.all([
      db
        .collection("daily_sales")
        .find({ date: { $gte: start, $lte: end } })
        .sort({ date: 1 })
        .limit(maxPerCollection)
        .toArray(),
      db
        .collection("top_products")
        .find({})
        .sort({ total_qty: -1 })
        .limit(Math.min(maxPerCollection, 200))
        .toArray(),
      db
        .collection("customer_balances")
        .find({})
        .sort({ total_balance: -1 })
        .limit(Math.min(maxPerCollection, 200))
        .toArray(),
      db
        .collection("voided_refunded_sales")
        .find({})
        .sort({ issue_status: 1, resolved_at: -1, created_at: -1 })
        .limit(Math.min(maxPerCollection, 500))
        .toArray(),
      computeSummary({ start, end, prevStart, prevEnd }),
    ]);

    const summaryPayload = {
      computed_at: new Date().toISOString(),
      range: { start, end },
      previousRange: { start: prevStart, end: prevEnd },
      ...summary,
      rebuiltAt: lastRebuildAtMs ? new Date(lastRebuildAtMs).toISOString() : null,
    };

    // Persist KPIs in Mongo so other devices can read the same totals.
    try {
      await persistSummaryToMongo(db, summaryPayload);
    } catch (e) {
      console.warn("persistSummaryToMongo failed", e?.message || e);
    }

    res.json({
      limitPerCollection: maxPerCollection,
      data: {
        daily_sales: dailySales,
        top_products: topProducts,
        customer_balances: customerBalances,
        voided_refunded: voidedRefunded,
      },
      summary: summaryPayload,
    });
  } catch (err) {
    console.error("reports /all error", err);
    res.status(500).json({ message: "Failed to load reports." });
  }
});

export default router;