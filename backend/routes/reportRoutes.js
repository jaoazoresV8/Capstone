import express from "express";
import { authenticateToken, requireAdmin } from "../middleware/authMiddleware.js";
import { getReportsDb, pingMongo } from "../mongoReports.js";

const router = express.Router();

// All report endpoints require an authenticated admin.
router.use(authenticateToken, requireAdmin);

// Health check: verify Mongo is reachable.
router.get("/health", async (req, res) => {
  try {
    await pingMongo();
    res.json({ ok: true });
  } catch (err) {
    console.error("client reports /health error", err);
    res.status(503).json({ ok: false, message: "MongoDB not reachable." });
  }
});

// Generic "all reports" endpoint – returns documents from all collections, capped per collection.
router.get("/all", async (req, res) => {
  const maxPerCollection = Math.min(
    Number(req.query.limit || 500),
    5000
  );

  try {
    const db = await getReportsDb();
    const collections = await db.listCollections().toArray();

    const result = {};

    for (const { name } of collections) {
      if (name.startsWith("system.")) continue;
      const col = db.collection(name);
      const docs = await col
        .find({})
        .limit(maxPerCollection)
        .toArray();
      result[name] = docs;
    }

    res.json({
      limitPerCollection: maxPerCollection,
      collections: Object.keys(result),
      data: result,
    });
  } catch (err) {
    console.error("client reports /all error", err);
    res.status(500).json({ message: "Failed to load reports from MongoDB." });
  }
});

export default router;

