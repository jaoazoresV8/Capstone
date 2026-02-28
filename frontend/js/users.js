import { API_ORIGIN } from "./config.js";

const USERS_BASE = `${API_ORIGIN}/api/users`;

const tableBody = document.getElementById("users-table-body");
const alertBox = document.getElementById("users-alert");
const modalEl = document.getElementById("userModal");
const userForm = document.getElementById("user-form");
const idInput = document.getElementById("user-id");
const nameInput = document.getElementById("user-name");
const usernameInput = document.getElementById("user-username");
const emailInput = document.getElementById("user-email");
const roleInput = document.getElementById("user-role");
const passwordInput = document.getElementById("user-password");
const modalTitle = document.getElementById("userModalLabel");
const pageAccessWrap = document.getElementById("user-page-access-wrap");
const pageAccessAll = document.getElementById("user-page-access-all");
const pageAccessSelected = document.getElementById("user-page-access-selected");
const pageCheckboxesWrap = document.getElementById("user-page-checkboxes");

const deleteUserModalEl = document.getElementById("deleteUserModal");
const deleteUserMessageEl = document.getElementById("delete-user-message");
const deleteUserTypingEl = document.getElementById("delete-user-typing");
const deleteUserConfirmBtn = document.getElementById("delete-user-confirm-btn");

let deleteUserModalInstance = null;
let pendingDeleteUserId = null;
let pendingDeleteUserName = null;

const PAGE_KEYS = ["overview", "products", "customers", "sales", "payments", "reports"];

let bootstrapModal = null;

function escapeHtml(s) {
  if (s == null) return "";
  const str = String(s);
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function escapeAttr(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function syncPageAccessVisibility() {
  const isStaff = roleInput && roleInput.value === "staff";
  if (pageAccessWrap) pageAccessWrap.classList.toggle("d-none", !isStaff);
  if (!isStaff && pageCheckboxesWrap) pageCheckboxesWrap.classList.add("d-none");
}

function syncPageCheckboxesVisibility() {
  const show = pageAccessSelected && pageAccessSelected.checked;
  if (pageCheckboxesWrap) pageCheckboxesWrap.classList.toggle("d-none", !show);
}

function getSelectedPageAccess() {
  if (pageAccessAll && pageAccessAll.checked) return null;
  if (!pageAccessSelected || !pageAccessSelected.checked) return null;
  const cbs = document.querySelectorAll(".user-page-cb:checked");
  const arr = Array.from(cbs).map((cb) => cb.value).filter((v) => PAGE_KEYS.includes(v));
  return arr.length > 0 ? arr : null;
}

function setPageAccess(allowedPages) {
  if (!allowedPages || allowedPages.length === 0) {
    if (pageAccessAll) pageAccessAll.checked = true;
    if (pageAccessSelected) pageAccessSelected.checked = false;
    if (pageCheckboxesWrap) pageCheckboxesWrap.classList.add("d-none");
    document.querySelectorAll(".user-page-cb").forEach((cb) => (cb.checked = false));
    return;
  }
  if (pageAccessSelected) pageAccessSelected.checked = true;
  if (pageAccessAll) pageAccessAll.checked = false;
  if (pageCheckboxesWrap) pageCheckboxesWrap.classList.remove("d-none");
  document.querySelectorAll(".user-page-cb").forEach((cb) => {
    cb.checked = allowedPages.includes(cb.value);
  });
}

const showAlert = (message, type = "info") => {
  if (!alertBox) return;
  alertBox.textContent = message;
  alertBox.className = `alert alert-${type} py-2 small`;
};

const clearAlert = () => {
  if (!alertBox) return;
  alertBox.textContent = "";
  alertBox.className = "alert alert-info py-2 small d-none";
};

// Current logged-in user id (for disabling self-delete)
const getCurrentUserId = () => {
  const raw = localStorage.getItem("sm_user");
  if (!raw) return null;
  try {
    const user = JSON.parse(raw);
    return user.id != null ? String(user.id) : null;
  } catch {
    return null;
  }
};

let usersInitialized = false;

const loadUsers = async () => {
  const token = localStorage.getItem("sm_token");
  if (!token) {
    window.location.href = "/";
    return;
  }

  try {
    const res = await fetch(USERS_BASE, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!res.ok) {
      throw new Error("Unable to load users.");
    }

    const data = await res.json();
    const users = data.users || [];
    const currentUserId = getCurrentUserId();

    if (users.length === 0) {
      tableBody.innerHTML =
        '<tr><td colspan="6" class="text-muted small">No users yet.</td></tr>';
      return;
    }

    tableBody.innerHTML = users
      .map(
        (u) => {
          const allowed = Array.isArray(u.allowed_pages) ? u.allowed_pages.join(",") : "";
          const isSelf = currentUserId != null && String(u.id) === currentUserId;
          const deleteBtn = isSelf
            ? ""
            : ` <button class="btn btn-outline-danger btn-sm" data-action="delete" data-id="${u.id}" data-name="${escapeAttr(
                u.name,
              )}" title="Delete user">Delete</button>`;
          return `
      <tr data-id="${u.id}" data-allowed-pages="${allowed}">
        <td>${escapeHtml(u.name)}</td>
        <td>${escapeHtml(u.username)}</td>
        <td>${escapeHtml(u.email || "")}</td>
        <td class="text-capitalize">${escapeHtml(u.role)}</td>
        <td>${u.created_at ? new Date(u.created_at).toLocaleDateString() : ""}</td>
        <td class="text-end">
          <button class="btn btn-outline-secondary btn-sm me-1" data-action="edit" data-id="${u.id}">Edit</button>${deleteBtn}
        </td>
      </tr>
    `;
        },
      )
      .join("");
  } catch (err) {
    showAlert(err.message || "Failed to load users.", "danger");
  }
};

const openAddModal = () => {
  modalTitle.textContent = "Add User";
  idInput.value = "";
  nameInput.value = "";
  usernameInput.value = "";
  if (emailInput) emailInput.value = "";
  roleInput.value = "staff";
  passwordInput.value = "";
  setPageAccess(null);
  syncPageAccessVisibility();
  clearAlert();
};

const openEditModal = (row) => {
  modalTitle.textContent = "Edit User";
  idInput.value = row.dataset.id;
  nameInput.value = row.children[0].textContent;
  usernameInput.value = row.children[1].textContent;
  if (emailInput) emailInput.value = row.children[2].textContent;
  roleInput.value = row.children[3].textContent.toLowerCase();
  passwordInput.value = "";
  const allowedStr = row.dataset.allowedPages || "";
  const allowed = allowedStr ? allowedStr.split(",").filter(Boolean) : null;
  setPageAccess(allowed);
  syncPageAccessVisibility();
  clearAlert();
};

function openDeleteUserModal(id, name) {
  pendingDeleteUserId = id;
  pendingDeleteUserName = name || "this user";
  if (deleteUserMessageEl) {
    deleteUserMessageEl.innerHTML = `To delete <strong>${escapeHtml(name || "this user")}</strong>, type <strong>Delete</strong> below to confirm.`;
  }
  if (deleteUserTypingEl) {
    deleteUserTypingEl.value = "";
    deleteUserTypingEl.focus();
  }
  if (deleteUserConfirmBtn) deleteUserConfirmBtn.disabled = true;
  if (!deleteUserModalInstance) {
    deleteUserModalInstance = new bootstrap.Modal(deleteUserModalEl);
  }
  deleteUserModalInstance.show();
}

function closeDeleteUserModal() {
  pendingDeleteUserId = null;
  pendingDeleteUserName = null;
  if (deleteUserTypingEl) deleteUserTypingEl.value = "";
  if (deleteUserConfirmBtn) deleteUserConfirmBtn.disabled = true;
  if (deleteUserModalInstance) deleteUserModalInstance.hide();
}

async function performDeleteUser() {
  if (!pendingDeleteUserId) return;
  const id = pendingDeleteUserId;
  const token = localStorage.getItem("sm_token");
  if (!token) {
    window.location.href = "/";
    return;
  }
  try {
    const res = await fetch(`${USERS_BASE}/${id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || "Failed to delete user.");
    closeDeleteUserModal();
    showAlert("User deleted successfully.", "success");
    loadUsers();
  } catch (err) {
    showAlert(err.message || "Failed to delete user.", "danger");
  }
}

document.addEventListener("click", (e) => {
  if (!document.body || document.body.dataset.page !== "users") return;

  const deleteBtn = e.target.closest("button[data-action='delete'][data-id]");
  if (deleteBtn) {
    const id = deleteBtn.dataset.id;
    const name = deleteBtn.dataset.name || "this user";
    if (!id) return;
    openDeleteUserModal(id, name);
    return;
  }

  const editBtn = e.target.closest("button[data-action='edit'][data-id]");
  if (editBtn) {
    const id = editBtn.dataset.id;
    if (!id || !tableBody) return;
    const row =
      tableBody.querySelector(`tr[data-id="${id}"]`) ||
      Array.from(tableBody.querySelectorAll("tr[data-id]")).find((tr) => tr.dataset.id === id);
    if (!row) return;
    openEditModal(row);
    if (!bootstrapModal) {
      bootstrapModal = new bootstrap.Modal(modalEl);
    }
    bootstrapModal.show();
  }
});

if (deleteUserTypingEl) {
  deleteUserTypingEl.addEventListener("input", () => {
    if (deleteUserConfirmBtn) {
      deleteUserConfirmBtn.disabled = deleteUserTypingEl.value.trim() !== "Delete";
    }
  });
  deleteUserTypingEl.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && deleteUserTypingEl.value.trim() === "Delete") {
      ev.preventDefault();
      performDeleteUser();
    }
  });
}

if (deleteUserConfirmBtn) {
  deleteUserConfirmBtn.addEventListener("click", () => {
    if (deleteUserTypingEl && deleteUserTypingEl.value.trim() === "Delete") {
      performDeleteUser();
    }
  });
}

if (deleteUserModalEl) {
  deleteUserModalEl.addEventListener("hidden.bs.modal", () => {
    pendingDeleteUserId = null;
    pendingDeleteUserName = null;
    if (deleteUserTypingEl) deleteUserTypingEl.value = "";
    if (deleteUserConfirmBtn) deleteUserConfirmBtn.disabled = true;
  });
}

if (roleInput) {
  roleInput.addEventListener("change", syncPageAccessVisibility);
}
if (pageAccessSelected) {
  pageAccessSelected.addEventListener("change", syncPageCheckboxesVisibility);
}
if (pageAccessAll) {
  pageAccessAll.addEventListener("change", syncPageCheckboxesVisibility);
}

if (modalEl) {
  modalEl.addEventListener("show.bs.modal", (event) => {
    const button = event.relatedTarget;
    if (button && button.id === "add-user-btn") {
      openAddModal();
    } else {
      syncPageAccessVisibility();
      syncPageCheckboxesVisibility();
    }
  });
}

if (userForm) {
  userForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    clearAlert();

    const id = idInput.value;
    const name = nameInput.value.trim();
    const username = usernameInput.value.trim();
    const email = emailInput ? emailInput.value.trim() : "";
    const role = roleInput.value;
    const password = passwordInput.value;

    if (!name || !username) {
      showAlert("Name and username are required.", "warning");
      return;
    }

    const token = localStorage.getItem("sm_token");
    if (!token) {
      window.location.href = "/";
      return;
    }

    const payload = { name, username, email: email || null, role };
    if (role === "staff") {
      payload.allowed_pages = getSelectedPageAccess();
    } else {
      payload.allowed_pages = null;
    }
    if (!id || (id && password.trim() !== "")) {
      payload.password = password;
    }

    try {
      const res = await fetch(id ? `${USERS_BASE}/${id}` : USERS_BASE, {
        method: id ? "PUT" : "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(data.message || "Failed to save user.");
      }

      if (!bootstrapModal) {
        bootstrapModal = new bootstrap.Modal(modalEl);
      }
      bootstrapModal.hide();
      showAlert("User saved successfully.", "success");
      loadUsers();
    } catch (err) {
      showAlert(err.message || "Something went wrong.", "danger");
    }
  });
}

function initUsersPage() {
  if (!document.body || document.body.dataset.page !== "users") return;
  if (usersInitialized) return;
  usersInitialized = true;
  loadUsers();
}

// When landing directly on users.html, remove auth-pending/page-loading so content is visible
if (document.body) {
  document.body.classList.remove("auth-pending");
  document.body.classList.remove("page-loading");
}

// Initial load (direct visit)
window.addEventListener("DOMContentLoaded", initUsersPage);

// Re-run when navigating via PJAX
window.addEventListener("pjax:complete", function (e) {
  if (e && e.detail && e.detail.page === "users") {
    initUsersPage();
  }
});

// If this script is loaded dynamically after DOM is ready and we're already on users page
initUsersPage();

// Fallback: if page flag is set slightly later, poll briefly and init once
let usersInitPollCount = 0;
const usersInitPoll = setInterval(() => {
  if (usersInitialized || usersInitPollCount++ > 10) {
    clearInterval(usersInitPoll);
    return;
  }
  if (document.body && document.body.dataset.page === "users") {
    initUsersPage();
  }
}, 200);
