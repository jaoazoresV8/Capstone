import { initPasswordResetAdmin } from "./password-resets.js";
import { initSalesIssuesIndicator } from "./sales-issues-indicator.js";
import { initSaleIssuesAdmin } from "./sales-issues.js";
import { API_ORIGIN } from "./config.js";

const API_BASE = `${API_ORIGIN}/api/auth`;
const SETTINGS_API = `${API_ORIGIN}/api/settings`;
const DASHBOARD_API = `${API_ORIGIN}/api/dashboard/overview`;
const SYNC_STATUS_API = `${API_ORIGIN}/api/client-sync-status`;

const logoutBtn = document.getElementById("logout-btn");

function getAuthHeaders() {
  const token = localStorage.getItem("sm_token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function loadMarkupSetting() {
  const input = document.getElementById("settings-markup-percent");
  if (!input) return;
  try {
    const res = await fetch(SETTINGS_API, { headers: getAuthHeaders() });
    if (res.ok) {
      const data = await res.json();
      input.value = data.markup_percent ?? 10;
    }
  } catch {
    input.value = 10;
  }
}

function initMarkupSetting() {
  loadMarkupSetting();
  document.addEventListener("click", async (e) => {
    if (!e.target.closest("#btn-save-markup")) return;
    const input = document.getElementById("settings-markup-percent");
    const feedback = document.getElementById("markup-feedback");
    if (!input) return;
    const value = parseFloat(input.value);
    if (isNaN(value) || value < 0 || value > 999) {
      if (feedback) {
        feedback.textContent = "Enter a number between 0 and 999.";
        feedback.className = "small mt-2 text-danger";
      }
      return;
    }
    if (feedback) feedback.textContent = "";
    try {
      const res = await fetch(SETTINGS_API, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ markup_percent: value }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (feedback) {
          feedback.textContent = data.message || "Failed to update.";
          feedback.className = "small mt-2 text-danger";
        }
        return;
      }
      if (feedback) {
        feedback.textContent = "Markup percentage updated.";
        feedback.className = "small mt-2 text-success";
      }
    } catch {
      if (feedback) {
        feedback.textContent = "Failed to update.";
        feedback.className = "small mt-2 text-danger";
      }
    }
  });
}

async function loadAppSettings() {
  const input = document.getElementById("settings-client-id");
  const feedback = document.getElementById("client-id-feedback");
  const centralFeedback = document.getElementById("central-url-feedback");
  if (!input) return;
  if (feedback) {
    feedback.textContent = "";
    feedback.className = "small mt-2 text-muted";
  }
  if (centralFeedback) {
    centralFeedback.textContent = "";
    centralFeedback.className = "small mt-1 text-muted";
  }
  try {
    const res = await fetch(SETTINGS_API, { headers: getAuthHeaders() });
    if (!res.ok) return;
    const data = await res.json().catch(() => ({}));
    if (data && typeof data.client_id === "string") {
      input.value = data.client_id;
    }
    if (typeof data.central_api_url === "string") {
      setCentralAddressUIFromUrl(data.central_api_url);
    }
  } catch {
    // ignore
  }
}

function getCentralAddressUIEls() {
  return {
    schemeEl: document.getElementById("settings-central-scheme"),
    octets: [
      document.getElementById("settings-central-octet-0"),
      document.getElementById("settings-central-octet-1"),
      document.getElementById("settings-central-octet-2"),
      document.getElementById("settings-central-octet-3"),
    ],
    portEl: document.getElementById("settings-central-port"),
  };
}

function setCentralAddressUIFromUrl(raw) {
  const { schemeEl, octets, portEl } = getCentralAddressUIEls();
  if (!octets[0]) return; // modal not mounted / not admin

  const v = String(raw || "").trim();
  if (!v) {
    if (schemeEl) schemeEl.value = "http";
    octets.forEach((el) => {
      if (el) el.value = "";
    });
    if (portEl) portEl.value = "";
    return;
  }

  // Accept: http(s)://A.B.C.D(:PORT) or A.B.C.D(:PORT)
  let scheme = "http";
  let host = "";
  let port = "";

  try {
    const normalized = /^(https?:)?\/\//i.test(v) ? v : `http://${v}`;
    const u = new URL(normalized);
    scheme = (u.protocol || "http:").replace(":", "") || "http";
    host = u.hostname || "";
    port = u.port || "";
  } catch {
    const m = v.match(/^(https?)?:?\/\/?(\d{1,3}(?:\.\d{1,3}){3})(?::(\d{1,5}))?/i);
    if (m) {
      scheme = (m[1] || "http").toLowerCase();
      host = m[2] || "";
      port = m[3] || "";
    }
  }

  if (schemeEl) schemeEl.value = scheme === "https" ? "https" : "http";

  const parts = host.split(".");
  for (let i = 0; i < 4; i++) {
    const el = octets[i];
    if (!el) continue;
    el.value = parts[i] ?? "";
  }
  if (portEl) portEl.value = port || "";
}

function parseCentralAddressFromUI() {
  const { schemeEl, octets, portEl } = getCentralAddressUIEls();
  if (!octets[0]) return { ok: true, url: "" };

  const scheme = schemeEl && schemeEl.value === "https" ? "https" : "http";
  const rawOctets = octets.map((el) => String(el?.value || "").trim());
  const rawPort = String(portEl?.value || "").trim();

  const allEmpty = rawOctets.every((x) => !x) && !rawPort;
  if (allEmpty) return { ok: true, url: "" };

  // Require all 4 octets filled if any are present.
  if (rawOctets.some((x) => !x)) {
    return { ok: false, message: "Enter a complete IPv4 address (4 numbers).", url: "" };
  }

  const nums = rawOctets.map((x) => Number(x));
  if (nums.some((n) => !Number.isFinite(n) || n < 0 || n > 255 || !Number.isInteger(n))) {
    return { ok: false, message: "Each IPv4 octet must be a whole number from 0 to 255.", url: "" };
  }

  let port = "";
  if (rawPort) {
    const p = Number(rawPort);
    if (!Number.isFinite(p) || p < 1 || p > 65535 || !Number.isInteger(p)) {
      return { ok: false, message: "Port must be a whole number from 1 to 65535.", url: "" };
    }
    port = String(p);
  }

  const ip = nums.join(".");
  const url = `${scheme}://${ip}${port ? `:${port}` : ""}`;
  return { ok: true, url };
}

function bindCentralIpv4Behavior() {
  const { octets, portEl } = getCentralAddressUIEls();
  if (!octets[0] || octets[0].dataset.bound) return;
  octets.forEach((el) => {
    if (el) el.dataset.bound = "1";
  });
  if (portEl) portEl.dataset.bound = "1";

  const focusOctet = (idx) => {
    const el = octets[idx];
    if (!el) return;
    el.focus();
    el.select?.();
  };

  const sanitizeDigits = (s) => String(s || "").replace(/[^\d]/g, "");

  const handleOctetInput = (idx, el) => {
    const before = el.value;
    let v = sanitizeDigits(before).slice(0, 3);
    if (v !== before) el.value = v;
    if (v.length >= 3 && idx < 3) focusOctet(idx + 1);
  };

  const clampOctetOnBlur = (el) => {
    const v = sanitizeDigits(el.value);
    if (!v) {
      el.value = "";
      return;
    }
    let n = Number(v);
    if (!Number.isFinite(n)) {
      el.value = "";
      return;
    }
    if (n > 255) n = 255;
    if (n < 0) n = 0;
    el.value = String(Math.trunc(n));
  };

  const parsePaste = (text) => {
    const t = String(text || "").trim();
    if (!t) return null;
    const m = t.match(/^(https?)?:?\/\/?(\d{1,3}(?:\.\d{1,3}){3})(?::(\d{1,5}))?/i);
    if (!m) return null;
    return { scheme: (m[1] || "").toLowerCase(), ip: m[2], port: m[3] || "" };
  };

  octets.forEach((el, idx) => {
    if (!el) return;
    el.addEventListener("input", () => handleOctetInput(idx, el));
    el.addEventListener("blur", () => clampOctetOnBlur(el));
    el.addEventListener("keydown", (e) => {
      if (e.key === "." || e.key === "Decimal") {
        e.preventDefault();
        if (idx < 3) focusOctet(idx + 1);
        return;
      }
      if (e.key === "Backspace" && el.selectionStart === 0 && el.selectionEnd === 0) {
        if (!el.value && idx > 0) {
          e.preventDefault();
          const prev = octets[idx - 1];
          if (prev) {
            prev.focus();
            const len = prev.value.length;
            prev.setSelectionRange?.(len, len);
          }
        }
      }
    });
    el.addEventListener("paste", (e) => {
      const txt = (e.clipboardData || window.clipboardData)?.getData("text") || "";
      const parsed = parsePaste(txt);
      if (!parsed) return;
      e.preventDefault();
      setCentralAddressUIFromUrl(txt);
      focusOctet(3);
    });
  });

  if (portEl) {
    portEl.addEventListener("input", () => {
      const before = portEl.value;
      const v = sanitizeDigits(before).slice(0, 5);
      if (v !== before) portEl.value = v;
    });
  }
}

function initNavRefreshButton() {
  const btn = document.getElementById("nav-refresh-btn");
  if (!btn || btn.dataset.bound) return;
  btn.dataset.bound = "1";
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    window.dispatchEvent(new CustomEvent("app:refresh", { bubbles: true }));
  });
}

function initClientIdSettingsModal() {
  // Central address: segmented IPv4 input (dots are separators, not editable characters)
  bindCentralIpv4Behavior();

  document.addEventListener("click", async (e) => {
    const openBtn = e.target.closest("#btn-open-app-settings");
    if (!openBtn) return;
    e.preventDefault();
    await loadAppSettings();
    bindCentralIpv4Behavior();
    const modalEl = document.getElementById("appSettingsModal");
    if (!modalEl || typeof bootstrap === "undefined") return;
    bootstrap.Modal.getOrCreateInstance(modalEl).show();
  });

  document.addEventListener("click", async (e) => {
    const saveBtn = e.target.closest("#btn-save-client-id");
    if (!saveBtn) return;
    e.preventDefault();
    const input = document.getElementById("settings-client-id");
    const feedback = document.getElementById("client-id-feedback");
    const centralFeedback = document.getElementById("central-url-feedback");
    if (!input) return;
    const cid = String(input.value || "").trim();
    if (!cid) {
      if (feedback) {
        feedback.textContent = "Client ID cannot be empty.";
        feedback.className = "small mt-2 text-danger";
      }
      return;
    }
    if (cid.length > 64) {
      if (feedback) {
        feedback.textContent = "Client ID must be 64 characters or less.";
        feedback.className = "small mt-2 text-danger";
      }
      return;
    }

    if (feedback) {
      feedback.textContent = "Saving…";
      feedback.className = "small mt-2 text-muted";
    }
    if (centralFeedback) {
      centralFeedback.textContent = "";
      centralFeedback.className = "small mt-1 text-muted";
    }

    const centralParsed = parseCentralAddressFromUI();
    if (!centralParsed.ok) {
      if (centralFeedback) {
        centralFeedback.textContent = centralParsed.message || "Invalid central server address.";
        centralFeedback.className = "small mt-1 text-danger";
      }
      if (feedback) {
        feedback.textContent = "Fix the central server address, then try again.";
        feedback.className = "small mt-2 text-danger";
      }
      return;
    }

    try {
      const res = await fetch(SETTINGS_API, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({
          client_id: cid,
          central_api_url: centralParsed.url,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (feedback) {
          feedback.textContent = data.message || "Failed to update Client ID.";
          feedback.className = "small mt-2 text-danger";
        }
        if (centralFeedback && data && data.message) {
          centralFeedback.textContent = data.message;
          centralFeedback.className = "small mt-1 text-danger";
        }
        return;
      }
      if (feedback) {
        feedback.textContent = "Client ID saved.";
        feedback.className = "small mt-2 text-success";
      }
      // Also cache Client ID locally for sync-queue.js to use when pushing operations.
      try {
        localStorage.setItem("sm_client_id", cid);
      } catch (_) {
        // Ignore local storage failures; server-side Client ID is still saved.
      }
      if (centralFeedback && data && typeof data.central_api_url === "string") {
        setCentralAddressUIFromUrl(data.central_api_url);
        centralFeedback.textContent =
          data.central_api_url.trim()
            ? `Using central server: ${data.central_api_url.trim()}`
            : "Central server disabled (local-only mode).";
        centralFeedback.className = "small mt-1 text-muted";
      }
    } catch {
      if (feedback) {
        feedback.textContent = "Failed to update Client ID.";
        feedback.className = "small mt-2 text-danger";
      }
      if (centralFeedback) {
        centralFeedback.textContent = "Failed to update central server address.";
        centralFeedback.className = "small mt-1 text-danger";
      }
    }
  });

  document.addEventListener("click", async (e) => {
    const testBtn = e.target.closest("#btn-test-central-connection");
    if (!testBtn) return;
    if (testBtn.dataset.loading === "1") return;
    e.preventDefault();
    const centralFeedback = document.getElementById("central-url-feedback");

    const originalDisabled = testBtn.disabled;
    const originalLabel = testBtn.innerHTML;
    const startLoading = () => {
      testBtn.dataset.loading = "1";
      testBtn.disabled = true;
      testBtn.innerHTML =
        '<span class="dm-test-connecting">' +
        '  <img class="dm-test-connecting-icon" src="/images/DM.ico" alt="" aria-hidden="true" onerror="this.onerror=null;this.src=\'/images/DM-logo.jpg\';" />' +
        "  <span>Connecting...</span>" +
        "</span>";
      testBtn.classList.add("dm-test-loading");
    };
    const stopLoading = () => {
      delete testBtn.dataset.loading;
      testBtn.disabled = originalDisabled;
      testBtn.innerHTML = originalLabel;
      testBtn.classList.remove("dm-test-loading");
    };

    startLoading();

    if (centralFeedback) {
      centralFeedback.textContent = "Testing connection…";
      centralFeedback.className = "small mt-1 text-muted";
    }
    try {
      const res = await fetch(SYNC_STATUS_API, { headers: getAuthHeaders() });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (centralFeedback) {
          centralFeedback.textContent = "Failed to contact central status endpoint.";
          centralFeedback.className = "small mt-1 text-danger";
        }
        stopLoading();
        return;
      }
      if (!data.centralConfigured || data.mode === "local") {
        if (centralFeedback) {
          centralFeedback.textContent = "Central server is not configured (local-only mode).";
          centralFeedback.className = "small mt-1 text-muted";
        }
        stopLoading();
        return;
      }
      if (data.centralReachable) {
        if (centralFeedback) {
          centralFeedback.textContent = "Central connection OK.";
          centralFeedback.className = "small mt-1 text-success";
        }
      } else {
        if (centralFeedback) {
          centralFeedback.textContent =
            data.error === "timeout"
              ? "Central server timed out."
              : "Central server is not reachable.";
          centralFeedback.className = "small mt-1 text-danger";
        }
      }
    } catch {
      if (centralFeedback) {
        centralFeedback.textContent = "Central server is not reachable.";
        centralFeedback.className = "small mt-1 text-danger";
      }
    } finally {
      stopLoading();
    }
  });
}
const navUserName = document.getElementById("nav-user-name");

let syncStatusTimer = null;

async function fetchAndRenderSyncStatus() {
  const wrap = document.getElementById("nav-sync-indicator");
  const icon = document.getElementById("nav-sync-icon");
  const text = document.getElementById("nav-sync-text");
  const spinner = document.getElementById("nav-sync-spinner");
  if (!wrap || !icon || !text || !spinner) return;

  wrap.classList.remove("sync-online", "sync-offline", "sync-local-only");
  spinner.classList.remove("d-none");

  try {
    const res = await fetch(SYNC_STATUS_API, { headers: getAuthHeaders() });
    const data = await res.json().catch(() => ({}));

    spinner.classList.add("d-none");

    if (!data.centralConfigured || data.mode === "local") {
      wrap.classList.add("sync-local-only");
      icon.className = "bi bi-hdd-network me-1";
      text.textContent = "Local database only";
      return;
    }

    if (data.centralReachable) {
      wrap.classList.add("sync-online");
      icon.className = "bi bi-cloud-check me-1";
      text.textContent = "Synced with central";
    } else {
      wrap.classList.add("sync-offline");
      icon.className = "bi bi-shield-check me-1";
      text.textContent = "Central offline – storing locally";
    }
  } catch {
    spinner.classList.add("d-none");
    wrap.classList.add("sync-offline");
    icon.className = "bi bi-shield-check me-1";
    text.textContent = "Central offline – storing locally";
  }
}

function initSyncStatusPolling() {
  fetchAndRenderSyncStatus();
  if (syncStatusTimer) clearInterval(syncStatusTimer);
  syncStatusTimer = setInterval(fetchAndRenderSyncStatus, 15000);
}

async function loadDashboardOverview() {
  try {
    const res = await fetch(DASHBOARD_API, { headers: getAuthHeaders() });
    if (!res.ok) return;
    const data = await res.json();

    // Today sales
    const todaySalesEl = document.getElementById("stat-today-sales");
    const todayMetaEl = document.getElementById("stat-today-meta");
    if (todaySalesEl) {
      todaySalesEl.textContent = `₱${Number(data.todaySalesAmount || 0).toFixed(2)}`;
    }
    if (todayMetaEl) {
      const txCount = data.todaySalesCount || 0;
      todayMetaEl.textContent = txCount === 1 ? "1 transaction today" : `${txCount} transactions today`;
    }

    // Outstanding balance
    const balEl = document.getElementById("stat-outstanding-balance");
    const balMetaEl = document.getElementById("stat-balance-meta");
    if (balEl) {
      balEl.textContent = `₱${Number(data.outstandingBalance || 0).toFixed(2)}`;
    }
    if (balMetaEl) {
      const count = data.customersWithBalance || 0;
      balMetaEl.textContent =
        count === 0
          ? "0 customers with balance"
          : count === 1
          ? "1 customer with balance"
          : `${count} customers with balance`;
    }

    // Low stock items
    const lowStockEl = document.getElementById("stat-low-stock");
    if (lowStockEl) {
      lowStockEl.textContent = String(data.lowStockCount || 0);
    }

    // Top 5 products
    const topList = document.getElementById("dashboard-top-sales-list");
    if (topList) {
      const top = Array.isArray(data.topProducts) ? data.topProducts : [];
      if (!top.length) {
        topList.innerHTML = `
          <li class="d-flex justify-content-between align-items-center py-1 border-bottom">
            <span class="text-muted">No data yet.</span>
            <span class="text-muted">₱0.00</span>
          </li>`;
      } else {
        topList.innerHTML = top
          .map(
            (p) => `
          <li class="d-flex justify-content-between align-items-center py-1 border-bottom">
            <span>${p.name}</span>
            <span>₱${Number(p.total_amount || 0).toFixed(2)}</span>
          </li>`
          )
          .join("");
      }
    }

    // Recent activity
    const activityList = document.getElementById("activity-list");
    if (activityList) {
      const items = Array.isArray(data.recentActivity) ? data.recentActivity : [];
      if (!items.length) return;
      activityList.innerHTML = items
        .map((a) => {
          let iconClass = "bi-activity";
          let activityClass = "sale";
          if (a.type === "payment") {
            iconClass = "bi-cash-coin";
            activityClass = "payment";
          } else if (a.type === "product") {
            iconClass = "bi-box-seam";
            activityClass = "product";
          }
          const amountPart =
            a.amount != null ? `₱${Number(a.amount).toFixed(2)}` : "";
          const detail =
            a.details && a.details.trim()
              ? a.details.trim()
              : amountPart || "";
          return `
          <li class="activity-item">
            <div class="activity-icon ${activityClass}"><i class="bi ${iconClass}"></i></div>
            <div class="activity-body">
              <div class="activity-title">${a.title}</div>
              <div class="activity-meta">${detail || new Date(a.created_at).toLocaleString()}</div>
            </div>
          </li>`;
        })
        .join("");
    }
  } catch {
    
  }
}

const highlightActiveNav = () => {
  const page = document.body.dataset.page;
  if (!page) return;

  document
    .querySelectorAll("[data-page-link]")
    .forEach((link) => link.classList.remove("active"));

  const active = document.querySelector(`[data-page-link="${page}"]`);
  if (active) {
    active.classList.add("active");
  }
};

function applyStaffPageRestriction(user) {
  const allowedPages = user?.allowed_pages;
  const isRestrictedStaff =
    user?.role === "staff" &&
    Array.isArray(allowedPages) &&
    allowedPages.length > 0;
  if (!isRestrictedStaff) return;
  const currentPage = document.body?.dataset?.page || "overview";
  if (!allowedPages.includes(currentPage)) {
    const first = allowedPages[0];
    const file = first === "overview" ? "dashboard" : first;
    window.location.href = `./${file}.html`;
    return true;
  }
  document.querySelectorAll("[data-page-link]").forEach((link) => {
    const page = link.getAttribute("data-page-link");
    if (page && !allowedPages.includes(page)) link.closest(".nav-item")?.classList.add("d-none");
  });
  return false;
}

const ensureAuthenticated = async () => {
  const token = localStorage.getItem("sm_token");
  const userRaw = localStorage.getItem("sm_user");

  if (!token || !userRaw) {
    document.body.classList.remove("page-loading");
    window.location.href = "/";
    return;
  }

 
  try {
    const storedUser = JSON.parse(userRaw);
    if (applyStaffPageRestriction(storedUser) === true) return;
  } catch (_) {}

  try {
    const res = await fetch(`${API_BASE}/me`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!res.ok) {
      throw new Error("Session expired");
    }

    const data = await res.json();
    const user = data.user || JSON.parse(userRaw);
    if (user) localStorage.setItem("sm_user", JSON.stringify(user));

    if (navUserName && user?.name) {
      navUserName.textContent = user.name;
    }

    // Staff page access: hide nav and redirect if on disallowed page
    if (applyStaffPageRestriction(user) === true) return;

    // Dashboard welcome message (time-based greeting + name)
    const welcomeTitle = document.getElementById("welcome-title");
    if (welcomeTitle && user?.name) {
      const hour = new Date().getHours();
      let greeting = "Welcome back";
      if (hour < 12) greeting = "Good morning";
      else if (hour < 17) greeting = "Good afternoon";
      else greeting = "Good evening";
      welcomeTitle.textContent = `${greeting}, ${user.name}`;
    }

    // Show admin-only nav links only for admins (they are hidden by default in CSS)
    if (user.role === "admin") {
      document.body.classList.add("admin-visible");
      initPasswordResetAdmin();
      initSalesIssuesIndicator();
      initSaleIssuesAdmin();
      initMarkupSetting();
    }
  } catch {
    localStorage.removeItem("sm_token");
    localStorage.removeItem("sm_user");
    window.location.href = "/";
  } finally {
    document.body.classList.remove("page-loading");
  }
};

if (logoutBtn) {
  logoutBtn.addEventListener("click", () => {
    localStorage.removeItem("sm_token");
    localStorage.removeItem("sm_user");
    window.location.href = "/";
  });
}

window.addEventListener("DOMContentLoaded", () => {
  highlightActiveNav();
  initSyncStatusPolling();
  initNavRefreshButton();
  initClientIdSettingsModal();
  
  ensureAuthenticated().catch(() => {
    document.body.classList.remove("page-loading");
  });
  
  loadDashboardOverview();
});

window.addEventListener("pjax:complete", (e) => {
  if (e.detail && e.detail.page === "overview") {
    loadMarkupSetting();
    loadDashboardOverview();
  }
});

if (document.body) {
  if (document.body.dataset.page === "overview") loadMarkupSetting();
  const observer = new MutationObserver(() => {
    if (document.body.dataset.page === "overview") loadMarkupSetting();
  });
  observer.observe(document.body, { attributes: true, attributeFilter: ["data-page"] });
}
