import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import bcrypt from "bcryptjs";

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
import { pushPendingChangesToCentralOnce } from "./centralSyncPushOnce.js";
import { createIdempotencyMiddleware } from "./middleware/idempotency.js";
import { authenticateToken } from "./middleware/authMiddleware.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Always load .env from the project root (one level above backend),
// so it works even if Node is started from a different working directory.
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const app = express();
const PORT = process.env.PORT || 5000;

const CENTRAL_SYNC_DEBUG = (process.env.CENTRAL_SYNC_DEBUG || "").trim() === "1";

// Must match adminfinal `mapClientEntityIdToCentralId`: base * MULT + localId, MULT = 10_000_000.
const CENTRAL_BRANCH_ENTITY_MULT = 10_000_000;

/** Decode central sale/issue/payment IDs back to local SQLite IDs for branch-originated rows. */
function centralEntityIdToLocal(id) {
  const n = Number(id);
  if (!Number.isFinite(n) || n <= 0) return n;
  if (n >= CENTRAL_BRANCH_ENTITY_MULT) return n % CENTRAL_BRANCH_ENTITY_MULT;
  return n;
}

/**
 * sale_issues.cashier_id / resolved_by_admin_id FK -> users.user_id.
 * Central user IDs often do not exist on the branch; inserting would fail silently.
 * Keep names; only set FK when a matching local user row exists (raw or branch-mapped id).
 */
async function localUserFkOrNull(rawUserId) {
  if (rawUserId == null || rawUserId === "") return null;
  const n = Number(rawUserId);
  if (!Number.isFinite(n) || n <= 0) return null;
  const candidates = [n];
  if (n >= CENTRAL_BRANCH_ENTITY_MULT) {
    candidates.push(centralEntityIdToLocal(n));
  }
  for (const uid of candidates) {
    try {
      const [rows] = await pool.query("SELECT user_id FROM users WHERE user_id = ? LIMIT 1", [uid]);
      if (rows && rows.length) return uid;
    } catch (_) {}
  }
  return null;
}

async function getClientIdSetting() {
  const fallback = (process.env.CLIENT_ID || "").trim() || "client";
  try {
    const [rows] = await pool.query(
      "SELECT setting_value FROM settings WHERE setting_key = 'client_id'"
    );
    const v = rows && rows.length ? String(rows[0].setting_value || "").trim() : "";
    return v || fallback;
  } catch {
    return fallback;
  }
}

async function getCentralBaseUrl() {
  const envVal = (process.env.CENTRAL_API_URL || "").trim();
  try {
    const [rows] = await pool.query(
      "SELECT setting_value FROM settings WHERE setting_key = 'central_api_url'"
    );
    const dbVal =
      rows && rows.length ? String(rows[0].setting_value || "").trim() : "";
    const raw = dbVal || envVal;
    return raw.replace(/\/+$/, "");
  } catch {
    return envVal.replace(/\/+$/, "");
  }
}

// Get app paths - works in both dev and packaged Electron
function getAppPaths() {
  const appPath = path.join(__dirname, "..");

  // Default locations (development or unpacked asar)
  const paths = {
    appPath,
    frontendDir: path.join(appPath, "frontend"),
    nodeModulesDir: path.join(appPath, "node_modules"),
  };

  // Check if running in Electron packaged app
  if (typeof process !== "undefined" && process.versions && process.versions.electron) {
    // In packaged Electron, files are in app.asar
    // Path resolution works automatically with ASAR
    const asarFrontend = path.join(appPath, "frontend");
    if (fs.existsSync(asarFrontend)) {
      paths.frontendDir = asarFrontend;
    } else {
      // Fallback: check unpacked location
      const unpackedFrontend = path.join(appPath, "..", "app.asar.unpacked", "frontend");
      if (fs.existsSync(unpackedFrontend)) {
        paths.frontendDir = unpackedFrontend;
      }
    }

    // Node modules are packaged alongside the app
    const asarNodeModules = path.join(appPath, "node_modules");
    if (fs.existsSync(asarNodeModules)) {
      paths.nodeModulesDir = asarNodeModules;
    } else {
      const unpackedNodeModules = path.join(appPath, "..", "app.asar.unpacked", "node_modules");
      if (fs.existsSync(unpackedNodeModules)) {
        paths.nodeModulesDir = unpackedNodeModules;
      }
    }
  }

  return paths;
}

const { frontendDir, nodeModulesDir } = getAppPaths();

// Log paths for debugging (only in Electron)
if (typeof process !== "undefined" && process.versions && process.versions.electron) {
  console.log("Frontend dir:", frontendDir);
  console.log("Node modules dir:", nodeModulesDir);
  console.log("__dirname:", __dirname);
}

app.use(cors());
app.use(express.json());

// Idempotency for all write endpoints (POST/PUT/PATCH/DELETE under /api)
app.use(createIdempotencyMiddleware(pool));

// Reports endpoint:
// Default: read directly from MongoDB via reportRouter on both central and clients.
// Optional: if you explicitly set REPORTS_USE_CENTRAL="1", the client can proxy
//           /api/reports/* to the central server to reuse its analytics workload.
const centralUrlEnv = (process.env.CENTRAL_API_URL || "").trim();
const reportsUseCentral = (process.env.REPORTS_USE_CENTRAL || "").trim() === "1";
if (centralUrlEnv && reportsUseCentral) {
  app.use("/api/reports", createCentralProxy({ target: centralUrlEnv }));
} else {
  app.use("/api/reports", reportRouter);
}

// Simple sync/central status endpoint for frontend navbar indicator
app.get("/api/client-sync-status", async (req, res) => {
  const centralUrl = await getCentralBaseUrl();
  const base = {
    mode: centralUrl ? "central" : "local",
    centralConfigured: Boolean(centralUrl),
    centralUrl: centralUrl || null,
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

// Proxy for checking if a Client ID is available on the central server.
// Frontend calls this on the local client backend; we forward the request
// to the configured CENTRAL_API_URL / central_api_url.
app.get("/api/sync/clients/check-id", async (req, res) => {
  try {
    const rawCentralFromQuery =
      typeof req.query.centralUrl === "string" ? req.query.centralUrl.trim() : "";
    const centralUrl = rawCentralFromQuery || (await getCentralBaseUrl());
    if (!centralUrl) {
      return res.status(400).json({
        message:
          "Central server is not configured. Enter a central address in App Settings or set CENTRAL_API_URL.",
      });
    }

    // Guard against misconfiguration where CENTRAL_API_URL (or centralUrl query)
    // points back to this same client backend (e.g. http://localhost:5000).
    try {
      const currentHost = req.get("host");
      const central = new URL(centralUrl);
      if (central.host === currentHost) {
        return res.status(400).json({
          message:
            "The central server address is pointing to this client backend. Change it to the actual central server URL (for example: http://central-host:6000).",
        });
      }
    } catch {
      // If URL parsing fails, fall through and let the fetch error handler respond.
    }

    const rawClientId = req.query.clientId;
    const clientId = typeof rawClientId === "string" ? rawClientId.trim() : "";
    if (!clientId) {
      return res.status(400).json({ message: "clientId query parameter is required." });
    }

    const url = `${centralUrl.replace(/\/+$/, "")}/api/sync/clients/check-id?clientId=${encodeURIComponent(
      clientId
    )}`;

    const headers = {};
    const auth = req.headers["authorization"];
    if (auth) {
      headers["authorization"] = String(auth);
    }

    const upstream = await fetch(url, { headers });
    const text = await upstream.text().catch(() => "");

    // Try to pass through JSON responses; otherwise wrap raw text.
    let body;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = text ? { message: text } : {};
    }

    res.status(upstream.status).json(body);
  } catch (e) {
    console.error(
      "Error proxying /api/sync/clients/check-id to central:",
      e?.message || e
    );
    res.status(502).json({
      message:
        "Could not contact central to verify this Client ID. Check the central address and try again.",
    });
  }
});

// Proxy: push local queued operations to central (used by frontend sync-queue.js).
// POST /api/sync/push { clientId, operations: [...] }
app.post("/api/sync/push", authenticateToken, async (req, res) => {
  try {
    const centralUrl = await getCentralBaseUrl();
    if (!centralUrl) {
      return res.status(400).json({
        message:
          "Central server is not configured. Enter a central address in App Settings or set CENTRAL_API_URL.",
      });
    }

    // Guard against misconfiguration pointing back to this client backend.
    try {
      const currentHost = req.get("host");
      const central = new URL(centralUrl);
      if (central.host === currentHost) {
        return res.status(400).json({
          message:
            "The central server address is pointing to this client backend. Change it to the actual central server URL (for example: http://central-host:6000).",
        });
      }
    } catch {
      // ignore URL parse errors; fetch will fail and be handled below
    }

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const upstream = await fetch(`${centralUrl}/api/sync/push`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(req.headers["authorization"]
          ? { authorization: String(req.headers["authorization"]) }
          : {}),
      },
      body: JSON.stringify(body),
    });

    const text = await upstream.text().catch(() => "");
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = text ? { message: text } : {};
    }
    return res.status(upstream.status).json(parsed);
  } catch (e) {
    console.error("Error proxying /api/sync/push to central:", e?.message || e);
    return res.status(502).json({
      message:
        "Could not contact central to push sync operations. Check the central address and try again.",
    });
  }
});

// Sale mapping: after sync, resolve client receipt_no -> central OR number.
// GET /api/sync/sale-mapping?receipt_no=<comma-separated>&sale_uuid=<comma-separated optional>
//
// Behavior:
// - Proxies request to central
// - Best-effort updates local SQLite `sales.or_number` where it matches the provided receipt_no
//   so the Sales UI shows the correct OR number reliably per client sale.
app.get("/api/sync/sale-mapping", authenticateToken, async (req, res) => {
  try {
    const centralUrl = await getCentralBaseUrl();
    if (!centralUrl) {
      return res.status(400).json({
        message:
          "Central server is not configured. Enter a central address in App Settings or set CENTRAL_API_URL.",
      });
    }

    // Guard against misconfiguration pointing back to this client backend.
    try {
      const currentHost = req.get("host");
      const central = new URL(centralUrl);
      if (central.host === currentHost) {
        return res.status(400).json({
          message:
            "The central server address is pointing to this client backend. Change it to the actual central server URL (for example: http://central-host:6000).",
        });
      }
    } catch {
      // ignore URL parse errors
    }

    const receiptNoRaw =
      typeof req.query.receipt_no === "string" ? req.query.receipt_no : "";
    const saleUuidRaw =
      typeof req.query.sale_uuid === "string" ? req.query.sale_uuid : "";

    const qs = new URLSearchParams();
    if (receiptNoRaw.trim()) qs.set("receipt_no", receiptNoRaw.trim());
    if (saleUuidRaw.trim()) qs.set("sale_uuid", saleUuidRaw.trim());

    const doFetch = async (params) => {
      const upstream = await fetch(
        `${centralUrl}/api/sync/sale-mapping?${params.toString()}`,
        {
          headers: {
            ...(req.headers["authorization"]
              ? { authorization: String(req.headers["authorization"]) }
              : {}),
          },
        }
      );
      const body = await upstream.json().catch(() => ({}));
      return { upstream, body };
    };

    let { upstream, body } = await doFetch(qs);
    if (!upstream.ok) {
      const msg =
        body && typeof body === "object"
          ? String(body.message || body.error || "")
          : "";

      // Some central deployments don't have sales.receipt_no; retry using sale_uuid only.
      if (
        upstream.status === 400 &&
        msg.toLowerCase().includes("receipt_no") &&
        msg.toLowerCase().includes("column") &&
        saleUuidRaw.trim()
      ) {
        const retry = new URLSearchParams();
        retry.set("sale_uuid", saleUuidRaw.trim());
        const out = await doFetch(retry);
        upstream = out.upstream;
        body = out.body;
      }

      if (!upstream.ok) {
        return res
          .status(upstream.status)
          .json(body && typeof body === "object" ? body : { message: "Failed." });
      }
    }

    const mappingsRaw = Array.isArray(body?.mappings)
      ? body.mappings
      : Array.isArray(body)
      ? body
      : [];

    const mappings = (mappingsRaw || [])
      .map((m) => {
        const receiptCandidate =
          (m && (m.receipt_no ?? m.receiptNo ?? m.receipt_number ?? m.receiptNumber)) ??
          null;
        const orCandidate =
          (m && (m.or_number ?? m.orNumber ?? m.orNo ?? m.orNO ?? m.or)) ?? null;
        const uuidCandidate =
          (m && (m.sale_uuid ?? m.saleUuid ?? m.uuid ?? m.saleUUID)) ?? null;

        const receipt_no =
          receiptCandidate != null && String(receiptCandidate).trim()
            ? String(receiptCandidate).trim()
            : null;
        const or_number =
          orCandidate != null && String(orCandidate).trim()
            ? String(orCandidate).trim()
            : null;
        const sale_uuid =
          uuidCandidate != null && String(uuidCandidate).trim()
            ? String(uuidCandidate).trim()
            : null;
        // Central may return only sale_uuid + or_number (no receipt_no support).
        if (or_number && (receipt_no || sale_uuid)) {
          return { receipt_no, sale_uuid, or_number };
        }
        return null;
      })
      .filter(Boolean);

    let updated = 0;
    if (mappings.length) {
      // Update local sales.or_number by matching the client temp receipt number.
      // (In local mode, we stored receipt_number into or_number.)
      for (const m of mappings) {
        if (!m.receipt_no) continue;
        try {
          const [result] = await pool.query(
            "UPDATE sales SET or_number = ? WHERE or_number = ?",
            [m.or_number, m.receipt_no]
          );
          updated += Number(result?.affectedRows || result?.changes || 0) || 0;
        } catch (e) {
          // Keep going: mapping should still be returned even if a local DB update fails.
        }
      }
    }

    return res.json({
      mappings,
      updated,
      requested: {
        receipt_no: receiptNoRaw || "",
        sale_uuid: saleUuidRaw || "",
      },
      receivedCount: mappingsRaw.length || 0,
      parsedCount: mappings.length || 0,
    });
  } catch (e) {
    console.error("Error in /api/sync/sale-mapping:", e?.message || e);
    return res.status(502).json({
      message:
        "Could not contact central to load sale mapping. Check connectivity and try again.",
    });
  }
});

// Apply mapping locally when central only supports sale_uuid -> or_number.
// POST /api/sync/apply-sale-mapping { mappings: [{ receipt_no, or_number }] }
app.post("/api/sync/apply-sale-mapping", authenticateToken, async (req, res) => {
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const list = Array.isArray(body.mappings) ? body.mappings : [];
    const mappings = list
      .map((m) => {
        const receipt_no =
          m && m.receipt_no != null && String(m.receipt_no).trim()
            ? String(m.receipt_no).trim()
            : null;
        const or_number =
          m && m.or_number != null && String(m.or_number).trim()
            ? String(m.or_number).trim()
            : null;
        return receipt_no && or_number ? { receipt_no, or_number } : null;
      })
      .filter(Boolean);

    if (!mappings.length) {
      return res.status(400).json({ message: "mappings is required." });
    }

    let updated = 0;
    for (const m of mappings) {
      if (m.receipt_no === m.or_number) continue;
      const [existing] = await pool.query(
        "SELECT sale_id FROM sales WHERE or_number = ? LIMIT 1",
        [m.or_number]
      );
      if (existing && existing.length > 0) continue;
      const [result] = await pool.query(
        "UPDATE sales SET or_number = ? WHERE or_number = ?",
        [m.or_number, m.receipt_no]
      );
      updated += Number(result?.affectedRows || result?.changes || 0) || 0;
    }

    return res.json({ updated });
  } catch (e) {
    console.error("Error in /api/sync/apply-sale-mapping:", e?.message || e);
    return res.status(500).json({ message: "Failed to apply sale mapping." });
  }
});

// Monotonic tick bumped when pull applies new central rows — UI polls this to refresh lists.
app.get("/api/sync/pulled-state", authenticateToken, async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT setting_value FROM settings WHERE setting_key = 'central_pull_tick'"
    );
    const pullTick =
      rows && rows.length && rows[0].setting_value != null
        ? String(rows[0].setting_value)
        : "0";
    return res.json({ pullTick });
  } catch (e) {
    console.error("Error in /api/sync/pulled-state:", e?.message || e);
    return res.json({ pullTick: "0" });
  }
});

// Background worker: push local change_log entries to central AdminServer when available
function startCentralSyncWorker() {
  const INTERVAL_MS = 7000;

  const tick = async () => {
    await pushPendingChangesToCentralOnce();
  };

  setInterval(tick, INTERVAL_MS);
}

async function applyCentralChangeToLocal(change, payload) {
  if (!change || !payload) return;

  let data = payload;
  if (data && typeof data === "object" && data.data && typeof data.data === "object") {
    data = data.data;
  }
  if (!data || typeof data !== "object") return;

  const entityType = String(change.entity_type || "").toLowerCase();
  const op = String(change.operation || "").toLowerCase();
  if (!entityType || !op) return;

  try {
    switch (entityType) {
      case "user": {
        const id = data.id ?? data.user_id;
        if (!id) return;

        const name = data.name ?? null;
        const username = data.username ?? null;
        const email = data.email ?? null;
        const role = data.role ?? "staff";
        const incomingPasswordHash =
          (typeof data.password_hash === "string" && data.password_hash.trim() !== "")
            ? data.password_hash.trim()
            : null;

        let allowedPagesStr = null;
        if (Array.isArray(data.allowed_pages)) {
          allowedPagesStr = data.allowed_pages
            .map((p) => String(p).trim())
            .filter(Boolean)
            .join(",");
        } else if (typeof data.allowed_pages === "string") {
          const trimmed = data.allowed_pages.trim();
          allowedPagesStr = trimmed !== "" ? trimmed : null;
        }

        if (op === "delete" || op === "remove") {
          // Mirror a cascade-like delete for local SQLite so central deletions
          // are fully reflected on the client.
          try {
            await pool.query(
              "DELETE FROM password_reset_requests WHERE user_id = ? OR resolved_by = ?",
              [id, id]
            );
          } catch (_) {}
          try {
            await pool.query(
              "DELETE FROM sale_issues WHERE cashier_id = ? OR resolved_by_admin_id = ?",
              [id, id]
            );
          } catch (_) {}

          await pool.query("DELETE FROM users WHERE user_id = ?", [id]);
          break;
        }

        const [existingRows] = await pool.query(
          "SELECT user_id, password_hash FROM users WHERE user_id = ? LIMIT 1",
          [id]
        );
        const existing = Array.isArray(existingRows) ? existingRows : [];

        if (existing.length > 0) {
          const currentPasswordHash = existing[0].password_hash || null;

          // If central sends a password_hash, keep local in sync; otherwise preserve existing.
          if (incomingPasswordHash && incomingPasswordHash !== currentPasswordHash) {
            await pool.query(
              "UPDATE users SET name = ?, username = ?, email = ?, role = ?, allowed_pages = ?, password_hash = ? WHERE user_id = ?",
              [name, username, email, role, allowedPagesStr, incomingPasswordHash, id]
            );
          } else {
            await pool.query(
              "UPDATE users SET name = ?, username = ?, email = ?, role = ?, allowed_pages = ? WHERE user_id = ?",
              [name, username, email, role, allowedPagesStr, id]
            );
          }
        } else {
          // New user coming from central.
          if (incomingPasswordHash) {
            // If central provides a hash, reuse it so passwords match.
            await pool.query(
              "INSERT INTO users (user_id, name, username, email, password_hash, role, allowed_pages, created_at) " +
                "VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'))",
              [id, name, username, email, incomingPasswordHash, role, allowedPagesStr]
            );
          } else {
            // Fallback: generate a local password hash to satisfy NOT NULL.
            const tempPassword = "CentralTemp123!";
            const salt = await bcrypt.genSalt(10);
            const passwordHash = await bcrypt.hash(tempPassword, salt);

            await pool.query(
              "INSERT INTO users (user_id, name, username, email, password_hash, role, allowed_pages, created_at) " +
                "VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'))",
              [id, name, username, email, passwordHash, role, allowedPagesStr]
            );
          }
        }

        break;
      }
      case "supplier": {
        const id = data.id ?? data.supplier_id;
        if (!id) return;
        const name = data.name ?? null;
        const contact = data.contact ?? null;
        const address = data.address ?? null;
        await pool.query(
          "INSERT INTO suppliers (supplier_id, name, contact, address) VALUES (?, ?, ?, ?) " +
            "ON CONFLICT(supplier_id) DO UPDATE SET name = excluded.name, contact = excluded.contact, address = excluded.address",
          [id, name, contact, address]
        );
        break;
      }
      case "product": {
        const id = data.id ?? data.product_id;
        if (!id) return;
        const name = data.name ?? null;
        const category = data.category ?? null;
        const supplierIdRaw = data.supplier_id ?? null;
        const supplierPrice = data.supplier_price ?? 0;
        const sellingPrice = data.selling_price ?? 0;
        const stockQty = data.stock_quantity ?? 0;
        const recordedAt = data.recorded_at ?? null;
        const recordedBy = data.recorded_by ?? null;
        const recordedByName =
          (typeof data.recorded_by_name === "string" && data.recorded_by_name.trim() !== "")
            ? data.recorded_by_name.trim()
            : null;
        let supplierId = supplierIdRaw;
        if (supplierId != null && supplierId !== "") {
          const sid = Number(supplierId);
          if (Number.isFinite(sid) && sid > 0) {
            const [supplierRows] = await pool.query(
              "SELECT supplier_id FROM suppliers WHERE supplier_id = ? LIMIT 1",
              [sid]
            );
            if (!supplierRows || supplierRows.length === 0) {
              // Allow product sync even when supplier rows arrive later.
              await pool.query(
                "INSERT INTO suppliers (supplier_id, name, contact, address) VALUES (?, ?, NULL, NULL)",
                [sid, `Supplier #${sid}`]
              );
            }
            supplierId = sid;
          } else {
            supplierId = null;
          }
        } else {
          supplierId = null;
        }
        await pool.query(
          "INSERT INTO products (product_id, name, category, supplier_id, supplier_price, selling_price, stock_quantity, recorded_at, recorded_by, recorded_by_name) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
            "ON CONFLICT(product_id) DO UPDATE SET " +
            "name = excluded.name, category = excluded.category, supplier_id = excluded.supplier_id, " +
            "supplier_price = excluded.supplier_price, selling_price = excluded.selling_price, stock_quantity = excluded.stock_quantity, " +
            "recorded_at = COALESCE(excluded.recorded_at, products.recorded_at), " +
            "recorded_by = COALESCE(excluded.recorded_by, products.recorded_by), " +
            "recorded_by_name = COALESCE(excluded.recorded_by_name, products.recorded_by_name)",
          [id, name, category, supplierId, supplierPrice, sellingPrice, stockQty, recordedAt, recordedBy, recordedByName]
        );
        break;
      }
      case "customer": {
        const id = data.id ?? data.customer_id;
        if (!id) return;
        const name = data.name ?? null;
        const contact = data.contact ?? null;
        const address = data.address ?? null;
        const totalBalance = data.total_balance ?? 0;
        await pool.query(
          "INSERT INTO customers (customer_id, name, contact, address, total_balance) VALUES (?, ?, ?, ?, ?) " +
            "ON CONFLICT(customer_id) DO UPDATE SET " +
            "name = excluded.name, contact = excluded.contact, address = excluded.address, total_balance = excluded.total_balance",
          [id, name, contact, address, totalBalance]
        );
        break;
      }
      case "settings": {
        const pct = data.markup_percent != null ? parseFloat(data.markup_percent) : NaN;
        if (isNaN(pct) || pct < 0 || pct >= 100) break;
        const val = String(Math.round(pct * 100) / 100);
        await pool.query(
          "INSERT INTO settings (setting_key, setting_value) VALUES ('markup_percent', ?) ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value",
          [val]
        );
        // Margin-based: Selling Price = Cost / (1 - Margin). Stored as markup_percent but used as margin.
        await pool.query(
          "UPDATE products SET selling_price = ROUND(supplier_price / (1 - ? / 100), 2)",
          [pct]
        );
        break;
      }
      case "password_reset": {
        const id = data.id ?? data.request_id;
        if (!id) return;

        const userId = data.user_id ?? null;
        const username = data.username ?? null;
        const status =
          typeof data.status === "string" && data.status
            ? data.status
            : op === "delete"
            ? "resolved"
            : "pending";
        const resolvedBy = data.resolved_by ?? null;
        const resolutionNote = data.resolution_note ?? null;

        if (op === "delete" || status === "deleted") {
          await pool.query(
            "DELETE FROM password_reset_requests WHERE request_id = ?",
            [id]
          );
          break;
        }

        if (status === "resolved" || status === "rejected") {
          await pool.query(
            `UPDATE password_reset_requests
             SET status = ?, resolved_at = datetime('now','localtime'),
                 resolved_by = ?, resolution_note = ?
             WHERE request_id = ?`,
            [status, resolvedBy, resolutionNote, id]
          );
        } else {
          await pool.query(
            `INSERT INTO password_reset_requests (request_id, user_id, username, requested_at, status)
             VALUES (?, ?, ?, datetime('now','localtime'), ?)
             ON CONFLICT(request_id) DO UPDATE SET
               user_id = excluded.user_id,
               username = excluded.username,
               status = excluded.status`,
            [id, userId, username, status]
          );
        }

        break;
      }
      case "sale": {
        const rawSaleId = Number(data.id ?? data.sale_id ?? change.entity_id);
        if (!Number.isFinite(rawSaleId) || rawSaleId <= 0) break;
        const centralSaleIdForFetch = rawSaleId;
        const saleId = centralEntityIdToLocal(rawSaleId);

        // Central/adminfinal: status-only updates (void/refund) after issue resolution — avoid
        // recomputing "paid" from balances when payload omits other sale fields.
        const statusOnly =
          typeof data.status === "string" &&
          (data.status.toLowerCase() === "voided" || data.status.toLowerCase() === "refunded");
        if (op === "update" && statusOnly) {
          await pool.query("UPDATE sales SET status = ? WHERE sale_id = ?", [
            data.status.toLowerCase(),
            saleId,
          ]);
          break;
        }

        let customerId =
          data.customer_id != null && data.customer_id !== ""
            ? Number(data.customer_id)
            : null;
        if (customerId != null && Number.isFinite(customerId) && customerId > 0) {
          customerId = centralEntityIdToLocal(customerId);
        } else {
          customerId = null;
        }
        const transactionType =
          typeof data.transaction_type === "string" && data.transaction_type
            ? data.transaction_type
            : "walk-in";
        const customerName =
          typeof data.walk_in_customer_name === "string" &&
          data.walk_in_customer_name.trim()
            ? data.walk_in_customer_name.trim()
            : typeof data.customer_name === "string" &&
              data.customer_name.trim()
            ? data.customer_name.trim()
            : null;
        const customerContact =
          data.customer_contact != null
            ? String(data.customer_contact).trim() || null
            : data.contact != null
            ? String(data.contact).trim() || null
            : null;
        const customerAddress =
          typeof data.customer_address === "string" &&
          data.customer_address.trim()
            ? data.customer_address.trim()
            : typeof data.address === "string" && data.address.trim()
            ? data.address.trim()
            : null;
        const paymentMethodRaw = data.payment_method;
        const paymentReferenceRaw = data.reference_number;
        const payloadRoot = payload && typeof payload === "object" ? payload : {};
        const orNumberRaw =
          data.or_number ?? data.or_no ?? data.receipt_no ?? data.receipt_number ?? data.orNumber ?? data.orNo
          ?? payloadRoot.or_number ?? payloadRoot.or_no ?? payloadRoot.receipt_no ?? payloadRoot.receipt_number ?? payloadRoot.orNumber ?? payloadRoot.orNo ?? null;
        const orNumber =
          orNumberRaw != null && String(orNumberRaw).trim()
            ? String(orNumberRaw).trim()
            : null;
        const totalAmount = Number(data.total_amount) || 0;
        const amountPaid = Number(data.amount_paid) || 0;
        const remainingBalance = Number(data.remaining_balance) || 0;

        let status =
          typeof data.status === "string" && data.status
            ? data.status
            : "unpaid";
        const statusLower = typeof status === "string" ? status.toLowerCase() : "";
        const isTerminalIssueStatus = statusLower === "voided" || statusLower === "refunded";
        if (!data.status) {
          if (remainingBalance <= 0 && (totalAmount > 0 || amountPaid > 0)) {
            status = "paid";
          } else if (amountPaid > 0) {
            status = "partial";
          }
        } else if (isTerminalIssueStatus) {
          status = statusLower;
        }

        const saleDate =
          typeof data.sale_date === "string" && data.sale_date.trim()
            ? data.sale_date.trim()
            : null;

        // Ensure referenced customer exists locally to avoid FOREIGN KEY failures.
        if (customerId) {
          const totalBalance =
            data.total_balance != null
              ? Number(data.total_balance) || 0
              : 0;
          await pool.query(
            "INSERT INTO customers (customer_id, name, contact, address, total_balance) VALUES (?, ?, ?, ?, ?) " +
              "ON CONFLICT(customer_id) DO UPDATE SET " +
              "name = excluded.name, contact = excluded.contact, address = excluded.address",
            [
              customerId,
              customerName || null,
              customerContact,
              customerAddress,
              totalBalance,
            ]
          );
        }

        let orNumberToUse = orNumber;
        if (orNumberToUse) {
          const [existingOr] = await pool.query(
            "SELECT sale_id FROM sales WHERE or_number = ? AND sale_id != ? LIMIT 1",
            [orNumberToUse, saleId]
          );
          if (existingOr && existingOr.length > 0) orNumberToUse = null;
        }
        await pool.query(
          `INSERT INTO sales (
             sale_id,
             customer_id,
             transaction_type,
             customer_name,
             customer_contact,
             customer_address,
             or_number,
             total_amount,
             amount_paid,
             remaining_balance,
             status,
             sale_date
           )
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now','localtime')))
           ON CONFLICT(sale_id) DO UPDATE SET
             customer_id = excluded.customer_id,
             transaction_type = excluded.transaction_type,
             customer_name = excluded.customer_name,
             customer_contact = excluded.customer_contact,
             customer_address = excluded.customer_address,
             or_number = excluded.or_number,
             total_amount = excluded.total_amount,
             amount_paid = excluded.amount_paid,
             remaining_balance = excluded.remaining_balance,
             status = excluded.status,
             sale_date = excluded.sale_date`,
          [
            saleId,
            customerId,
            transactionType,
            customerName,
            customerContact,
            customerAddress,
            orNumberToUse,
            totalAmount,
            amountPaid,
            remainingBalance,
            status,
            saleDate,
          ]
        );

        // Only reconcile line-items when the payload includes them.
        // For status-only updates (void/refund restore), payload often omits `items`,
        // and we must not delete existing `sale_items` or the modal will lose prices/subtotals.
        if (Array.isArray(data.items)) {
          const items = data.items;
          // Preserve previous quantities so product stock can be adjusted by delta.
          const [existingItemRows] = await pool.query(
            "SELECT product_id, quantity FROM sale_items WHERE sale_id = ?",
            [saleId]
          );
          const prevQtyByProduct = new Map();
          for (const row of existingItemRows || []) {
            const pid = Number(row.product_id);
            const qty = Number(row.quantity) || 0;
            if (!Number.isFinite(pid) || pid <= 0 || qty <= 0) continue;
            prevQtyByProduct.set(pid, (prevQtyByProduct.get(pid) || 0) + qty);
          }

          await pool.query("DELETE FROM sale_items WHERE sale_id = ?", [saleId]);
          const nextQtyByProduct = new Map();
          for (const item of items) {
            const rawPid =
              item.product_id != null && item.product_id !== ""
                ? Number(item.product_id)
                : null;
            const productId =
              rawPid != null && Number.isFinite(rawPid) && rawPid > 0
                ? centralEntityIdToLocal(rawPid)
                : null;
            if (!Number.isFinite(productId) || productId <= 0) continue;
            const qty = Number(item.quantity) || 0;
            const price = Number(item.price) || 0;
            const subtotal = Number(item.subtotal) || qty * price;
            if (qty <= 0) continue;
            nextQtyByProduct.set(productId, (nextQtyByProduct.get(productId) || 0) + qty);
            await pool.query(
              "INSERT INTO sale_items (sale_id, product_id, quantity, price, subtotal) VALUES (?, ?, ?, ?, ?)",
              [saleId, productId, qty, price, subtotal]
            );
          }

          // Stock sync: apply only the quantity delta (new - previous) for this sale.
          const touched = new Set([
            ...Array.from(prevQtyByProduct.keys()),
            ...Array.from(nextQtyByProduct.keys()),
          ]);
          for (const productId of touched) {
            const prevQty = prevQtyByProduct.get(productId) || 0;
            const nextQty = nextQtyByProduct.get(productId) || 0;
            const diff = nextQty - prevQty;
            if (diff === 0) continue;
            await pool.query(
              "UPDATE products SET stock_quantity = MAX(0, stock_quantity - ?) WHERE product_id = ?",
              [diff, productId]
            );
          }
        }

        // Keep local payments table consistent with central's sale amount_paid.
        try {
          const [[sumRow]] = await pool.query(
            "SELECT COALESCE(SUM(amount_paid), 0) AS total_paid FROM payments WHERE sale_id = ?",
            [saleId]
          );
          const localTotalPaid = Number(sumRow?.total_paid || 0);

          // Normalize payment method; fall back to 'cash' if not provided.
          const rawMethod =
            typeof paymentMethodRaw === "string" && paymentMethodRaw.trim()
              ? paymentMethodRaw.trim().toLowerCase()
              : "";
          const allowedMethods = new Set(["cash", "gcash", "paymaya", "credit"]);
          const normalizedMethod = allowedMethods.has(rawMethod) ? rawMethod : "cash";

          // Prefer explicit reference_number from central; otherwise use method name.
          const referenceNumber =
            paymentReferenceRaw != null && String(paymentReferenceRaw).trim()
              ? String(paymentReferenceRaw).trim()
              : normalizedMethod;

          if (amountPaid <= 0) {
            if (localTotalPaid > 0) {
              await pool.query("DELETE FROM payments WHERE sale_id = ?", [saleId]);
            }
          } else if (Math.abs(localTotalPaid - amountPaid) > 0.005) {
            // Replace local payments with a single aggregate row matching central's amount_paid.
            await pool.query("DELETE FROM payments WHERE sale_id = ?", [saleId]);
            await pool.query(
              "INSERT INTO payments (sale_id, amount_paid, payment_date, reference_number, payment_method) VALUES (?, ?, datetime('now','localtime'), ?, ?)",
              [saleId, amountPaid, referenceNumber, normalizedMethod]
            );
          }
        } catch (e) {
          if (CENTRAL_SYNC_DEBUG) {
            console.error("[CentralSync] failed to reconcile payments for sale", saleId, e?.message || e);
          }
        }

        // If we still don't have an OR number (payload didn't include it), fetch the sale from central so we display OR-004 etc. instead of sale_id.
        if (!orNumberToUse) {
          try {
            const centralUrl = await getCentralBaseUrl();
            if (centralUrl) {
              const res = await fetch(
                `${centralUrl.replace(/\/+$/, "")}/api/sales/${encodeURIComponent(String(centralSaleIdForFetch))}`,
                { headers: { Accept: "application/json" } }
              );
              if (res && res.ok) {
                const centralSale = await res.json().catch(() => null);
                const saleData = centralSale && centralSale.sale ? centralSale.sale : centralSale;
                const centralOrRaw =
                  saleData && (saleData.or_number ?? saleData.or_no ?? saleData.receipt_no ?? saleData.receipt_number ?? saleData.orNumber ?? saleData.orNo);
                const centralOr =
                  centralOrRaw != null && String(centralOrRaw).trim() ? String(centralOrRaw).trim() : null;
                if (centralOr) {
                  const [taken] = await pool.query(
                    "SELECT sale_id FROM sales WHERE or_number = ? AND sale_id != ? LIMIT 1",
                    [centralOr, saleId]
                  );
                  if (!taken || taken.length === 0) {
                    await pool.query("UPDATE sales SET or_number = ? WHERE sale_id = ?", [centralOr, saleId]);
                  }
                }
              }
            }
          } catch (e) {
            // Non-fatal: sale is already applied, we just couldn't get the OR number from central
          }
        }
        break;
      }
      case "sale_issue": {
        // Mirror central sale_issue changes into local sale_issues for customer/sale UIs.
        // For voided/refunded, also mirror onto local sales.status for badge consistency.
        const rawSaleId = Number(data.sale_id);
        const rawIssueId = Number(data.issue_id ?? change.entity_id);
        if (!Number.isFinite(rawSaleId) || rawSaleId <= 0 || !Number.isFinite(rawIssueId) || rawIssueId <= 0) break;
        const saleId = centralEntityIdToLocal(rawSaleId);
        const issueId = centralEntityIdToLocal(rawIssueId);

        const st = String(data.status || "").toLowerCase() || "open";

        const reason = data.reason != null ? String(data.reason) : null;
        const note = data.note != null ? String(data.note) : null;
        const cashierName =
          data.cashier_name != null ? String(data.cashier_name) : null;
        const createdAt = data.created_at != null ? String(data.created_at) : null;

        let cashierId = await localUserFkOrNull(data.cashier_id);
        let resolvedByAdminId = await localUserFkOrNull(data.resolved_by_admin_id);
        const resolvedByAdminName =
          data.resolved_by_admin_name != null ? String(data.resolved_by_admin_name) : null;
        const resolutionNote =
          data.resolution_note != null ? String(data.resolution_note) : null;
        const resolutionAction =
          data.resolution_action != null ? String(data.resolution_action) : null;
        const resolvedAt = data.resolved_at != null ? String(data.resolved_at) : null;

        // SQLite sale_issues uses issue_id as PK, so we can upsert to keep history consistent.
        await pool.query(
          `INSERT INTO sale_issues
           (issue_id, sale_id, reason, note, status, cashier_id, cashier_name, created_at,
            resolved_by_admin_id, resolved_by_admin_name, resolution_note, resolution_action, resolved_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(issue_id) DO UPDATE SET
             sale_id = excluded.sale_id,
             reason = COALESCE(excluded.reason, reason),
             note = COALESCE(excluded.note, note),
             status = excluded.status,
             cashier_id = COALESCE(excluded.cashier_id, cashier_id),
             cashier_name = COALESCE(excluded.cashier_name, cashier_name),
             created_at = COALESCE(excluded.created_at, created_at),
             resolved_by_admin_id = COALESCE(excluded.resolved_by_admin_id, resolved_by_admin_id),
             resolved_by_admin_name = COALESCE(excluded.resolved_by_admin_name, resolved_by_admin_name),
             resolution_note = COALESCE(excluded.resolution_note, resolution_note),
             resolution_action = COALESCE(excluded.resolution_action, resolution_action),
             resolved_at = COALESCE(excluded.resolved_at, resolved_at)`,
          [
            issueId,
            saleId,
            reason,
            note,
            st,
            cashierId,
            cashierName,
            createdAt,
            resolvedByAdminId,
            resolvedByAdminName,
            resolutionNote,
            resolutionAction,
            resolvedAt,
          ]
        );

        if (st === "voided" || st === "refunded") {
          await pool.query("UPDATE sales SET status = ? WHERE sale_id = ?", [st, saleId]);
        }
        break;
      }
      case "payment": {
        const rawSaleId = Number(data.sale_id ?? change.entity_id);
        if (!Number.isFinite(rawSaleId) || rawSaleId <= 0) break;
        const saleId = centralEntityIdToLocal(rawSaleId);

        const amount = Number(data.amount_paid) || 0;
        if (amount <= 0) break;

        const payMethod =
          typeof data.payment_method === "string" && data.payment_method
            ? data.payment_method
            : "cash";
        const referenceNumber =
          data.reference_number != null && String(data.reference_number).trim()
            ? String(data.reference_number).trim()
            : null;
        const paymentRef = referenceNumber || payMethod;

        const [saleExists] = await pool.query(
          "SELECT sale_id FROM sales WHERE sale_id = ? LIMIT 1",
          [saleId]
        );
        if (!saleExists || saleExists.length === 0) {
          // Tolerate out-of-order pull (payment before sale).
          await pool.query(
            "INSERT INTO sales (sale_id, status, sale_date) VALUES (?, 'partial', datetime('now','localtime'))",
            [saleId]
          );
        }

        await pool.query(
          "INSERT INTO payments (sale_id, amount_paid, payment_date, reference_number, payment_method) VALUES (?, ?, datetime('now','localtime'), ?, ?)",
          [saleId, amount, paymentRef, payMethod]
        );

        const [[saleRow]] = await pool.query(
          "SELECT amount_paid, total_amount, remaining_balance FROM sales WHERE sale_id = ?",
          [saleId]
        );
        const currentPaid = saleRow ? Number(saleRow.amount_paid) || 0 : 0;
        const currentRemaining = saleRow
          ? Number(saleRow.remaining_balance) || 0
          : 0;
        const totalAmount = saleRow ? Number(saleRow.total_amount) || 0 : 0;

        const newPaid = currentPaid + amount;
        let newRemaining =
          currentRemaining > 0
            ? Math.max(0, currentRemaining - amount)
            : Math.max(0, totalAmount - newPaid);
        const status = newRemaining <= 0 ? "paid" : "partial";

        await pool.query(
          "UPDATE sales SET amount_paid = ?, remaining_balance = ?, status = ? WHERE sale_id = ?",
          [newPaid, newRemaining, status, saleId]
        );
        break;
      }
      default:
        return;
    }
  } catch (e) {
    if (CENTRAL_SYNC_DEBUG) {
      console.error("[CentralSync] failed to apply change:", entityType, op, e?.message || e);
    }
  }
}

// Pull worker: fetches central change_log entries and applies them into local SQLite.
function startCentralPullWorker() {
  const INTERVAL_MS = 9000;

  let pullErrorLogged = false;

  const tick = async () => {
    let hadError = false;
    try {
      const centralUrl = await getCentralBaseUrl();
      if (!centralUrl) {
        pullErrorLogged = false;
        return;
      }
      const thisClientId = await getClientIdSetting();
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
        if (CENTRAL_SYNC_DEBUG) {
          console.error("[CentralSync] pull failed:", resp.status, String(text || "").slice(0, 200));
        }
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
        const isOwnChange = sourceClientId && sourceClientId === thisClientId;

        // For our own sale: still apply central's or_number so local display shows central OR when online.
        if (isOwnChange && String(change.entity_type || "").toLowerCase() === "sale") {
          const data = payload && payload.data && typeof payload.data === "object"
            ? payload.data
            : payload && typeof payload === "object"
            ? payload
            : null;
          const rawSaleId = data && (data.id ?? data.sale_id) != null ? Number(data.id ?? data.sale_id) : NaN;
          const localSaleId = Number.isFinite(rawSaleId) ? centralEntityIdToLocal(rawSaleId) : NaN;
          const centralOr = data && typeof data.or_number === "string" && data.or_number.trim()
            ? data.or_number.trim()
            : null;
          if (Number.isFinite(localSaleId) && centralOr) {
            try {
              const [taken] = await pool.query(
                "SELECT sale_id FROM sales WHERE or_number = ? AND sale_id != ? LIMIT 1",
                [centralOr, localSaleId]
              );
              if (!taken || taken.length === 0) {
                await pool.query(
                  "UPDATE sales SET or_number = ? WHERE sale_id = ?",
                  [centralOr, localSaleId]
                );
              }
            } catch (_) {}
          }
          continue;
        }

        // Skip other operations that originated from this client (we already applied them locally).
        if (isOwnChange) {
          continue;
        }

        await applyCentralChangeToLocal(change, payload);
      }

      if (maxId > lastId) {
        const tick = String(Date.now());
        await pool.query(
          "INSERT INTO settings (setting_key, setting_value) VALUES ('central_last_pulled_change_id', ?) ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value",
          [String(maxId)]
        );
        await pool.query(
          "INSERT INTO settings (setting_key, setting_value) VALUES ('central_pull_tick', ?) ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value",
          [tick]
        );
      }
    } catch (e) {
      hadError = true;
      if (!pullErrorLogged) {
        if (CENTRAL_SYNC_DEBUG) {
          console.error("[CentralSync] error during pull:", e?.message || e);
        }
        pullErrorLogged = true;
      }
    } finally {
      if (!hadError) {
        pullErrorLogged = false;
      }
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
app.use(
  "/js",
  (req, res, next) => {
    // Electron can keep renderer cache between runs; force fresh JS.
    res.setHeader("Cache-Control", "no-store, max-age=0");
    next();
  },
  express.static(path.join(frontendDir, "js"))
);
app.use(
  "/css",
  (req, res, next) => {
    res.setHeader("Cache-Control", "no-store, max-age=0");
    next();
  },
  express.static(path.join(frontendDir, "css"))
);
app.use(express.static(frontendDir));

// Expose select vendor libraries (e.g. Chart.js) from node_modules
if (fs.existsSync(nodeModulesDir)) {
  // Lightweight debug logger so you can see Chart.js requests in the terminal.
  app.use("/vendor", (req, res, next) => {
    if (req.path.includes("chart.js")) {
      console.log("[Static] Chart.js requested:", req.path);
    }
    next();
  });

  app.use(
    "/vendor",
    express.static(nodeModulesDir, {
      // Extra safety: do not list directory contents
      index: false,
      redirect: false,
    })
  );
}


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

