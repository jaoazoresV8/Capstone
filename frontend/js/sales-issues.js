import { API_ORIGIN } from "./config.js";

const SALES_API = `${API_ORIGIN}/api/sales`;

function getToken() {
  return localStorage.getItem("sm_token");
}

function authHeaders() {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function showIssuesAlert(message, type = "info") {
  const el = document.getElementById("sale-issues-alert");
  if (!el) return;
  el.textContent = message;
  el.className = `alert alert-${type} py-2 small`;
  el.classList.remove("d-none");
}

function clearIssuesAlert() {
  const el = document.getElementById("sale-issues-alert");
  if (!el) return;
  el.textContent = "";
  el.className = "alert alert-info py-2 small d-none";
}

function updateIssuesBadge(count) {
  const badge = document.getElementById("nav-sale-issues-count");
  const dot = document.getElementById("nav-sale-issues-dot");
  const has = count > 0;
  if (badge) {
    badge.classList.toggle("d-none", !has);
    badge.textContent = String(count || 0);
  }
  if (dot) {
    dot.classList.toggle("d-none", !has);
  }
}

async function fetchOpenIssues() {
  const res = await fetch(`${SALES_API}/issues?status=open`, {
    headers: authHeaders(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.message || "Failed to load sale issues.");
  }
  const list = Array.isArray(data.issues) ? data.issues : [];
  updateIssuesBadge(list.length);
  return list;
}

function renderIssues(list) {
  const tbody = document.getElementById("sale-issues-tbody");
  if (!tbody) return;
  if (!list.length) {
    tbody.innerHTML =
      '<tr><td colspan="7" class="text-muted small">No open sale issues.</td></tr>';
    return;
  }

  tbody.innerHTML = list
    .map((iss) => {
      const createdAt = iss.created_at
        ? new Date(iss.created_at).toLocaleString()
        : "";
      const status = iss.status || "open";
      const statusBadge =
        status === "open"
          ? '<span class="badge bg-danger">open</span>'
          : status === "resolved"
          ? '<span class="badge bg-success">resolved</span>'
          : status === "voided"
          ? '<span class="badge bg-secondary">voided</span>'
          : status === "refunded"
          ? '<span class="badge bg-secondary">refunded</span>'
          : `<span class="badge bg-light text-dark">${status}</span>`;
      const reasonLabel =
        iss.reason === "wrong_item"
          ? "Wrong item"
          : iss.reason === "pricing_error"
          ? "Pricing error"
          : iss.reason === "duplicate"
          ? "Duplicate"
          : iss.reason === "payment_issue"
          ? "Payment issue"
          : "Other";
      const cust = iss.customer_name || "Customer";
      const cashier =
        iss.cashier_name || (iss.cashier_id ? `User #${iss.cashier_id}` : "—");
      return `<tr data-issue-id="${iss.issue_id}" data-sale-id="${iss.sale_id}">
        <td>#${iss.sale_id}</td>
        <td>${cust}</td>
        <td>${reasonLabel}</td>
        <td>${cashier}</td>
        <td>${createdAt}</td>
        <td>${statusBadge}</td>
        <td class="text-end">
          <button type="button" class="btn btn-outline-primary btn-sm" data-action="review-sale-issue" data-sale-id="${iss.sale_id}">
            Review in Sales
          </button>
        </td>
      </tr>`;
    })
    .join("");
}

export function initSaleIssuesAdmin() {
  const btnOpen = document.getElementById("btn-open-sale-issues");
  const modalEl = document.getElementById("saleIssuesModal");
  if (!btnOpen || !modalEl) return;

  const openModal = async () => {
    clearIssuesAlert();
    const tbody = document.getElementById("sale-issues-tbody");
    if (tbody) {
      tbody.innerHTML =
        '<tr><td colspan="7" class="text-muted small">Loading…</td></tr>';
    }
    try {
      const list = await fetchOpenIssues();
      renderIssues(list);
    } catch (err) {
      showIssuesAlert(err.message || "Failed to load sale issues.", "danger");
    }
    const m = new bootstrap.Modal(modalEl);
    m.show();
  };

  btnOpen.addEventListener("click", (e) => {
    e.preventDefault();
    openModal();
  });

  document.addEventListener("click", (e) => {
    const btn = e.target.closest(
      "button[data-action='review-sale-issue'][data-sale-id]"
    );
    if (!btn) return;
    const saleId = btn.getAttribute("data-sale-id");
    if (!saleId) return;
    // Navigate to sales page and open issues there
    const params = new URLSearchParams({ saleId: String(saleId), focusIssue: "1" });
    window.location.href = `./sales.html?${params.toString()}`;
  });
}

