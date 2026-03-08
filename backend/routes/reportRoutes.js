import express from "express";
import { ObjectId } from "mongodb";
import { authenticateToken, requireAdmin } from "../middleware/authMiddleware.js";
import { getReportsDb, pingMongo } from "../mongoReports.js";

const router = express.Router();

// All report endpoints require an authenticated admin.
router.use(authenticateToken, requireAdmin);

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

function isObjectId(value) {
  return (
    value &&
    typeof value === "object" &&
    (value instanceof ObjectId ||
      (typeof value._bsontype === "string" && value._bsontype === "ObjectId"))
  );
}

function buildDayRange({ startDate, endDate }) {
  // Inclusive day range: [start 00:00, end+1 00:00)
  const start = new Date(startDate);
  start.setHours(0, 0, 0, 0);
  const endExclusive = new Date(endDate);
  endExclusive.setHours(0, 0, 0, 0);
  endExclusive.setDate(endExclusive.getDate() + 1);
  return { start, endExclusive };
}

async function pickTransactionCollectionName(db) {
  const collections = await db.listCollections({}, { nameOnly: true }).toArray();
  const names = (collections || []).map((c) => c.name).filter(Boolean);
  const nameSet = new Set(names);

  const prefer = [
    "sales",
    "transactions",
    "sales_transactions",
    "sale_transactions",
    "sales_raw",
  ];
  for (const n of prefer) {
    if (nameSet.has(n)) return n;
  }

  // Fallback heuristic: choose something that sounds like raw sales/transactions,
  // but avoid the pre-aggregated collections used for charts.
  const banned = new Set(["daily_sales", "top_products", "customer_balances"]);
  const candidates = names
    .filter((n) => !banned.has(n))
    .filter((n) => {
      const s = n.toLowerCase();
      if (s.includes("daily_sales") || s.includes("top_products") || s.includes("customer_balances")) return false;
      return s === "sales" || s.includes("sale") || s.includes("transaction");
    })
    .sort((a, b) => a.length - b.length);

  return candidates[0] || null;
}

async function countTransactionsInRange(col, { startDate, endDate }) {
  const { start, endExclusive } = buildDayRange({ startDate, endDate });
  const startISO = toISODateOnly(start);
  const endISO = toISODateOnly(new Date(endExclusive.getTime() - 1));

  // Try to infer a usable date field by sampling one document.
  const sample = await col.findOne({});
  const dateFields = ["sale_date", "saleDate", "date", "createdAt", "created_at", "timestamp"];

  if (sample && typeof sample === "object") {
    for (const f of dateFields) {
      if (!(f in sample)) continue;
      const v = sample[f];

      // Date object
      if (v instanceof Date) {
        const count = await col.countDocuments({ [f]: { $gte: start, $lt: endExclusive } });
        return { count, strategy: "dateField", field: f };
      }

      // Number epoch (ms or seconds)
      if (typeof v === "number" && Number.isFinite(v)) {
        const startMs = start.getTime();
        const endMs = endExclusive.getTime();
        // If stored as seconds, convert thresholds to seconds.
        const looksLikeSeconds = v > 0 && v < 10_000_000_000;
        const a = looksLikeSeconds ? Math.floor(startMs / 1000) : startMs;
        const b = looksLikeSeconds ? Math.floor(endMs / 1000) : endMs;
        const count = await col.countDocuments({ [f]: { $gte: a, $lt: b } });
        return { count, strategy: looksLikeSeconds ? "epochSecondsField" : "epochMsField", field: f };
      }

      // ISO-ish string date: best effort (works for "YYYY-MM-DD" and many "YYYY-MM-DD..." formats)
      if (typeof v === "string" && v.length >= 10) {
        // If stored as date-only string, lexical compare works.
        const count = await col.countDocuments({ [f]: { $gte: startISO, $lte: endISO } });
        return { count, strategy: "stringDateField", field: f };
      }
    }
  }

  // Fallback: ObjectId timestamp range (only works if _id is an ObjectId)
  if (sample && isObjectId(sample._id)) {
    const startOid = ObjectId.createFromTime(Math.floor(start.getTime() / 1000));
    const endOid = ObjectId.createFromTime(Math.floor(endExclusive.getTime() / 1000));
    const count = await col.countDocuments({ _id: { $gte: startOid, $lt: endOid } });
    return { count, strategy: "objectIdTime", field: "_id" };
  }

  return null;
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


function getDailyTotals(docs = []) {
  let totalSales = 0;
  let totalPayments = 0;
  let totalTransactions = 0;

  for (const d of docs) {
    totalSales += Number(d.totalSales ?? d.total_sales ?? d.sales ?? 0) || 0;
    totalPayments += Number(d.totalPayments ?? d.total_payments ?? d.payments ?? 0) || 0;

    // If you store per-day transaction counts in Mongo, we'll use it. Otherwise it stays 0.
    totalTransactions += Number(d.tx_count ?? d.total_tx ?? d.total_transactions ?? 0) || 0;
  }

  return { totalSales, totalPayments, totalTransactions };
}

function getOutstandingTotal(docs = []) {
  let outstandingBalance = 0;
  for (const d of docs) {
    outstandingBalance += Number(d.balance ?? d.totalBalance ?? d.total_balance ?? 0) || 0;
  }
  return { outstandingBalance };
}

// Generic "all reports" endpoint – reads pre-aggregated Mongo collections only.
router.get("/all", async (req, res) => {
  const maxPerCollection = Math.min(Number(req.query.limit || 500), 5000);

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

    // If a raw sales/transactions collection exists in the reports DB, use it for tx counts.
    // This keeps "Total Transactions" accurate even when daily_sales docs don't store tx_count.
    const txCollectionName = await pickTransactionCollectionName(db);
    const txCol = txCollectionName ? db.collection(txCollectionName) : null;
    const txInfoPromise = txCol ? countTransactionsInRange(txCol, { startDate, endDate }) : Promise.resolve(null);
    const prevTxInfoPromise = txCol ? countTransactionsInRange(txCol, { startDate: prevStartDate, endDate: prevEndDate }) : Promise.resolve(null);

    // Return only the collections used by the charts (no raw collection dump).
    const [dailySales, topProducts, customerBalances, prevDailySales, prevCustomerBalances, txInfo, prevTxInfo] =
      await Promise.all([
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
        .collection("daily_sales")
        .find({ date: { $gte: prevStart, $lte: prevEnd } })
        .sort({ date: 1 })
        .limit(maxPerCollection)
        .toArray(),
      db
        .collection("customer_balances")
        .find({})
        .limit(Math.min(maxPerCollection, 200))
        .toArray(),
      txInfoPromise,
      prevTxInfoPromise,
    ]);

    // Filter obviously test-like product names just in case.
    const filteredTopProducts = (topProducts || []).filter((d) => {
      const name = d.productName ?? d.product_name ?? d.name ?? "";
      return name ? !isTestLikeName(name) : true;
    });

    const totals = {
      ...getDailyTotals(dailySales),
      ...getOutstandingTotal(customerBalances),
    };
    const previous = {
      ...getDailyTotals(prevDailySales),
      ...getOutstandingTotal(prevCustomerBalances),
    };

    const txCount = typeof txInfo?.count === "number" && Number.isFinite(txInfo.count) ? txInfo.count : null;
    const prevTxCount =
      typeof prevTxInfo?.count === "number" && Number.isFinite(prevTxInfo.count)
        ? prevTxInfo.count
        : null;

    // Override tx counts if we were able to compute them from a raw transactions collection.
    if (txCount != null) totals.totalTransactions = txCount;
    if (prevTxCount != null) previous.totalTransactions = prevTxCount;

    // If we couldn't compute tx count from Mongo (and daily_sales doesn't contain tx_count),
    // return null so the UI shows "—" instead of a misleading 0.
    const txWasFromDailySales =
      Array.isArray(dailySales) &&
      dailySales.length > 0 &&
      dailySales.some((d) => d && (d.tx_count != null || d.total_tx != null || d.total_transactions != null));
    if (!txWasFromDailySales && txCount == null) {
      totals.totalTransactions = null;
    }
    if (prevTxCount == null) {
      const prevTxFromDailySales =
        Array.isArray(prevDailySales) &&
        prevDailySales.length > 0 &&
        prevDailySales.some((d) => d && (d.tx_count != null || d.total_tx != null || d.total_transactions != null));
      if (!prevTxFromDailySales && txCount == null) {
        previous.totalTransactions = null;
      }
    }

    res.json({
      limitPerCollection: maxPerCollection,
      data: {
        daily_sales: dailySales,
        top_products: filteredTopProducts,
        customer_balances: customerBalances,
      },
      summary: {
        range: { start, end },
        previousRange: { start: prevStart, end: prevEnd },
        totals,
        previous,
        meta: {
          txCollectionName: txCollectionName || null,
          txStrategy: txInfo?.strategy || (txWasFromDailySales ? "dailySalesTxField" : null),
          txField: txInfo?.field || (txWasFromDailySales ? "tx_count|total_tx|total_transactions" : null),
        },
        rebuiltAt: null,
      },
    });
  } catch (err) {
    console.error("reports /all error", err);
    res.status(500).json({ message: "Failed to load reports." });
  }
});

export default router;

