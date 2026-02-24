import { initPasswordResetAdmin } from "./password-resets.js";

const API_ORIGIN =
  window.location.port === "5500"
    ? "http://localhost:5000"
    : window.location.origin;

const API_BASE = `${API_ORIGIN}/api/auth`;
const SETTINGS_API = `${API_ORIGIN}/api/settings`;
const DASHBOARD_API = `${API_ORIGIN}/api/dashboard/overview`;

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
const navUserName = document.getElementById("nav-user-name");

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
