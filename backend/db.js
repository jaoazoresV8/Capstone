import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));


const dbPath =
  process.env.SQLITE_DB_PATH ||
  path.join(__dirname, "..", "data", "sales_management.db");


const dataDir = path.dirname(dbPath);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(dbPath);

// Enable foreign keys
db.pragma("foreign_keys = ON");

// Robustness + multi-client performance (single server process, many HTTP clients)
try {
  db.pragma("journal_mode = WAL");
} catch (e) {
  console.warn("[db] Failed to enable WAL mode:", e?.message || e);
}
try {
  // FULL prioritizes durability (no data loss after COMMIT), at the cost of a bit of speed.
  db.pragma("synchronous = FULL");
} catch (e) {
  console.warn("[db] Failed to set synchronous pragma:", e?.message || e);
}
try {
  db.pragma("busy_timeout = 5000");
} catch (e) {
  console.warn("[db] Failed to set busy_timeout pragma:", e?.message || e);
}
try {
  db.pragma("temp_store = MEMORY");
  db.pragma("cache_size = -20000");
} catch (_) {}

function ensureChangeLog() {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS change_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_type TEXT NOT NULL,
        entity_id INTEGER NOT NULL,
        operation TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
      );
      CREATE INDEX IF NOT EXISTS idx_change_log_id ON change_log(id);
      CREATE INDEX IF NOT EXISTS idx_change_log_entity ON change_log(entity_type, entity_id);
    `);
  } catch (e) {
    console.warn("[db] Failed to ensure change_log:", e?.message || e);
  }
}

function ensureIdempotencyKeys() {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS idempotency_keys (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        idem_key TEXT NOT NULL,
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        response_status INTEGER NOT NULL,
        response_body TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        UNIQUE(idem_key, method, path)
      );
      CREATE INDEX IF NOT EXISTS idx_idem_created_at ON idempotency_keys(created_at DESC);
    `);
  } catch (e) {
    console.warn("[db] Failed to ensure idempotency_keys:", e?.message || e);
  }
}

function applyBuildDefaults() {
  const defaultsPath = path.join(__dirname, "..", "build-defaults.json");
  if (!fs.existsSync(defaultsPath)) return;

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(defaultsPath, "utf8"));
  } catch (_) {
    return;
  }

  const s = parsed && parsed.settings ? parsed.settings : {};

  const parseBool = (raw, defaultVal) => {
    if (raw == null) return defaultVal;
    if (typeof raw === "boolean") return raw;
    const v = String(raw).trim().toLowerCase();
    if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
    if (v === "0" || v === "false" || v === "no" || v === "off") return false;
    return defaultVal;
  };

  const entries = [];

  const markup = Number(s.markup_percent);
  if (Number.isFinite(markup) && markup >= 0 && markup < 100) {
    entries.push(["markup_percent", String(Math.round(markup * 100) / 100)]);
  }

  const clientId = typeof s.client_id === "string" ? s.client_id.trim() : "";
  if (clientId) entries.push(["client_id", clientId.slice(0, 64)]);

  const centralApiUrl = typeof s.central_api_url === "string" ? s.central_api_url.trim() : "";
  if (centralApiUrl) entries.push(["central_api_url", centralApiUrl.slice(0, 255)]);

  entries.push(["pref_allow_hotkeys", parseBool(s.pref_allow_hotkeys, true) ? "1" : "0"]);
  entries.push(["pref_enable_modal_drag", parseBool(s.pref_enable_modal_drag, true) ? "1" : "0"]);

  try {
    const insertStmt = db.prepare(
      "INSERT OR REPLACE INTO settings (setting_key, setting_value) VALUES (?, ?)"
    );
    for (const [k, v] of entries) {
      insertStmt.run(k, v);
    }

    const markupEntry = entries.find(([k]) => k === "markup_percent");
    if (markupEntry) {
      const pct = parseFloat(markupEntry[1]);
      if (Number.isFinite(pct) && pct >= 0 && pct < 100) {
        db.prepare("UPDATE products SET selling_price = ROUND(supplier_price / (1 - ? / 100), 2)").run(pct);
      }
    }
  } catch (_) {
    // Ignore build defaults if something unexpected happens.
  }
}

function ensureColumn(table, column, alterSql, label) {
  try {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    const hasColumn = (cols || []).some((c) => c.name === column);
    if (!hasColumn) {
      db.exec(alterSql);
      console.log(`[db] Added column ${label}`);
    }
  } catch (e) {
    if (e && !/duplicate column name/i.test(String(e.message))) {
      console.warn(`[db] Migration ${label}:`, e.message);
    }
  }
}

// Auto-initialize of schema
const tableCount = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'").get();
if (tableCount.n === 0) {
  const schemaPath = path.join(__dirname, "schema.sqlite.sql");
  if (fs.existsSync(schemaPath)) {
    const schema = fs.readFileSync(schemaPath, "utf8");
    db.exec(schema);
  }
  ensureChangeLog();
  ensureIdempotencyKeys();
  applyBuildDefaults();
} else {
  try {
    db.exec("ALTER TABLE users ADD COLUMN allowed_pages TEXT");
    console.log("[db] Added column users.allowed_pages");
  } catch (e) {
    if (e && !/duplicate column name/i.test(String(e.message))) console.warn("[db] Migration allowed_pages:", e.message);
  }
  try {
    db.exec("ALTER TABLE payments ADD COLUMN payment_method TEXT");
    console.log("[db] Added column payments.payment_method");
  } catch (e) {
    if (e && !/duplicate column name/i.test(String(e.message))) console.warn("[db] Migration payment_method:", e.message);
  }
  try {
    db.exec("ALTER TABLE products ADD COLUMN recorded_by_name TEXT");
    console.log("[db] Added column products.recorded_by_name");
  } catch (e) {
    if (e && !/duplicate column name/i.test(String(e.message))) console.warn("[db] Migration products.recorded_by_name:", e.message);
  }
  try {
    db.exec("ALTER TABLE sales ADD COLUMN customer_contact TEXT");
    console.log("[db] Added column sales.customer_contact");
  } catch (e) {
    if (e && !/duplicate column name/i.test(String(e.message))) console.warn("[db] Migration sales.customer_contact:", e.message);
  }
  try {
    db.exec("ALTER TABLE sales ADD COLUMN customer_address TEXT");
    console.log("[db] Added column sales.customer_address");
  } catch (e) {
    if (e && !/duplicate column name/i.test(String(e.message))) console.warn("[db] Migration sales.customer_address:", e.message);
  }
  try {
    db.exec("ALTER TABLE sales ADD COLUMN sale_uuid TEXT");
    console.log("[db] Added column sales.sale_uuid");
  } catch (e) {
    if (e && !/duplicate column name/i.test(String(e.message))) console.warn("[db] Migration sales.sale_uuid:", e.message);
  }
  try {
    db.exec("UPDATE payments SET payment_method = reference_number WHERE payment_method IS NULL AND reference_number IN ('cash','gcash','paymaya')");
  } catch (_) {}
  // Ensure activity_log exists (for dashboard overview)
  try {
    const hasActivityLog = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='activity_log'").get();
    if (!hasActivityLog) {
      db.exec(`
        CREATE TABLE activity_log (
          activity_id INTEGER PRIMARY KEY AUTOINCREMENT,
          type TEXT NOT NULL CHECK (type IN ('sale','payment','product','customer')),
          title TEXT NOT NULL,
          details TEXT,
          amount REAL,
          created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
        );
        CREATE INDEX IF NOT EXISTS idx_activity_created_at ON activity_log(created_at DESC);
      `);
      console.log("[db] Created table activity_log");
    }
  } catch (e) {
    if (e && !/already exists/i.test(String(e.message))) console.warn("[db] Migration activity_log:", e.message);
  }

  // Ensure local sale_issues table exists for offline flagging of sale issues
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS sale_issues (
        issue_id INTEGER PRIMARY KEY AUTOINCREMENT,
        sale_id INTEGER NOT NULL,
        reason TEXT NOT NULL,
        note TEXT,
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','voided','refunded')),
        cashier_id INTEGER NOT NULL,
        cashier_name TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        resolved_by_admin_id INTEGER,
        resolved_by_admin_name TEXT,
        resolution_note TEXT,
        resolution_action TEXT,
        resolved_at TEXT,
        FOREIGN KEY (sale_id) REFERENCES sales(sale_id),
        FOREIGN KEY (cashier_id) REFERENCES users(user_id),
        FOREIGN KEY (resolved_by_admin_id) REFERENCES users(user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_sale_issues_sale_status ON sale_issues(sale_id, status);
      CREATE INDEX IF NOT EXISTS idx_sale_issues_created_at ON sale_issues(created_at DESC);
    `);
  } catch (e) {
    console.warn("[db] Failed to ensure sale_issues:", e?.message || e);
  }

  // Performance indexes for common queries/searches
  try {
    db.exec(`
      -- Products: search/filter/sort
      CREATE INDEX IF NOT EXISTS idx_products_name ON products(name);
      CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);
      CREATE INDEX IF NOT EXISTS idx_products_recorded_at ON products(recorded_at);

      -- Sales: date + status + customer for listing/filtering
      CREATE INDEX IF NOT EXISTS idx_sales_sale_date ON sales(sale_date DESC, sale_id DESC);
      CREATE INDEX IF NOT EXISTS idx_sales_status ON sales(status);
      CREATE INDEX IF NOT EXISTS idx_sales_customer_name ON sales(customer_name);

      -- Payments: by sale and date
      CREATE INDEX IF NOT EXISTS idx_payments_sale_id ON payments(sale_id);
      CREATE INDEX IF NOT EXISTS idx_payments_payment_date ON payments(payment_date DESC, payment_id DESC);
    `);
  } catch (e) {
    console.warn("[db] Failed to create performance indexes:", e?.message || e);
  }

  ensureChangeLog();
  ensureIdempotencyKeys();
}

// Keep critical columns available regardless of init path (fresh schema vs existing DB).
ensureColumn(
  "products",
  "recorded_by_name",
  "ALTER TABLE products ADD COLUMN recorded_by_name TEXT",
  "products.recorded_by_name"
);


function expandParams(sql, params) {
  if (!params || params.length === 0) return { sql, params };
  const out = [];
  let i = 0;
  const newParams = [];
  for (const p of params) {
    if (Array.isArray(p)) {
      const placeholders = p.map(() => "?").join(",");
      const idx = sql.indexOf("?", i);
      if (idx === -1) break;
      sql = sql.slice(0, idx) + placeholders + sql.slice(idx + 1);
      i = idx + placeholders.length;
      newParams.push(...p);
    } else {
      const idx = sql.indexOf("?", i);
      if (idx === -1) break;
      i = idx + 1;
      newParams.push(p);
    }
  }
  return { sql, params: newParams };
}


function runQuery(dbInstance, sql, params = []) {
  const { sql: expandedSql, params: expandedParams } = expandParams(sql, params);
  const upper = expandedSql.trim().toUpperCase();
  const isSelect =
    upper.startsWith("SELECT") ||
    upper.startsWith("PRAGMA") ||
    (upper.startsWith("WITH") && upper.includes("SELECT"));

  if (isSelect) {
    const stmt = dbInstance.prepare(expandedSql);
    const rows = stmt.all(...expandedParams);
    return [rows];
  }

  const stmt = dbInstance.prepare(expandedSql);
  const result = stmt.run(...expandedParams);
  return [
    {
      insertId: Number(result.lastInsertRowid),
      affectedRows: result.changes,
    },
  ];
}

const ALLOWED_TABLES = new Set([
  "users",
  "customers",
  "suppliers",
  "products",
  "sales",
  "sale_items",
  "payments",
  "settings",
  "password_reset_requests",
  "activity_log",
  "change_log",
  "sale_issues",
]);


export function getTableColumns(tableName) {
  if (!ALLOWED_TABLES.has(String(tableName))) return [];
  const [rows] = runQuery(db, `PRAGMA table_info("${String(tableName).replace(/"/g, '""')}")`);
  return (rows || []).map((r) => r.name);
}

//checking if a table has a given column
export function tableHasColumn(tableName, columnName) {
  const cols = getTableColumns(tableName);
  return cols.includes(columnName);
}

const pool = {
  //Execution query
  query(sql, params = []) {
    return Promise.resolve(runQuery(db, sql, params));
  },

 
  getConnection() {
    return Promise.resolve({
      query(sql, params = []) {
        return Promise.resolve(runQuery(db, sql, params));
      },
      beginTransaction() {
        db.exec("BEGIN IMMEDIATE");
        return Promise.resolve();
      },
      commit() {
        db.exec("COMMIT");
        return Promise.resolve();
      },
      rollback() {
        try {
          db.exec("ROLLBACK");
        } catch (_) {}
        return Promise.resolve();
      },
      release() {
        return Promise.resolve();
      },
    });
  },
};

export default pool;
