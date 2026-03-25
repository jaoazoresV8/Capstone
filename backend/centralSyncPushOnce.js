/**
 * Push pending local change_log rows to central immediately (one batch).
 * Used after void/refund/issue updates so central does not wait for the 7s interval worker.
 */
import pool from "./db.js";

const CENTRAL_SYNC_DEBUG = (process.env.CENTRAL_SYNC_DEBUG || "").trim() === "1";

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

export async function pushPendingChangesToCentralOnce() {
  try {
    const centralUrl = await getCentralBaseUrl();
    if (!centralUrl) return;

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

    const clientId = await getClientIdSetting();
    const body = { clientId, operations };

    const resp = await fetch(`${centralUrl}/api/sync/push`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      if (CENTRAL_SYNC_DEBUG) {
        console.error("[CentralSync] immediate push failed:", resp.status, text.slice(0, 200));
      }
      return;
    }

    const pushResult = await resp.json().catch(() => null);
    const appliedLocalIds = Array.isArray(pushResult?.applied)
      ? pushResult.applied
          .map((a) => Number(a?.localId))
          .filter((id) => Number.isFinite(id) && id > 0)
      : [];
    const failedCount = Array.isArray(pushResult?.failed) ? pushResult.failed.length : 0;

    let maxId = lastId;
    if (appliedLocalIds.length > 0) {
      maxId = Math.max(...appliedLocalIds);
    } else if (!pushResult || (pushResult?.success === true && failedCount === 0)) {
      maxId = changes[changes.length - 1].id;
    } else {
      if (CENTRAL_SYNC_DEBUG) {
        console.warn(
          "[CentralSync] immediate push: no applied ops; keeping last pushed id at",
          lastId
        );
      }
      return;
    }

    await pool.query(
      "INSERT INTO settings (setting_key, setting_value) VALUES ('central_last_pushed_change_id', ?) ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value",
      [String(maxId)]
    );

    if (CENTRAL_SYNC_DEBUG) {
      console.log(
        `[CentralSync] immediate push batch=${changes.length}, applied=${appliedLocalIds.length || "unknown"}, failed=${failedCount}, now at id ${maxId}`
      );
    }
  } catch (e) {
    if (CENTRAL_SYNC_DEBUG) {
      console.error("[CentralSync] immediate push error:", e?.message || e);
    }
  }
}
