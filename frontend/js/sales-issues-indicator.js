import { API_ORIGIN } from "./config.js";

const SALES_API = `${API_ORIGIN}/api/sales`;

function getToken() {
  return localStorage.getItem("sm_token");
}

function authHeaders() {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function showSaleIssuesDot(count) {
  const dot = document.getElementById("nav-sale-issues-dot");
  if (!dot) return;
  dot.classList.toggle("d-none", !(count > 0));
}

async function fetchOpenIssuesCount() {
  const res = await fetch(`${SALES_API}/issues/open-count`, {
    headers: authHeaders(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.message || "Failed to load open sale issues count.");
  }
  return Number(data.open || 0);
}

export function initSalesIssuesIndicator() {
  const userRaw = localStorage.getItem("sm_user");
  let polling = null;

  const refreshDot = async () => {
    try {
      const count = await fetchOpenIssuesCount();
      showSaleIssuesDot(count);
    } catch {
      // Silent failure: leave dot as-is
    }
  };

  try {
    const user = userRaw ? JSON.parse(userRaw) : null;
    if (user?.role === "admin") {
      // Initial fetch + polling for admins
      refreshDot();
      polling = setInterval(refreshDot, 15000);
      window.addEventListener("central:refresh", () => {
        void refreshDot();
      });
    }
  } catch {
    // Ignore JSON errors
  }

  window.addEventListener("beforeunload", () => {
    if (polling) clearInterval(polling);
  });
}

