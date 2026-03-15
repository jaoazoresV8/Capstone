import express from "express";
import pool from "../db.js";
import { authenticateToken } from "../middleware/authMiddleware.js";

const router = express.Router();
router.use(authenticateToken);

// GET /api/dashboard/overview - stats + top products + recent activity
router.get("/overview", async (req, res) => {
  try {
    // Today's sales (amount, count, max amount, last sale time)
    const [todayRows] = await pool.query(
      `SELECT IFNULL(SUM(total_amount), 0) AS total_amount,
              COUNT(*) AS tx_count,
              IFNULL(MAX(total_amount), 0) AS max_amount,
              MAX(sale_date) AS last_sale_at
       FROM sales
       WHERE date(sale_date) = date('now','localtime')`
    );
    const todaySalesAmount = todayRows[0]?.total_amount || 0;
    const todaySalesCount = todayRows[0]?.tx_count || 0;
    const todayMaxSaleAmount = todayRows[0]?.max_amount || 0;
    const todayLastSaleAt = todayRows[0]?.last_sale_at || null;

    // Outstanding balances (sum + number of customers with balance)
    const [balanceRows] = await pool.query(
      `SELECT IFNULL(SUM(total_balance), 0) AS total_balance,
              SUM(CASE WHEN total_balance > 0 THEN 1 ELSE 0 END) AS customers_with_balance
       FROM customers`
    );
    const outstandingBalance = balanceRows[0]?.total_balance || 0;
    const customersWithBalance = balanceRows[0]?.customers_with_balance || 0;

    // Low stock items (<= 10) + basic breakdown + sample list
    const [lowStockRows] = await pool.query(
      `SELECT
         COUNT(*) AS low_stock_count,
         SUM(CASE WHEN stock_quantity = 0 THEN 1 ELSE 0 END) AS critical_count,
         SUM(CASE WHEN stock_quantity > 0 AND stock_quantity <= 10 THEN 1 ELSE 0 END) AS low_count
       FROM products
       WHERE stock_quantity <= 10`
    );
    const lowStockCount = lowStockRows[0]?.low_stock_count || 0;
    const lowStockCriticalCount = lowStockRows[0]?.critical_count || 0;
    const lowStockBelowMinCount = lowStockRows[0]?.low_count || 0;

    const [lowStockProductRows] = await pool.query(
      `SELECT product_id AS id, name, stock_quantity
       FROM products
       WHERE stock_quantity <= 10
       ORDER BY stock_quantity ASC, name ASC
       LIMIT 5`
    );
    const lowStockProducts = (lowStockProductRows || []).map((r) => ({
      id: r.id,
      name: r.name,
      stock_quantity: r.stock_quantity,
    }));
    const topLowStockProductName = lowStockProducts[0]?.name || null;

    // Top 5 products by sales this month (by total amount); fallback to all-time if this month is empty
    let topProducts = [];
    try {
      const [topRows] = await pool.query(
        `SELECT p.product_id,
                p.name,
                IFNULL(SUM(si.quantity), 0) AS total_qty,
                IFNULL(SUM(si.subtotal), 0) AS total_amount
         FROM sale_items si
         JOIN sales s ON s.sale_id = si.sale_id
         JOIN products p ON p.product_id = si.product_id
         WHERE strftime('%Y-%m', s.sale_date) = strftime('%Y-%m', 'now','localtime')
         GROUP BY p.product_id, p.name
         ORDER BY total_amount DESC
         LIMIT 5`
      );
      topProducts = (topRows || []).map((r) => ({
        product_id: r.product_id,
        name: r.name,
        total_qty: r.total_qty,
        total_amount: r.total_amount,
      }));
      if (topProducts.length === 0) {
        const [allTimeRows] = await pool.query(
          `SELECT p.product_id,
                  p.name,
                  IFNULL(SUM(si.quantity), 0) AS total_qty,
                  IFNULL(SUM(si.subtotal), 0) AS total_amount
           FROM sale_items si
           JOIN sales s ON s.sale_id = si.sale_id
           JOIN products p ON p.product_id = si.product_id
           GROUP BY p.product_id, p.name
           ORDER BY total_amount DESC
           LIMIT 5`
        );
        topProducts = (allTimeRows || []).map((r) => ({
          product_id: r.product_id,
          name: r.name,
          total_qty: r.total_qty,
          total_amount: r.total_amount,
        }));
        console.log("[Dashboard] Top 5 products: this month had 0 rows, using all-time fallback, count =", topProducts.length);
      } else {
        console.log("[Dashboard] Top 5 products: this month count =", topProducts.length);
      }
    } catch (topErr) {
      console.warn("GET /api/dashboard/overview: top products failed:", topErr?.message || topErr);
    }

    // Recent activity: merge latest sales and payments (no dependency on activity_log)
    let recentActivity = [];
    try {
      const [salesRows] = await pool.query(
        `SELECT sale_id, total_amount, sale_date, amount_paid, remaining_balance
         FROM sales
         ORDER BY sale_date DESC
         LIMIT 10`
      );
      const [paymentsRows] = await pool.query(
        `SELECT p.sale_id, p.amount_paid, p.payment_date, p.payment_method
         FROM payments p
         ORDER BY p.payment_date DESC
         LIMIT 10`
      );
      const items = [];
      (salesRows || []).forEach((r) => {
        items.push({
          type: "sale",
          title: `Sale #${r.sale_id}`,
          details: `₱${Number(r.total_amount || 0).toFixed(2)}`,
          amount: Number(r.total_amount || 0),
          created_at: r.sale_date,
        });
      });
      (paymentsRows || []).forEach((r) => {
        const method = (r.payment_method || "cash").toLowerCase();
        const methodLabel = method === "gcash" ? "GCash" : method === "paymaya" ? "PayMaya" : "Cash";
        items.push({
          type: "payment",
          title: `Payment for sale #${r.sale_id}`,
          details: `${methodLabel} · ₱${Number(r.amount_paid || 0).toFixed(2)}`,
          amount: Number(r.amount_paid || 0),
          created_at: r.payment_date,
        });
      });
      items.sort((a, b) => {
        const tA = a.created_at ? new Date(a.created_at).getTime() : 0;
        const tB = b.created_at ? new Date(b.created_at).getTime() : 0;
        return tB - tA;
      });
      recentActivity = items.slice(0, 10);
      console.log("[Dashboard] Recent activity: sales=", (salesRows || []).length, "payments=", (paymentsRows || []).length, "merged=", recentActivity.length);
    } catch (activityErr) {
      console.warn("GET /api/dashboard/overview: recent activity failed:", activityErr?.message || activityErr);
      if (activityErr?.stack) console.warn(activityErr.stack);
    }

    return res.json({
      todaySalesAmount,
      todaySalesCount,
      todayMaxSaleAmount,
      todayLastSaleAt,
      outstandingBalance,
      customersWithBalance,
      lowStockCount,
      lowStockCriticalCount,
      lowStockBelowMinCount,
      lowStockProducts,
      topLowStockProductName,
      topProducts,
      recentActivity,
    });
  } catch (err) {
    console.error("GET /api/dashboard/overview:", err);
    return res.status(500).json({ message: "Failed to load dashboard data." });
  }
});

export default router;

