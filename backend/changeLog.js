import os from "os";
import pool from "./db.js";

const CLIENT_ID =
  (process.env.CLIENT_ID && String(process.env.CLIENT_ID).trim()) ||
  os.hostname() ||
  "client";

export async function logChange(entityType, entityId, operation, data) {
  try {
    const payloadObj = data == null ? {} : data;
    const payload = JSON.stringify(payloadObj);
    const safeEntityId = Number.isFinite(Number(entityId)) ? Number(entityId) : 0;
    await pool.query(
      "INSERT INTO change_log (entity_type, entity_id, operation, payload) VALUES (?, ?, ?, ?)",
      [String(entityType), safeEntityId, String(operation), payload]
    );
  } catch (e) {
    // Logging should never break main request flow
    console.warn(
      "[changeLog] Failed to log change:",
      e?.message || e
    );
  }
}

