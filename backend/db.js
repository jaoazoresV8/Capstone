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

// Auto-initialize of schema
const tableCount = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'").get();
if (tableCount.n === 0) {
  const schemaPath = path.join(__dirname, "schema.sqlite.sql");
  if (fs.existsSync(schemaPath)) {
    const schema = fs.readFileSync(schemaPath, "utf8");
    db.exec(schema);
  }
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
}


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
        db.exec("BEGIN");
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
