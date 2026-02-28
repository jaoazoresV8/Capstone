import { API_ORIGIN } from "./config.js";

const BASE = `${API_ORIGIN}/api/password-resets`;

function getToken() {
  return localStorage.getItem("sm_token");
}

function authHeaders() {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function showAdminDot(count) {
  const dot = document.getElementById("nav-admin-reset-dot");
  const badge = document.getElementById("nav-admin-reset-count");
  if (dot) dot.classList.toggle("d-none", !(count > 0));
  if (badge) {
    badge.classList.toggle("d-none", !(count > 0));
    badge.textContent = String(count || 0);
  }
}

function setAlert(msg, type = "info") {
  const el = document.getElementById("password-requests-alert");
  if (!el) return;
  el.textContent = msg;
  el.className = `alert alert-${type} py-2 small`;
  el.classList.remove("d-none");
}

function clearAlert() {
  const el = document.getElementById("password-requests-alert");
  if (!el) return;
  el.textContent = "";
  el.className = "alert alert-info py-2 small d-none";
}

async function fetchPendingCount() {
  const res = await fetch(`${BASE}/pending-count`, { headers: authHeaders() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || "Failed to load pending count.");
  return Number(data.pending || 0);
}

async function fetchRequests(status = "pending") {
  const res = await fetch(`${BASE}/requests?status=${encodeURIComponent(status)}`, {
    headers: authHeaders(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || "Failed to load requests.");
  return data.requests || [];
}

function renderRequests(list) {
  const tbody = document.getElementById("password-requests-tbody");
  if (!tbody) return;
  if (!list.length) {
    tbody.innerHTML =
      '<tr><td colspan="6" class="text-muted small">No pending requests.</td></tr>';
    return;
  }

  tbody.innerHTML = list
    .map((r) => {
      const requestedAt = r.requested_at ? new Date(r.requested_at).toLocaleString() : "";
      const status = r.status || "pending";
      const statusBadge =
        status === "pending"
          ? '<span class="badge bg-warning text-dark">pending</span>'
          : status === "resolved"
            ? '<span class="badge bg-success">resolved</span>'
            : '<span class="badge bg-secondary">rejected</span>';

      const inputId = `password-reset-input-${r.id}`;
      const actionCells =
        status === "pending" && r.email
          ? `<td><input type="password" class="form-control form-control-sm" id="${inputId}" placeholder="New password" data-request-id="${r.id}" style="min-width: 8rem;" /></td><td class="text-end" style="min-width: 9rem;"><div class="d-flex flex-column gap-1 align-items-end"><button type="button" class="btn btn-primary btn-sm w-100 py-0" data-action="resolve-set-password" data-request-id="${r.id}">Set &amp; email</button><button type="button" class="btn btn-outline-success btn-sm w-100 py-0" data-action="resolve-generate" data-request-id="${r.id}">Generate &amp; email</button></div></td>`
          : `<td class="text-muted">—</td><td class="text-end">—</td>`;

      return `<tr data-request-id="${r.id}">
        <td>${r.username || ""}</td>
        <td>${r.email || "<span class='text-muted'>No email</span>"}</td>
        <td>${requestedAt}</td>
        <td>${statusBadge}</td>
        ${actionCells}
      </tr>`;
    })
    .join("");
}

async function resolveRequest(id, options = {}) {
  const body = { note: "Resolved via admin panel" };
  if (options.generate) body.generate = true;
  else if (options.new_password) body.new_password = options.new_password;
  const res = await fetch(`${BASE}/requests/${id}/resolve`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || "Failed to resolve request.");
  return data;
}

export function initPasswordResetAdmin() {
  const btnOpen = document.getElementById("btn-open-password-requests");
  const modalEl = document.getElementById("passwordRequestsModal");
  if (!modalEl) return;

  let polling = null;

  const refreshDot = async () => {
    try {
      const count = await fetchPendingCount();
      showAdminDot(count);
    } catch {
      
    }
  };

  const openModal = async () => {
    clearAlert();
    try {
      const list = await fetchRequests("pending");
      renderRequests(list);
    } catch (err) {
      setAlert(err.message || "Failed to load requests.", "danger");
    }
    const m = new bootstrap.Modal(modalEl);
    m.show();
  };

  if (btnOpen) {
    btnOpen.addEventListener("click", (e) => {
      e.preventDefault();
      openModal();
    });
  }

  modalEl.addEventListener("show.bs.modal", () => {
    // Refresh when opened
    refreshDot();
  });

  // Set & email: use password from input
  document.addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-action='resolve-set-password']");
    if (!btn) return;
    const id = btn.dataset.requestId;
    if (!id) return;
    const row = btn.closest("tr[data-request-id]");
    const input = row ? document.getElementById(`password-reset-input-${id}`) : null;
    const newPassword = input ? input.value.trim() : "";
    if (!newPassword) {
      setAlert("Enter a new password in the field, or use “Generate & email”.", "warning");
      return;
    }

    btn.disabled = true;
    clearAlert();
    setAlert("Setting password and sending email…", "info");

    try {
      await resolveRequest(id, { new_password: newPassword });
      setAlert("Password set and emailed.", "success");
      const list = await fetchRequests("pending");
      renderRequests(list);
      await refreshDot();
    } catch (err) {
      setAlert(err.message || "Failed to resolve.", "danger");
      btn.disabled = false;
    }
  });

  // Generate & email: auto-generate password
  document.addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-action='resolve-generate']");
    if (!btn) return;
    const id = btn.dataset.requestId;
    if (!id) return;

    btn.disabled = true;
    clearAlert();
    setAlert("Generating password and sending email…", "info");

    try {
      await resolveRequest(id, { generate: true });
      setAlert("Generated password emailed.", "success");
      const list = await fetchRequests("pending");
      renderRequests(list);
      await refreshDot();
    } catch (err) {
      setAlert(err.message || "Failed to resolve.", "danger");
      btn.disabled = false;
    }
  });

  // Start polling (admins only)
  const userRaw = localStorage.getItem("sm_user");
  try {
    const user = userRaw ? JSON.parse(userRaw) : null;
    if (user?.role === "admin") {
      refreshDot();
      polling = setInterval(refreshDot, 15000);
    }
  } catch {
    
  }

  // Stop polling when leaving page (best effort)
  window.addEventListener("beforeunload", () => {
    if (polling) clearInterval(polling);
  });
}

