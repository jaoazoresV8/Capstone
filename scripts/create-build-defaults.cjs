const fs = require("fs");
const path = require("path");
const os = require("os");
const Database = require("better-sqlite3");

const root = path.join(__dirname, "..");

const defaultsOutPath = path.join(root, "build-defaults.json");

// This script runs on the developer machine before packaging. We read the
// currently-used SQLite settings and freeze them into the build.
const devDbPath = process.env.SQLITE_DB_PATH || path.join(root, "data", "sales_management.db");

const defaultSettings = {
  markup_percent: 10,
  client_id: process.env.CLIENT_ID && String(process.env.CLIENT_ID).trim() ? String(process.env.CLIENT_ID).trim() : os.hostname() || "client",
  central_api_url: "",
  pref_allow_hotkeys: true,
  pref_enable_modal_drag: true,
};

function parseBool(raw, defaultVal) {
  if (raw == null) return defaultVal;
  if (typeof raw === "boolean") return raw;
  const s = String(raw).trim().toLowerCase();
  if (s === "1" || s === "true" || s === "yes" || s === "on") return true;
  if (s === "0" || s === "false" || s === "no" || s === "off") return false;
  return defaultVal;
}

function tryReadSettingsFromDb(dbPath) {
  if (!fs.existsSync(dbPath)) return null;
  const db = new Database(dbPath, { readonly: true });

  const keys = [
    "markup_percent",
    "client_id",
    "central_api_url",
    "pref_allow_hotkeys",
    "pref_enable_modal_drag",
  ];

  const rows = db
    .prepare(`SELECT setting_key, setting_value FROM settings WHERE setting_key IN (${keys.map(() => "?").join(",")})`)
    .all(keys);

  const map = new Map((rows || []).map((r) => [r.setting_key, r.setting_value]));

  return {
    markup_percent: parseFloat(map.get("markup_percent")) || defaultSettings.markup_percent,
    client_id: String(map.get("client_id") ?? defaultSettings.client_id).trim() || defaultSettings.client_id,
    central_api_url: String(map.get("central_api_url") ?? defaultSettings.central_api_url).trim() || "",
    pref_allow_hotkeys: parseBool(map.get("pref_allow_hotkeys"), defaultSettings.pref_allow_hotkeys),
    pref_enable_modal_drag: parseBool(map.get("pref_enable_modal_drag"), defaultSettings.pref_enable_modal_drag),
  };
}

function main() {
  let settings = null;
  try {
    settings = tryReadSettingsFromDb(devDbPath);
  } catch (e) {
    // Keep defaults.
  }
  if (!settings) settings = defaultSettings;

  // Clamp markup into valid range for safety.
  if (!Number.isFinite(settings.markup_percent)) settings.markup_percent = 10;
  if (settings.markup_percent < 0) settings.markup_percent = 0;
  if (settings.markup_percent >= 100) settings.markup_percent = 99.99;
  settings.markup_percent = Math.round(settings.markup_percent * 100) / 100;

  const out = {
    generated_at: new Date().toISOString(),
    settings,
    version: 1,
  };

  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(defaultsOutPath, JSON.stringify(out, null, 2), "utf8");
  console.log("Created", defaultsOutPath);
}

main();

