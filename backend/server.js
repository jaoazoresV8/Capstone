import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

import authRouter from "./routes/authRoutes.js";
import userRouter from "./routes/userRoutes.js";
import customerRouter from "./routes/customerRoutes.js";
import productRouter from "./routes/productRoutes.js";
import supplierRouter from "./routes/supplierRoutes.js";
import saleRouter from "./routes/saleRoutes.js";
import dashboardRouter from "./routes/dashboardRoutes.js";
import passwordResetRouter from "./routes/passwordResetRoutes.js";
import settingsRouter from "./routes/settingsRoutes.js";
import reportRouter from "./routes/reportRoutes.js";
import { createCentralProxy } from "./middleware/centralProxy.js";
import pool from "./db.js";
import { createIdempotencyMiddleware } from "./middleware/idempotency.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Always load .env from the project root (one level above backend),
// so it works even if Node is started from a different working directory.
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const app = express();
const PORT = process.env.PORT || 5000;

// Get app path - works in both dev and packaged Electron
function getFrontendDir() {
  const appPath = path.join(__dirname, "..");
  
  // Check if running in Electron packaged app
  if (typeof process !== 'undefined' && process.versions && process.versions.electron) {
    // In packaged Electron, files are in app.asar
    // Path resolution works automatically with ASAR
    const asarFrontend = path.join(appPath, "frontend");
    if (fs.existsSync(asarFrontend)) {
      return asarFrontend;
    }
    // Fallback: check unpacked location
    const unpackedFrontend = path.join(appPath, "..", "app.asar.unpacked", "frontend");
    if (fs.existsSync(unpackedFrontend)) {
      return unpackedFrontend;
    }
  }
  
  // Development mode or files in asar
  return path.join(appPath, "frontend");
}

const frontendDir = getFrontendDir();

// Log paths for debugging (only in Electron)
if (typeof process !== 'undefined' && process.versions && process.versions.electron) {
  console.log("Frontend dir:", frontendDir);
  console.log("__dirname:", __dirname);
}

app.use(cors());
app.use(express.json());

// Idempotency for all write endpoints (POST/PUT/PATCH/DELETE under /api)
app.use(createIdempotencyMiddleware(pool));

// Reports always go directly to MongoDB (no central proxy), so mount before proxy.
app.use("/api/reports", reportRouter);

// Simple sync/central status endpoint for frontend navbar indicator
app.get("/api/client-sync-status", async (req, res) => {
  const centralUrlRaw = process.env.CENTRAL_API_URL || "";
  const centralUrl = centralUrlRaw.trim().replace(/\/+$/, "");
  const base = {
    mode: centralUrl ? "central" : "local",
    centralConfigured: Boolean(centralUrl),
  };

  if (!centralUrl) {
    // Pure local SQLite mode
    return res.json({
      ...base,
      centralReachable: false,
      statusCode: null,
      error: null,
    });
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const upstream = await fetch(`${centralUrl}/health`, { signal: controller.signal });
    clearTimeout(timer);

    return res.json({
      ...base,
      centralReachable: upstream.ok,
      statusCode: upstream.status,
      error: upstream.ok ? null : `Central health returned ${upstream.status}`,
    });
  } catch (e) {
    return res.json({
      ...base,
      centralReachable: false,
      statusCode: null,
      error: e?.name === "AbortError" ? "timeout" : "unreachable",
    });
  }
});

// Background worker: push local change_log entries to central AdminServer when available
function startCentralSyncWorker() {
  const centralUrlRaw = process.env.CENTRAL_API_URL || "";
  const centralUrl = centralUrlRaw.trim().replace(/\/+$/, "");
  if (!centralUrl) return;

  const INTERVAL_MS = 7000;

  const tick = async () => {
    try {
      const [rows] = await pool.query(
        "SELECT setting_value FROM settings WHERE setting_key = 'central_last_pushed_change_id'"
      );
      const lastId = rows && rows.length ? Number(rows[0].setting_value) || 0 : 0;

      const [changes] = await pool.query(
        "SELECT id, entity_type, entity_id, operation, payload, created_at FROM change_log WHERE id > ? ORDER BY id ASC LIMIT 100",
        [lastId]
      );
      if (!changes || changes.length === 0) return;

      const operations = changes.map((c) => ({
        localId: c.id,
        entityType: c.entity_type,
        entityId: c.entity_id,
        operation: c.operation,
        data: (() => {
          try {
            return c.payload ? JSON.parse(c.payload) : {};
          } catch {
            return { raw: String(c.payload || "") };
          }
        })(),
      }));

      const body = {
        clientId: process.env.CLIENT_ID || "client",
        operations,
      };

      const resp = await fetch(`${centralUrl}/api/sync/push`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        console.error(
          "[CentralSync] push failed:",
          resp.status,
          text.slice(0, 200)
        );
        return;
      }

      const maxId = changes[changes.length - 1].id;
      await pool.query(
        "INSERT INTO settings (setting_key, setting_value) VALUES ('central_last_pushed_change_id', ?) ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value",
        [String(maxId)]
      );

      console.log(
        `[CentralSync] pushed ${changes.length} change(s), now at id ${maxId}`
      );
    } catch (e) {
      console.error("[CentralSync] error during push:", e?.message || e);
    }
  };

  setInterval(tick, INTERVAL_MS);
}

// Optional pull worker: tracks central change_log progress and is ready for
// applying server-originated changes into the local SQLite database in future.
function startCentralPullWorker() {
  const centralUrlRaw = process.env.CENTRAL_API_URL || "";
  const centralUrl = centralUrlRaw.trim().replace(/\/+$/, "");
  if (!centralUrl) return;

  const INTERVAL_MS = 9000;

  const tick = async () => {
    try {
      const [rows] = await pool.query(
        "SELECT setting_value FROM settings WHERE setting_key = 'central_last_pulled_change_id'"
      );
      const lastId = rows && rows.length ? Number(rows[0].setting_value) || 0 : 0;

      const resp = await fetch(
        `${centralUrl}/api/sync/pull?since=${encodeURIComponent(
          String(lastId)
        )}&limit=500`
      );
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        console.error(
          "[CentralSync] pull failed:",
          resp.status,
          String(text || "").slice(0, 200)
        );
        return;
      }

      const body = await resp.json().catch(() => null);
      if (!body || !Array.isArray(body.changes) || !body.changes.length) {
        return;
      }

      let maxId = lastId;

      for (const change of body.changes) {
        if (!change || typeof change.id !== "number") continue;
        if (change.id > maxId) maxId = change.id;

        let payload = change.payload;
        if (typeof payload === "string") {
          try {
            payload = JSON.parse(payload);
          } catch {
            payload = null;
          }
        }
        const sourceClientId =
          payload && typeof payload === "object" ? payload.clientId : null;

        // For now, ignore changes that were pushed by any client instance.
        // This avoids conflicting primary keys between independent local SQLite databases.
        if (sourceClientId) {
          continue;
        }

        // If the AdminServer later records its own authoritative changes into
        // change_log without a clientId, this is where we would apply those
        // operations into the local SQLite database in an idempotent way.
      }

      if (maxId > lastId) {
        await pool.query(
          "INSERT INTO settings (setting_key, setting_value) VALUES ('central_last_pulled_change_id', ?) ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value",
          [String(maxId)]
        );
      }
    } catch (e) {
      console.error("[CentralSync] error during pull:", e?.message || e);
    }
  };

  setInterval(tick, INTERVAL_MS);
}

// Local API routes (SQLite is always authoritative here; central sync is best-effort async)
app.use("/api/auth", authRouter);
app.use("/api/users", userRouter);
app.use("/api/customers", customerRouter);
app.use("/api/products", productRouter);
app.use("/api/suppliers", supplierRouter);
app.use("/api/sales", saleRouter);
app.use("/api/password-resets", passwordResetRouter);
app.use("/api/settings", settingsRouter);
app.use("/api/dashboard", dashboardRouter);


app.get("/.well-known/appspecific/com.chrome.devtools.json", (req, res) => {
  res.status(200).json({});
});

// Serve static files
app.use("/js", express.static(path.join(frontendDir, "js")));
app.use("/css", express.static(path.join(frontendDir, "css")));
app.use(express.static(frontendDir));


app.get("/", (req, res) => {
  const indexPath = path.join(frontendDir, "index.html");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.sendFile(indexPath);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
});

app.use((err, req, res, next) => {
  const msg = err?.message ?? err?.toString?.() ?? String(err);
  const detail = err?.stack ?? (err?.code ? `code: ${err.code}` : "");
  console.error("Error:", req.method, req.originalUrl, msg);
  if (res.headersSent) return;
  let sendMsg = msg || "Server error.";
  if (sendMsg === "Internal server error.") {
    sendMsg = "Request error. Ensure body is valid JSON and Content-Type is application/json.";
  }
  const body = { message: sendMsg };
  if (detail && process.env.NODE_ENV !== "production") body.detail = String(detail).slice(0, 400);
  res.status(500).setHeader("Content-Type", "application/json").send(JSON.stringify(body));
});

/**
 * Start the HTTP server. Returns a Promise that resolves when the server is listening.
 * Used by both standalone Node (npm run dev) and Electron (electron-main.js).
 */
export function startServer(port = PORT) {
  return new Promise((resolve) => {
    const host = "0.0.0.0";
    app.listen(port, host, () => {
      console.log(`Server running on http://${host}:${port} (client backend)`);
      startCentralSyncWorker();
      startCentralPullWorker();
      resolve();
    });
  });
}

// When run directly (node backend/server.js or nodemon), start the server.
// Not when imported by Electron (which calls startServer itself).
const isElectron = typeof process !== "undefined" && process.versions?.electron;
const runAsMain = !isElectron;
if (runAsMain) {
  startServer().catch((err) => {
    console.error("Failed to start server:", err);
    process.exit(1);
  });
}

