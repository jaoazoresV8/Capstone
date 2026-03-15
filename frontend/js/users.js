import { API_ORIGIN } from "./config.js";

const USERS_BASE = `${API_ORIGIN}/api/users`;

const alertBox = document.getElementById("users-alert");

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
  const roleInputEl = document.getElementById("user-role");
  const pageAccessWrapEl = document.getElementById("user-page-access-wrap");
  const pageCheckboxesWrapEl = document.getElementById("user-page-checkboxes");

  const isStaff = roleInputEl && roleInputEl.value === "staff";
  if (pageAccessWrapEl) pageAccessWrapEl.classList.toggle("d-none", !isStaff);
  if (!isStaff && pageCheckboxesWrapEl) pageCheckboxesWrapEl.classList.add("d-none");
}

function syncPageCheckboxesVisibility() {
  const pageAccessSelectedEl = document.getElementById("user-page-access-selected");
  const pageCheckboxesWrapEl = document.getElementById("user-page-checkboxes");
  const show = pageAccessSelectedEl && pageAccessSelectedEl.checked;
  if (pageCheckboxesWrapEl) pageCheckboxesWrapEl.classList.toggle("d-none", !show);
}

function getSelectedPageAccess() {
  const pageAccessAllEl = document.getElementById("user-page-access-all");
  const pageAccessSelectedEl = document.getElementById("user-page-access-selected");

  if (pageAccessAllEl && pageAccessAllEl.checked) return null;
  if (!pageAccessSelectedEl || !pageAccessSelectedEl.checked) return null;
  const cbs = document.querySelectorAll(".user-page-cb:checked");
  const arr = Array.from(cbs).map((cb) => cb.value).filter((v) => PAGE_KEYS.includes(v));
  return arr.length > 0 ? arr : null;
}

function setPageAccess(allowedPages) {
  const pageAccessAllEl = document.getElementById("user-page-access-all");
  const pageAccessSelectedEl = document.getElementById("user-page-access-selected");
  const pageCheckboxesWrapEl = document.getElementById("user-page-checkboxes");

  if (!allowedPages || allowedPages.length === 0) {
    if (pageAccessAllEl) pageAccessAllEl.checked = true;
    if (pageAccessSelectedEl) pageAccessSelectedEl.checked = false;
    if (pageCheckboxesWrapEl) pageCheckboxesWrapEl.classList.add("d-none");
    document.querySelectorAll(".user-page-cb").forEach((cb) => (cb.checked = false));
    return;
  }
  if (pageAccessSelectedEl) pageAccessSelectedEl.checked = true;
  if (pageAccessAllEl) pageAccessAllEl.checked = false;
  if (pageCheckboxesWrapEl) pageCheckboxesWrapEl.classList.remove("d-none");
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

const loadUsers = async () => {
  const bodyEl = document.body;
  if (!bodyEl || bodyEl.dataset.page !== "users") return;

  const tableBodyEl = document.getElementById("users-table-body");
  if (!tableBodyEl) return;

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
      tableBodyEl.innerHTML =
        '<tr><td colspan="6" class="text-muted small">No users yet.</td></tr>';
      return;
    }

    tableBodyEl.innerHTML = users
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
  const modalTitleEl = document.getElementById("userModalLabel");
  const idInputEl = document.getElementById("user-id");
  const nameInputEl = document.getElementById("user-name");
  const usernameInputEl = document.getElementById("user-username");
  const emailInputEl = document.getElementById("user-email");
  const roleInputEl = document.getElementById("user-role");
  const passwordInputEl = document.getElementById("user-password");

  if (!modalTitleEl || !idInputEl || !nameInputEl || !usernameInputEl || !roleInputEl || !passwordInputEl) {
    return;
  }

  modalTitleEl.textContent = "Add User";
  idInputEl.value = "";
  nameInputEl.value = "";
  usernameInputEl.value = "";
  if (emailInputEl) emailInputEl.value = "";
  roleInputEl.value = "staff";
  passwordInputEl.value = "";
  setPageAccess(null);
  syncPageAccessVisibility();
  clearAlert();
};

const openEditModal = (row) => {
  const modalTitleEl = document.getElementById("userModalLabel");
  const idInputEl = document.getElementById("user-id");
  const nameInputEl = document.getElementById("user-name");
  const usernameInputEl = document.getElementById("user-username");
  const emailInputEl = document.getElementById("user-email");
  const roleInputEl = document.getElementById("user-role");
  const passwordInputEl = document.getElementById("user-password");

  if (!modalTitleEl || !idInputEl || !nameInputEl || !usernameInputEl || !roleInputEl || !passwordInputEl) {
    return;
  }

  modalTitleEl.textContent = "Edit User";
  idInputEl.value = row.dataset.id;
  nameInputEl.value = row.children[0].textContent;
  usernameInputEl.value = row.children[1].textContent;
  if (emailInputEl) emailInputEl.value = row.children[2].textContent;
  roleInputEl.value = row.children[3].textContent.toLowerCase();
  passwordInputEl.value = "";
  const allowedStr = row.dataset.allowedPages || "";
  const allowed = allowedStr ? allowedStr.split(",").filter(Boolean) : null;
  setPageAccess(allowed);
  syncPageAccessVisibility();
  clearAlert();
};

function openDeleteUserModal(id, name) {
  const deleteUserModalEl = document.getElementById("deleteUserModal");
  const deleteUserMessageEl = document.getElementById("delete-user-message");
  const deleteUserTypingEl = document.getElementById("delete-user-typing");
  const deleteUserConfirmBtn = document.getElementById("delete-user-confirm-btn");

  if (!deleteUserModalEl) return;

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
  const deleteUserTypingEl = document.getElementById("delete-user-typing");
  const deleteUserConfirmBtn = document.getElementById("delete-user-confirm-btn");

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
    if (!id) return;

    const tableBodyEl = document.getElementById("users-table-body");
    if (!tableBodyEl) return;

    const row =
      tableBodyEl.querySelector(`tr[data-id="${id}"]`) ||
      Array.from(tableBodyEl.querySelectorAll("tr[data-id]")).find((tr) => tr.dataset.id === id);
    if (!row) return;
    openEditModal(row);
    const modalEl = document.getElementById("userModal");
    if (modalEl) {
      // Recreate instance if modal element was replaced (e.g. after PJAX navigation)
      const currentEl = bootstrapModal && bootstrapModal._element;
      if (!bootstrapModal || currentEl !== modalEl) {
        bootstrapModal = new bootstrap.Modal(modalEl);
      }
      bootstrapModal.show();
    }
  }

  // Handle click on confirm button inside delete modal
  const confirmBtn = e.target.closest("#delete-user-confirm-btn");
  if (confirmBtn) {
    const typingEl = document.getElementById("delete-user-typing");
    if (!typingEl || typingEl.value.trim() !== "Delete") return;
    performDeleteUser();
  }
});

// Enable/disable delete confirm button and handle Enter key (delegated)
document.addEventListener("input", (e) => {
  const input = e.target;
  if (!input || input.id !== "delete-user-typing") return;
  const deleteUserConfirmBtn = document.getElementById("delete-user-confirm-btn");
  if (deleteUserConfirmBtn) {
    deleteUserConfirmBtn.disabled = input.value.trim() !== "Delete";
  }
});

document.addEventListener("keydown", (e) => {
  const input = e.target;
  if (!input || input.id !== "delete-user-typing") return;
  if (e.key === "Enter") {
    e.preventDefault();
    if (input.value.trim() === "Delete") {
      performDeleteUser();
    }
  }
});

document.addEventListener("hidden.bs.modal", (event) => {
  const target = event.target;
  if (!target || target.id !== "deleteUserModal") return;
  const deleteUserTypingEl = document.getElementById("delete-user-typing");
  const deleteUserConfirmBtn = document.getElementById("delete-user-confirm-btn");
  pendingDeleteUserId = null;
  pendingDeleteUserName = null;
  if (deleteUserTypingEl) deleteUserTypingEl.value = "";
  if (deleteUserConfirmBtn) deleteUserConfirmBtn.disabled = true;
});

// Dynamic change handlers for role + page access radios
document.addEventListener("change", (e) => {
  const target = e.target;
  if (!target) return;
  if (target.id === "user-role") {
    syncPageAccessVisibility();
  }
  if (target.id === "user-page-access-selected" || target.id === "user-page-access-all") {
    syncPageCheckboxesVisibility();
  }
});

// Form submit handler (works even if form is added later)
document.addEventListener("submit", async (e) => {
  const form = e.target;
  if (!(form instanceof HTMLFormElement)) return;
  if (form.id !== "user-form") return;

    e.preventDefault();
    clearAlert();

  const idInputEl = document.getElementById("user-id");
  const nameInputEl = document.getElementById("user-name");
  const usernameInputEl = document.getElementById("user-username");
  const emailInputEl = document.getElementById("user-email");
  const roleInputEl = document.getElementById("user-role");
  const passwordInputEl = document.getElementById("user-password");

  if (!idInputEl || !nameInputEl || !usernameInputEl || !roleInputEl || !passwordInputEl) {
    return;
  }

  const id = idInputEl.value;
  const name = nameInputEl.value.trim();
  const username = usernameInputEl.value.trim();
  const email = emailInputEl ? emailInputEl.value.trim() : "";
  const role = roleInputEl.value;
  const password = passwordInputEl.value;

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

  const modalEl = document.getElementById("userModal");

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

    if (modalEl) {
      const currentEl = bootstrapModal && bootstrapModal._element;
      if (!bootstrapModal || currentEl !== modalEl) {
        bootstrapModal = new bootstrap.Modal(modalEl);
      }
      bootstrapModal.hide();
    }
    showAlert("User saved successfully.", "success");
    loadUsers();
  } catch (err) {
    showAlert(err.message || "Something went wrong.", "danger");
  }
});

// Ensure add/edit modal fields are initialized correctly when the modal is shown
document.addEventListener("show.bs.modal", (event) => {
  const target = event.target;
  if (!target || target.id !== "userModal") return;
  const button = event.relatedTarget;
  if (button && button.id === "add-user-btn") {
    openAddModal();
  } else {
    syncPageAccessVisibility();
    syncPageCheckboxesVisibility();
  }
});

function initUsersPage() {
  if (!document.body || document.body.dataset.page !== "users") return;
  loadUsers();
}

// When landing directly on users.html, remove auth-pending/page-loading so content is visible
if (document.body) {
  document.body.classList.remove("auth-pending");
  document.body.classList.remove("page-loading");
  window.scrollTo(0, 0);
  var m = document.querySelector(".app-main");
  if (m) m.scrollTop = 0;
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
  if (usersInitPollCount++ > 10) {
    clearInterval(usersInitPoll);
    return;
  }
  if (document.body && document.body.dataset.page === "users") {
    clearInterval(usersInitPoll);
    initUsersPage();
  }
}, 200);
