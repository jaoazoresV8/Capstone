import express from "express";
import pool from "../db.js";
import { authenticateToken } from "../middleware/authMiddleware.js";

const router = express.Router();
router.use(authenticateToken);

// GET /api/dashboard/overview - stats + top products + recent activity
router.get("/overview", async (req, res) => {
  try {
    // Today's sales (amount + count)
    const [todayRows] = await pool.query(
      `SELECT IFNULL(SUM(total_amount), 0) AS total_amount,
              COUNT(*) AS tx_count
       FROM sales
       WHERE date(sale_date) = date('now','localtime')`
    );
    const todaySalesAmount = todayRows[0]?.total_amount || 0;
    const todaySalesCount = todayRows[0]?.tx_count || 0;

    // Outstanding balances (sum + number of customers with balance)
    const [balanceRows] = await pool.query(
      `SELECT IFNULL(SUM(total_balance), 0) AS total_balance,
              SUM(CASE WHEN total_balance > 0 THEN 1 ELSE 0 END) AS customers_with_balance
       FROM customers`
    );
    const outstandingBalance = balanceRows[0]?.total_balance || 0;
    const customersWithBalance = balanceRows[0]?.customers_with_balance || 0;

    // Low stock items (<= 10)
    const [lowStockRows] = await pool.query(
      `SELECT COUNT(*) AS low_stock_count
       FROM products
       WHERE stock_quantity <= 10`
    );
    const lowStockCount = lowStockRows[0]?.low_stock_count || 0;

    // Top 5 products by sales this month (by total amount)
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
    const topProducts = (topRows || []).map((r) => ({
      product_id: r.product_id,
      name: r.name,
      total_qty: r.total_qty,
      total_amount: r.total_amount,
    }));

    // Recent activity from dedicated table
    const [activityRows] = await pool.query(
      `SELECT activity_id AS id,
              type,
              title,
              details,
              amount,
              created_at
       FROM activity_log
       ORDER BY datetime(created_at) DESC, activity_id DESC
       LIMIT 10`
    );
    const recentActivity = activityRows || [];

    return res.json({
      todaySalesAmount,
      todaySalesCount,
      outstandingBalance,
      customersWithBalance,
      lowStockCount,
      topProducts,
      recentActivity,
    });
  } catch (err) {
    console.error("GET /api/dashboard/overview:", err);
    return res.status(500).json({ message: "Failed to load dashboard data." });
  }
});

export default router;

