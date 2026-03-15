// Shared API origin for all frontend modules.
// - In dev (Vite/Live Server ports like 5500/3000): use localhost:5000
// - In packaged/Electron or when served from backend: use current origin
// - Optional override: window.API_ORIGIN (if set before scripts load)

const DEV_PORTS = new Set(["", "5500", "3000"]);

function computeApiOrigin() {
  if (typeof window === "undefined") return "http://localhost:5000";

  if (window.API_ORIGIN && typeof window.API_ORIGIN === "string" && window.API_ORIGIN.trim()) {
    return window.API_ORIGIN.replace(/\/+$/, "");
  }

  const { protocol, hostname, port } = window.location;
  if (DEV_PORTS.has(String(port))) {
    return "http://localhost:5000";
  }

  return `${protocol}//${hostname}${port ? `:${port}` : ""}`;
}

export const API_ORIGIN = computeApiOrigin();

// Feature flag: enable real-time OR WebSocket integration with central.
// - false (default): never open ws://.../ws/sales-or, avoids console errors if backend WS is missing.
// - true: frontend will connect to /ws/sales-or and listen for sale_or_resolved messages.
export const ENABLE_SALE_OR_WEBSOCKET = false;

