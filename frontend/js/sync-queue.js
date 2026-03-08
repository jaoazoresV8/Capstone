import { API_ORIGIN } from "./config.js";

const SYNC_PUSH_API = `${API_ORIGIN}/api/sync/push`;
const SALE_MAPPING_API = `${API_ORIGIN}/api/sync/sale-mapping`;
const SYNC_QUEUE_KEY = "sm_sync_queue";
const CLIENT_ID_KEY = "sm_client_id";
const SALE_UUID_MAP_KEY = "sm_sale_uuid_map";

function getToken() {
  try {
    return localStorage.getItem("sm_token");
  } catch (_) {
    return null;
  }
}

function authHeaders() {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function getTerminalPrefix() {
  try {
    const stored = localStorage.getItem("dm_terminal_prefix");
    if (stored && typeof stored === "string" && stored.trim()) {
      return stored.trim();
    }
  } catch (_) {
    // Ignore storage errors and fall back
  }
  return "C01";
}

export function getSyncClientId() {
  try {
    const stored = localStorage.getItem(CLIENT_ID_KEY);
    if (stored && typeof stored === "string" && stored.trim()) {
      return stored.trim();
    }
  } catch (_) {
    // Ignore storage errors and fall through to auto ID
  }

  // Auto-generate a stable per-device clientId if none has been saved yet.
  // This still prefers the terminal/branch prefix so central can recognise it.
  const prefix = getTerminalPrefix();
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  const autoId = `${prefix}-AUTO-${rand}`;
  try {
    localStorage.setItem(CLIENT_ID_KEY, autoId);
  } catch (_) {
    // Ignore if we can't persist; we'll just recompute later.
  }
  return autoId;
}

export function generateUuidV4() {
  if (typeof crypto !== "undefined") {
    if (typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    if (crypto.getRandomValues) {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      // Per RFC 4122 section 4.4
      bytes[6] = (bytes[6] & 0x0f) | 0x40; // Version 4
      bytes[8] = (bytes[8] & 0x3f) | 0x80; // Variant 10xx
      const toHex = (n) => n.toString(16).padStart(2, "0");
      const b = Array.prototype.map.call(bytes, (x) => toHex(x));
      return (
        b[0] + b[1] + b[2] + b[3] + "-" +
        b[4] + b[5] + "-" +
        b[6] + b[7] + "-" +
        b[8] + b[9] + "-" +
        b[10] + b[11] + b[12] + b[13] + b[14] + b[15]
      );
    }
  }
  // Fallback (lower quality, but still unique enough for local use)
  const rand = () =>
    Math.floor((1 + Math.random()) * 0x10000)
      .toString(16)
      .substring(1);
  return (
    rand() + rand() + "-" +
    rand() + "-" +
    rand() + "-" +
    rand() + "-" +
    rand() + rand() + rand()
  );
}

function loadQueue() {
  try {
    const raw = localStorage.getItem(SYNC_QUEUE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function saveQueue(queue) {
  try {
    localStorage.setItem(SYNC_QUEUE_KEY, JSON.stringify(queue || []));
  } catch (_) {
    // If we can't persist, silently ignore – operations just won't be queued.
  }
}

function ensureLocalId(op) {
  if (op && op.localId) return op;
  const localId =
    "op-" +
    Date.now().toString(36) +
    "-" +
    Math.random().toString(36).slice(2, 10);
  return { ...op, localId };
}

let flushing = false;

export function enqueueSyncOperation(operation) {
  if (!operation || typeof operation !== "object") return;
  const opWithId = ensureLocalId(operation);
  const queue = loadQueue();
  queue.push(opWithId);
  saveQueue(queue);
  // Try to flush in the background; failures simply leave the queue for later.
  void flushSyncQueue();
}

export async function flushSyncQueue() {
  if (flushing) return;
  const token = getToken();
  if (!token) {
    // Not authenticated – keep queue for later when user logs in again.
    return;
  }
  let queue = loadQueue();
  if (!queue.length) return;

  flushing = true;
  try {
    const clientId = getSyncClientId();

    // Send in small batches so a single failure doesn't block everything.
    while (queue.length) {
      const batch = queue.slice(0, 20);
      const res = await fetch(SYNC_PUSH_API, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders(),
        },
        body: JSON.stringify({
          clientId,
          operations: batch,
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // If central is unreachable or rejects the push, leave the queue as‑is.
        // Admins can inspect conflicts using central tools.
        // Optionally we could surface a toast here in the future.
        console.error("Sync push failed:", data.message || res.statusText);
        break;
      }

      // On success, drop the batch and continue with remaining operations.
      queue = queue.slice(batch.length);
      saveQueue(queue);
    }
  } catch (err) {
    console.error("Sync flush error:", err);
  } finally {
    flushing = false;
  }
}

export function rememberSaleUuidMapping(localSaleId, saleUuid, receiptNo) {
  if (!localSaleId || !saleUuid) return;
  try {
    const raw = localStorage.getItem(SALE_UUID_MAP_KEY);
    const map = raw ? JSON.parse(raw) || {} : {};
    const key = String(localSaleId);
    map[key] = {
      sale_uuid: saleUuid,
      receipt_no: receiptNo || null,
    };
    localStorage.setItem(SALE_UUID_MAP_KEY, JSON.stringify(map));
  } catch (_) {
    // Ignore mapping persistence errors – sync can still fall back to sale_id.
  }
}

export function getSaleUuidForLocalId(localSaleId) {
  if (!localSaleId) return null;
  try {
    const raw = localStorage.getItem(SALE_UUID_MAP_KEY);
    if (!raw) return null;
    const map = JSON.parse(raw);
    const entry = map && map[String(localSaleId)];
    return entry && entry.sale_uuid ? entry.sale_uuid : null;
  } catch (_) {
    return null;
  }
}

export async function fetchSaleMappingByUuid(uuids) {
  const list = Array.isArray(uuids) ? uuids : [uuids];
  const filtered = list.filter((u) => typeof u === "string" && u.trim());
  if (!filtered.length) return [];
  const qs = filtered.map((u) => encodeURIComponent(u.trim())).join(",");
  const url = `${SALE_MAPPING_API}?sale_uuid=${qs}`;
  const res = await fetch(url, { headers: authHeaders() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.message || "Failed to load central sale mapping.");
  }
  return Array.isArray(data.mappings) ? data.mappings : [];
}

// Best-effort automatic flushing:
// - shortly after page load
// - whenever the browser regains connectivity
if (typeof window !== "undefined") {
  window.addEventListener("DOMContentLoaded", () => {
    setTimeout(() => {
      void flushSyncQueue();
    }, 2000);
  });
  window.addEventListener("online", () => {
    void flushSyncQueue();
  });
}

