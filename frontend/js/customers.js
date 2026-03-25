/**
 * Customers page: list customers with search and filter functionality
 */
import { API_ORIGIN } from "./config.js";
const CUSTOMERS_API = `${API_ORIGIN}/api/customers`;
const CUSTOMER_REMIND_BALANCE_BULK_API = `${CUSTOMERS_API}/remind-balance-bulk`;

function getToken() {
  return localStorage.getItem("sm_token");
}

function authHeaders() {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

let allCustomers = []; 
let lastRenderedCustomers = []; 
let currentCustomerDetails = null;
const saleDetailsCache = {};
let pendingCustomerSaleConfirm = null;
let pendingCustomerSaleRestore = { saleId: null, verified: false };
let notifyAllPhoneOnly = [];
let notifyAllPhoneOnlyCursor = 0;

const SALES_API = `${API_ORIGIN}/api/sales`;
const ADMIN_VERIFY_API = `${API_ORIGIN}/api/auth/admin/verify-password`;

function normalizePhoneInput(val) {
  const digits = String(val || "").replace(/\\D/g, "");
  if (digits.length === 0) return "";
  let s = digits.slice(0, 11);
  if (s.length >= 1 && s[0] === "9") s = "0" + s.slice(0, 10);
  return s.slice(0, 11);
}

function isPhoneValid(val) {
  return /^09\\d{9}$/.test(String(val || ""));
}

function toWhatsAppPhoneDigitsPhilippines(phone09) {
  const digits = String(phone09 || "").replace(/\\D/g, "");
  if (/^09\\d{9}$/.test(digits)) return `63${digits.slice(1)}`;
  if (/^9\\d{9}$/.test(digits)) return `63${digits}`;
  if (/^63\\d{10}$/.test(digits)) return digits;
  return "";
}

function openExternalUrl(url) {
  if (!url) return;
  try {
    if (window.electronAPI && typeof window.electronAPI.openExternal === "function") {
      window.electronAPI.openExternal(url);
      return;
    }
  } catch {}
  try {
    // In regular browsers, prefer same-tab navigation to avoid popup blockers.
    window.location.assign(url);
  } catch {}
}

function openWhatsAppOnce({ phone09, text }) {
  const phoneLocal = normalizePhoneInput(String(phone09 || ""));
  if (!isPhoneValid(phoneLocal)) return false;
  const digits = toWhatsAppPhoneDigitsPhilippines(phoneLocal);
  if (!digits) return false;
  const msg = String(text || "").trim();
  const protoUrl = `whatsapp://send?phone=${digits}${msg ? `&text=${encodeURIComponent(msg)}` : ""}`;
  const apiUrl = `https://api.whatsapp.com/send?phone=${digits}${msg ? `&text=${encodeURIComponent(msg)}` : ""}`;
  const isElectron = !!(window.electronAPI && typeof window.electronAPI.openExternal === "function");
  openExternalUrl(isElectron ? protoUrl : apiUrl);
  return true;
}

function defaultCustomerReminderText() {
  return (
    `Hi,\n\n` +
    `This is a reminder that you have an outstanding balance with us.\n\n` +
    `If you already paid, please ignore this message.\n\n` +
    `Thank you.`
  );
}

function getTotalBalance(c) {
  const v = c?.total_balance ?? c?.totalBalance ?? 0;
  return Number(v) || 0;
}

function openCustomerNotifyAllModal() {
  const modalEl = document.getElementById("customerNotifyAllModal");
  const alertEl = document.getElementById("customer-notifyall-alert");
  const textEl = document.getElementById("customer-notifyall-text");
  const resultEl = document.getElementById("customer-notifyall-result");
  const sendBtn = document.getElementById("btn-send-notifyall-email");
  const waBtn = document.getElementById("btn-open-notifyall-whatsapp");
  if (!modalEl || !alertEl || !textEl || !resultEl || !sendBtn || !waBtn) return;

  notifyAllPhoneOnly = [];
  notifyAllPhoneOnlyCursor = 0;
  resultEl.classList.add("d-none");
  resultEl.innerHTML = "";
  waBtn.classList.add("d-none");

  const withBalanceCount = (allCustomers || []).filter((c) => getTotalBalance(c) > 0).length;
  alertEl.className = "alert alert-info py-2 small";
  alertEl.textContent =
    withBalanceCount > 0 ? `Customers with balance: ${withBalanceCount}` : "No customers with outstanding balance.";
  alertEl.classList.remove("d-none");

  textEl.value = defaultCustomerReminderText();
  sendBtn.disabled = withBalanceCount <= 0;

  const m = bootstrap.Modal.getOrCreateInstance(modalEl);
  m.show();
}

function isAdmin() {
  const raw = localStorage.getItem("sm_user");
  if (!raw) return false;
  try {
    const user = JSON.parse(raw);
    return !!user && user.role === "admin";
  } catch {
    return false;
  }
}

async function updateCustomerBasicInfo() {
  if (!currentCustomerDetails) return;
  const nameInput = document.getElementById("customer-detail-name");
  const contactInput = document.getElementById("customer-detail-contact");
  const addressInput = document.getElementById("customer-detail-address");
  const msgEl = document.getElementById("customer-detail-save-msg");
  const name = nameInput ? nameInput.value.trim() : "";
  const contact = contactInput ? contactInput.value.trim() : "";
  const address = addressInput ? addressInput.value.trim() : "";
  if (!name) {
    if (msgEl) {
      msgEl.textContent = "Name is required.";
      msgEl.className = "small mt-1 text-danger";
      msgEl.classList.remove("d-none");
    }
    return;
  }
  const id = currentCustomerDetails.customer_id ?? currentCustomerDetails.id;
  const isNewOrSalesOnly = id == null || id === "";
  try {
    const url = isNewOrSalesOnly ? CUSTOMERS_API : `${CUSTOMERS_API}/${id}`;
    const method = isNewOrSalesOnly ? "POST" : "PUT";
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ name, contact, address }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (msgEl) {
        msgEl.textContent = data.message || "Failed to save customer.";
        msgEl.className = "small mt-1 text-danger";
        msgEl.classList.remove("d-none");
      }
      return;
    }
    currentCustomerDetails.name = name;
    currentCustomerDetails.contact = contact;
    currentCustomerDetails.address = address;
    if (data.customer && (data.customer.id != null || data.customer.customer_id != null)) {
      currentCustomerDetails.id = data.customer.id ?? data.customer.customer_id;
      currentCustomerDetails.customer_id = currentCustomerDetails.id;
    }
    if (msgEl) {
      msgEl.textContent = isNewOrSalesOnly ? "Customer saved. Contact and address will show in the list." : "Customer information updated.";
      msgEl.className = "small mt-1 text-success";
      msgEl.classList.remove("d-none");
    }
    loadCustomers({ ...getCustomersParams() });
  } catch (err) {
    if (msgEl) {
      msgEl.textContent = err.message || "Failed to save customer.";
      msgEl.className = "small mt-1 text-danger";
      msgEl.classList.remove("d-none");
    }
  }
}

function flashMessageInCustomerDetailsModal(message, variant) {
  const modal = document.getElementById("customerDetailsModal");
  const body = modal?.querySelector(".modal-body");
  if (!body || !message) return;
  const el = document.createElement("div");
  el.className = `alert alert-${variant === "success" ? "success" : "danger"} py-2 small mb-2 customer-issue-flash`;
  el.setAttribute("role", "status");
  el.textContent = message;
  body.prepend(el);
  setTimeout(() => el.remove(), 8000);
}

/**
 * @returns {Promise<{ ok: boolean; message: string }>}
 */
async function ensureAndResolveIssueForSale(saleId, kind) {
  if (!isAdmin()) {
    return { ok: false, message: "Only admins can update sale issues." };
  }
  const kindSafe = kind === "void" ? "void" : kind === "refund" ? "refund" : "resolved";
  // 1) Load existing issues
  let issueId = null;
  try {
    const res = await fetch(`${SALES_API}/${encodeURIComponent(saleId)}/issues`, {
      headers: authHeaders(),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && Array.isArray(data.issues)) {
      const open = data.issues.find((iss) => iss.status === "open");
      if (open) issueId = open.issue_id;
    }
  } catch {
    // ignore, we'll try to create
  }

  // 2) If no open issue, create one
  if (!issueId) {
    try {
      const body = {
        reason: "payment_issue",
        note: `Auto-created from Customers page to mark sale as ${kindSafe}.`,
      };
      const res = await fetch(`${SALES_API}/${encodeURIComponent(saleId)}/issues`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.issue && data.issue.issue_id != null) {
        issueId = data.issue.issue_id;
      }
    } catch {
      // ignore, best-effort
    }
  }

  if (!issueId) {
    return { ok: false, message: "Could not create or find an issue for this sale." };
  }

  // 3) Resolve the issue with the chosen action
  let status = "resolved";
  if (kindSafe === "void") status = "voided";
  else if (kindSafe === "refund") status = "refunded";

  const note = `Marked as ${kindSafe} from Customers page.`;

  try {
    const res = await fetch(
      `${SALES_API}/${encodeURIComponent(saleId)}/issues/${encodeURIComponent(issueId)}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          resolution_note: note,
          resolution_action: kindSafe,
          status,
        }),
      }
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, message: data.message || "Failed to update sale issue." };
    }
    return { ok: true, message: `Sale #${saleId} marked as ${status}.` };
  } catch (err) {
    return { ok: false, message: err.message || "Failed to update sale issue." };
  }
}

function getCustomersParams(fromBar) {
  const searchEl = document.getElementById("customer-search");
  const filterEl = document.getElementById("customer-filter-balance");
  if (!searchEl && fromBar) {
    const searchInBar = fromBar.querySelector("input[type='text']");
    const filterInBar = fromBar.querySelector("select");
    return {
      q: (searchInBar?.value ?? "").trim(),
      filter: (filterInBar?.value ?? "").trim(),
    };
  }
  const q = (searchEl?.value ?? "").trim();
  const filter = (filterEl?.value ?? "").trim();
  return { q, filter };
}

function loadCustomers(opts = {}) {
  const params = opts.q !== undefined ? opts : getCustomersParams();
  const { q, filter } = params;

  const tbody = document.getElementById("customers-tbody");
  if (!tbody) {
    console.warn("Customers tbody not found, retrying...");
    setTimeout(() => loadCustomers(opts), 100);
    return;
  }

  const token = getToken();
  if (!token) {
    console.warn("No auth token found");
    tbody.innerHTML = '<tr><td colspan="7" class="text-danger small">Authentication required. Please login.</td></tr>';
    return;
  }

  tbody.innerHTML = '<tr><td colspan="7" class="text-muted small">Loading customers…</td></tr>';

  const url = q ? `${CUSTOMERS_API}?q=${encodeURIComponent(q)}` : CUSTOMERS_API;

  fetch(url, { headers: authHeaders() })
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${r.statusText}`);
      return r.json();
    })
    .then((data) => {
      let customers = data.customers || [];
      allCustomers = customers;

      const getBalance = (c) => {
        const v = c.total_balance ?? c.totalBalance ?? 0;
        return Number(v);
      };
      if (filter === "with_balance") {
        customers = customers.filter((c) => getBalance(c) > 0);
      } else if (filter === "no_balance") {
        customers = customers.filter((c) => getBalance(c) <= 0);
      }

      if (customers.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" class="text-muted small">No customers found.</td></tr>';
        return;
      }
      renderCustomers(customers);
    })
    .catch((err) => {
      console.error("Failed to load customers:", err);
      tbody.innerHTML = `<tr><td colspan="7" class="text-danger small">Failed to load customers: ${err.message || "Unknown error"}</td></tr>`;
    });
}

function applyCustomersFilter() {
  loadCustomers({ ...getCustomersParams() });
}

let customerSearchDebounceTimer = null;
function scheduleCustomersFilter() {
  if (customerSearchDebounceTimer) clearTimeout(customerSearchDebounceTimer);
  customerSearchDebounceTimer = setTimeout(() => {
    customerSearchDebounceTimer = null;
    if (document.body?.dataset?.page === "customers" && document.getElementById("customers-tbody")) {
      applyCustomersFilter();
    }
  }, 350);
}

/** Match Sales list / GET sale: void/refund from issues wins, then sales.status. */
function effectiveCustomerTransactionStatus(t) {
  const issueRes = String(t.issue_resolution_status || "").toLowerCase();
  if (issueRes === "voided" || issueRes === "refunded") return issueRes;
  const st = String(t.status || "").toLowerCase();
  if (st === "voided" || st === "refunded") return st;
  return st;
}

/** Customers table Status column: balance first, then any void/refund in history, else Paid. */
function customerListStatusMeta(c) {
  const balanceRounded = Math.round(Number(c.total_balance || 0) * 100) / 100;
  if (balanceRounded > 0) {
    return { label: "With balance", className: "text-danger fw-medium" };
  }
  const txs = c.transactions || [];
  let hasVoid = false;
  let hasRefund = false;
  for (const t of txs) {
    const s = effectiveCustomerTransactionStatus(t);
    if (s === "voided") hasVoid = true;
    if (s === "refunded") hasRefund = true;
  }
  if (hasVoid && hasRefund) {
    return { label: "Void / Refunded", className: "text-secondary fw-medium" };
  }
  if (hasVoid) return { label: "Void", className: "text-secondary fw-medium" };
  if (hasRefund) return { label: "Refunded", className: "text-info fw-medium" };
  return { label: "Paid", className: "text-success" };
}

/** Strikethrough main table row when customer row status is void/refund (not “paid”). */
function customerListRowStrikethrough(meta) {
  const L = meta && meta.label;
  return L === "Void" || L === "Void / Refunded" || L === "Refunded";
}

function buildDetailsHtml(c) {
  const products = (c.products_detail || []);
  const transactions = (c.transactions || []);
  const hasProducts = products.length > 0;
  const hasTransactions = transactions.length > 0;
  let html = '<div class="customer-details-expanded small">';

  // Editable basic info
  html += '<div class="detail-section mb-3">';
  html += '<div class="detail-section-title">Customer information</div>';
  html += '<div class="row g-2 align-items-end">';
  html += '<div class="col-md-4"><label class="form-label small mb-1">Name</label><input type="text" class="form-control form-control-sm" id="customer-detail-name" value="' + escapeHtml(c.name || "") + '"></div>';
  html += '<div class="col-md-4"><label class="form-label small mb-1">Contact</label><input type="text" class="form-control form-control-sm" id="customer-detail-contact" value="' + escapeHtml(c.contact || "") + '"></div>';
  html += '<div class="col-md-4"><label class="form-label small mb-1">Address</label><input type="text" class="form-control form-control-sm" id="customer-detail-address" value="' + escapeHtml(c.address || "") + '"></div>';
  html += '</div>';
  html += '<div class="mt-2 d-flex justify-content-between align-items-center">';
  html += '<small class="text-muted">Changes here will update the Customers list and future sales.</small>';
  html += '<button type="button" class="btn btn-primary btn-sm" id="btn-customer-detail-save"><i class="bi bi-save"></i> Save changes</button>';
  html += '</div>';
  html += '<div id="customer-detail-save-msg" class="small mt-1 text-muted d-none"></div>';
  html += '</div>';

  if (!hasProducts && !hasTransactions) {
    html += '<span class="text-muted small">No purchase history.</span>';
    html += '</div>';
    return html;
  }

  if (hasProducts) {
    html += '<div class="detail-section">';
    html += '<div class="detail-section-title">Products bought (total quantity)</div>';
    html += '<ul class="products-list">';
    products.forEach((p) => {
      html += `<li><span>${escapeHtml(p.product_name)}</span><span class="text-muted">${Number(p.total_quantity)}</span></li>`;
    });
    html += '</ul></div>';
  }

  if (hasTransactions) {
    html += '<div class="detail-section">';
    html += '<div class="detail-section-title">Transaction history (most recent first)</div>';
    transactions.forEach((t) => {
      const dateStr = t.sale_date ? new Date(t.sale_date).toLocaleDateString(undefined, { dateStyle: "short" }) : "—";
      const rawStatus = effectiveCustomerTransactionStatus(t);
      let statusLabel = "—";
      let statusClass = "badge bg-secondary-subtle text-secondary";
      if (rawStatus === "paid") {
        statusLabel = "Paid";
        statusClass = "badge bg-success-subtle text-success";
      } else if (rawStatus === "partial") {
        statusLabel = "Partial";
        statusClass = "badge bg-warning-subtle text-warning";
      } else if (rawStatus === "unpaid") {
        statusLabel = "Unpaid";
        statusClass = "badge bg-danger-subtle text-danger";
      } else if (rawStatus === "voided") {
        statusLabel = "Void";
        statusClass = "badge bg-secondary text-light";
      } else if (rawStatus === "refunded") {
        statusLabel = "Refunded";
        statusClass = "badge bg-info-subtle text-info";
      }
      const showRestore = rawStatus === "voided" || rawStatus === "refunded";
      const restoreIcon = showRestore
        ? `<button type="button" class="btn btn-link btn-sm p-0 ms-2 text-secondary" data-action="customer-sale-restore" data-sale-id="${t.sale_id}" title="Restore status"><i class="bi bi-arrow-counterclockwise"></i></button>`
        : "";
      html += '<div class="transaction-card">';
      html += '<div class="transaction-header">';
      html += `<span class="sale-id">Sale #${escapeHtml(String(t.or_number || t.sale_id))}</span>`;
      html += `<span class="text-muted">${escapeHtml(dateStr)}</span>`;
      html += `<span>Total ₱${Number(t.total_amount || 0).toFixed(2)}</span>`;
      html += `<span>Paid ₱${Number(t.amount_paid || 0).toFixed(2)}</span>`;
      html += `<span class="ms-2" data-sale-status-label="${t.sale_id}"><span class="${statusClass}">${escapeHtml(statusLabel)}</span></span>${restoreIcon}`;
      html += `<span class="ms-2 small text-muted" data-sale-payment-label="${t.sale_id}">Payment: <span class="fw-semibold">—</span></span>`;
      // Issue actions are only shown when the related sale is flagged (has an open issue).
      html += `<div class="ms-auto d-flex gap-1 customer-sale-actions d-none" data-sale-id="${t.sale_id}">`;
      html += `<button type="button" class="btn btn-outline-primary btn-sm" data-action="customer-sale-open" data-sale-id="${t.sale_id}"><i class="bi bi-box-arrow-up-right"></i> Open sale</button>`;
      html += `<button type="button" class="btn btn-outline-secondary btn-sm" data-action="customer-sale-mark" data-kind="resolved" data-sale-id="${t.sale_id}">Mark resolved</button>`;
      html += `<button type="button" class="btn btn-outline-warning btn-sm" data-action="customer-sale-mark" data-kind="refund" data-sale-id="${t.sale_id}">Mark refunded</button>`;
      html += `<button type="button" class="btn btn-outline-danger btn-sm" data-action="customer-sale-mark" data-kind="void" data-sale-id="${t.sale_id}">Mark void</button>`;
      html += '</div>';
      html += '</div>';
      if ((t.items || []).length > 0) {
        html += '<table class="transaction-items"><tbody>';
        t.items.forEach((i) => {
          html += `<tr><th>${escapeHtml(i.product_name)}</th><td class="text-end">qty ${i.quantity} × ₱${Number(i.price || 0).toFixed(2)} = ₱${Number(i.subtotal || 0).toFixed(2)}</td></tr>`;
        });
        html += '</tbody></table>';
      }
      html += '</div>';
    });
    html += '</div>';
  }
  html += '</div>';
  return html;
}

async function updateCustomerSaleIssueButtons(container) {
  const root = container || document;
  const groups = Array.from(root.querySelectorAll(".customer-sale-actions[data-sale-id]"));
  if (!groups.length) return;

  for (const group of groups) {
    const saleId = group.getAttribute("data-sale-id");
    if (!saleId) continue;
    try {
      const res = await fetch(`${SALES_API}/${encodeURIComponent(saleId)}`, {
        headers: authHeaders(),
      });
      const data = await res.json().catch(() => ({}));
      const sale = data.sale || {};
      saleDetailsCache[saleId] = sale;
      const hasOpenIssue = res.ok && sale.has_open_issue;
      if (hasOpenIssue) {
        group.classList.remove("d-none");
      } else {
        group.classList.add("d-none");
      }

      const statusEl = root.querySelector(`[data-sale-status-label="${saleId}"]`);
      const raw = effectiveCustomerTransactionStatus({
        issue_resolution_status: sale.issue_resolution_status,
        status: sale.status,
      });
      if (statusEl && raw) {
        let label = raw;
        let cls = "badge bg-secondary-subtle text-secondary";
        if (raw === "paid") {
          label = "Paid";
          cls = "badge bg-success-subtle text-success";
        } else if (raw === "partial") {
          label = "Partial";
          cls = "badge bg-warning-subtle text-warning";
        } else if (raw === "unpaid") {
          label = "Unpaid";
          cls = "badge bg-danger-subtle text-danger";
        } else if (raw === "voided") {
          label = "Void";
          cls = "badge bg-secondary text-light";
        } else if (raw === "refunded") {
          label = "Refunded";
          cls = "badge bg-info-subtle text-info";
        }
        statusEl.innerHTML = `<span class="${cls}">${escapeHtml(label)}</span>`;
      }

      const paymentWrap = root.querySelector(`[data-sale-payment-label="${saleId}"]`);
      if (paymentWrap) {
        const inner = paymentWrap.querySelector("span.fw-semibold") || paymentWrap;
        let pm = sale.payment_method || "";
        let pmLabel;
        const pmLower = String(pm).toLowerCase();
        if (pmLower === "cash") pmLabel = "Cash";
        else if (pmLower === "gcash") pmLabel = "GCash";
        else if (pmLower === "paymaya") pmLabel = "PayMaya";
        else if (pmLower === "credit") pmLabel = "Credit";
        else pmLabel = pm || "—";
        inner.textContent = pmLabel;
      }
    } catch {
      // On error, keep actions hidden.
      group.classList.add("d-none");
    }
  }
}

function openCustomerSaleConfirmModal(saleId, kind) {
  const modalEl = document.getElementById("customerSaleConfirmModal");
  if (!modalEl) return;
  const actionLabelEl = document.getElementById("customer-sale-confirm-action-label");
  const saleLabelEl = document.getElementById("customer-sale-confirm-sale-label");
  const paymentEl = document.getElementById("customer-sale-confirm-payment");
  let actionLabel = "update this sale";
  if (kind === "resolved") actionLabel = "mark this issue as resolved";
  else if (kind === "refund") actionLabel = "mark this issue as refunded";
  else if (kind === "void") actionLabel = "mark this issue as void";
  if (actionLabelEl) actionLabelEl.textContent = actionLabel;
  if (saleLabelEl) saleLabelEl.textContent = `Sale #${saleId}`;
  const cached = saleDetailsCache[saleId];
  if (paymentEl) {
    let pmLabel = "—";
    if (cached && cached.payment_method) {
      const pmLower = String(cached.payment_method).toLowerCase();
      if (pmLower === "cash") pmLabel = "Cash";
      else if (pmLower === "gcash") pmLabel = "GCash";
      else if (pmLower === "paymaya") pmLabel = "PayMaya";
      else if (pmLower === "credit") pmLabel = "Credit";
      else pmLabel = cached.payment_method;
    }
    paymentEl.textContent = pmLabel;
  }
  pendingCustomerSaleConfirm = { saleId, kind };
  const m = bootstrap.Modal.getOrCreateInstance(modalEl, { backdrop: true, keyboard: true });
  m.show();
}

function renderCustomers(customers) {
  const tbody = document.getElementById("customers-tbody");
  if (!tbody) return;
  lastRenderedCustomers = customers;

  const balance = (c) => Number(c.total_balance || 0);
  const balanceRounded = (c) => Math.round(balance(c) * 100) / 100;
  const hasBalance = (c) => balanceRounded(c) > 0;

  tbody.innerHTML = customers
    .map(
      (c, i) => {
        const summary = c.products_bought || "—";
        const hasDetails = ((c.products_detail && c.products_detail.length) || (c.transactions && c.transactions.length));
        const rowClass = hasBalance(c) ? " customer-with-balance" : "";
        const listStatus = customerListStatusMeta(c);
        const strike = customerListRowStrikethrough(listStatus);
        const tdCls = (extra) => {
          const parts = [extra, strike ? "text-decoration-line-through" : null].filter(Boolean);
          return parts.length ? ` class="${parts.join(" ")}"` : "";
        };
        const bal = balance(c);
        const firstUnpaid = (c.transactions || []).find((t) => Number(t.remaining_balance || 0) > 0);
        const saleId = firstUnpaid ? firstUnpaid.sale_id : "";
        const saleBalance = firstUnpaid ? Number(firstUnpaid.remaining_balance || 0) : bal;
        const payParams = new URLSearchParams({ pay: "1", customerId: String(c.customer_id || c.id || ""), customerName: (c.name || "").trim(), balance: String(saleBalance) });
        if (saleId) payParams.set("saleId", String(saleId));
        const detailsBtn = hasDetails
          ? `<button type="button" class="btn btn-outline-secondary btn-sm" data-action="view-customer-details" data-index="${i}"><i class="bi bi-eye"></i> Details</button>`
          : "";
        const payBtn = hasBalance(c)
          ? `<a href="./payments.html?${payParams.toString()}" class="btn btn-danger btn-sm" data-action="pay-customer" title="Record payment">Pay</a>`
          : "";
        const actions =
          detailsBtn || payBtn
            ? `<div class="d-inline-flex gap-1 justify-content-end">${detailsBtn}${payBtn}</div>`
            : "";
        return `<tr data-customer-row data-index="${i}" class="${rowClass}">
          <td${tdCls()}>${escapeHtml(c.name || "—")}</td>
          <td${tdCls()}>${escapeHtml(c.contact || "—")}</td>
          <td${tdCls()}>${escapeHtml(c.address || "—")}</td>
          <td${tdCls("small")}>${escapeHtml(summary)}</td>
          <td${tdCls()}>₱${balanceRounded(c).toFixed(2)}</td>
          <td${tdCls()}><span class="${listStatus.className}">${escapeHtml(listStatus.label)}</span></td>
          <td class="text-end">${actions}</td>
        </tr>`;
      }
    )
    .join("");
}

document.addEventListener("input", (e) => {
  if (e.target.id === "customer-search") {
    scheduleCustomersFilter();
  }
});

document.addEventListener("change", (e) => {
  if (e.target.id === "customer-filter-balance") {
    applyCustomersFilter();
  }
});

document.addEventListener("click", async (e) => {
  const notifyAllBtn = e.target.closest("#btn-notify-balance-all");
  if (notifyAllBtn) {
    e.preventDefault();
    openCustomerNotifyAllModal();
    return;
  }
  const applyBtn = e.target.closest("#btn-customer-search");
  if (applyBtn) {
    loadCustomers({ ...getCustomersParams() });
    return;
  }
  const detailsBtn = e.target.closest("[data-action='view-customer-details']");
  if (detailsBtn) {
    e.preventDefault();
    const index = detailsBtn.getAttribute("data-index");
    if (index == null) return;
    const idx = parseInt(index, 10);
    const customer = lastRenderedCustomers[idx];
    if (!customer) return;
    currentCustomerDetails = customer;
    const modalEl = document.getElementById("customerDetailsModal");
    const bodyEl = modalEl?.querySelector(".modal-body");
    const titleEl = document.getElementById("customerDetailsModalLabel");
    if (!modalEl || !bodyEl || !titleEl) return;
    titleEl.textContent = customer.name || "Customer details";
    bodyEl.innerHTML = buildDetailsHtml(customer);
    updateCustomerSaleIssueButtons(bodyEl);
    const m = bootstrap.Modal.getOrCreateInstance(modalEl);
    m.show();
    return;
  }
  const saveBtn = e.target.closest("#btn-customer-detail-save");
  if (saveBtn) {
    e.preventDefault();
    updateCustomerBasicInfo();
    return;
  }
  const restoreIconBtn = e.target.closest("[data-action='customer-sale-restore']");
  if (restoreIconBtn) {
    e.preventDefault();
    const saleId = restoreIconBtn.getAttribute("data-sale-id");
    if (!saleId) return;
    pendingCustomerSaleRestore = { saleId, verified: false };

    const modalEl = document.getElementById("customerSaleRestoreModal");
    const passEl = document.getElementById("customer-sale-restore-password");
    const alertEl = document.getElementById("customer-sale-restore-alert");
    const saleLabelEl = document.getElementById("customer-sale-restore-sale-label");
    const verifyBtn = document.getElementById("customer-sale-restore-verify");
    const paidBtn = document.getElementById("customer-sale-restore-paid");
    const unpaidBtn = document.getElementById("customer-sale-restore-unpaid");

    if (modalEl) {
      if (passEl) passEl.value = "";
      if (alertEl) {
        alertEl.classList.add("d-none");
        alertEl.textContent = "";
      }
      if (saleLabelEl) saleLabelEl.textContent = `Sale #${saleId}`;
      if (verifyBtn) verifyBtn.classList.remove("d-none");
      if (paidBtn) paidBtn.classList.add("d-none");
      if (unpaidBtn) unpaidBtn.classList.add("d-none");

      const m = bootstrap.Modal.getOrCreateInstance(modalEl, { backdrop: true, keyboard: true });
      m.show();
    }
    return;
  }
  const verifyRestoreBtn = e.target.closest("#customer-sale-restore-verify");
  if (verifyRestoreBtn && pendingCustomerSaleRestore?.saleId) {
    e.preventDefault();
    const modalEl = document.getElementById("customerSaleRestoreModal");
    const passEl = document.getElementById("customer-sale-restore-password");
    const alertEl = document.getElementById("customer-sale-restore-alert");
    const paidBtn = document.getElementById("customer-sale-restore-paid");
    const unpaidBtn = document.getElementById("customer-sale-restore-unpaid");
    const verifyBtn = document.getElementById("customer-sale-restore-verify");
    const saleId = pendingCustomerSaleRestore.saleId;
    if (!modalEl || !passEl) return;

    const adminPassword = passEl.value;
    try {
      const r = await fetch(ADMIN_VERIFY_API, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ admin_password: adminPassword }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.message || "Invalid admin password.");

      pendingCustomerSaleRestore.verified = true;
      if (alertEl) {
        alertEl.className = "alert alert-success py-2 small d-none";
        alertEl.textContent = "";
      }
      if (verifyBtn) verifyBtn.classList.add("d-none");
      if (paidBtn) paidBtn.classList.remove("d-none");
      if (unpaidBtn) unpaidBtn.classList.remove("d-none");
    } catch (err) {
      if (alertEl) {
        alertEl.className = "alert alert-danger py-2 small";
        alertEl.textContent = err.message || "Failed to verify password.";
        alertEl.classList.remove("d-none");
      }
    }
    return;
  }
  const restorePaidBtn = e.target.closest("#customer-sale-restore-paid");
  const restoreUnpaidBtn = e.target.closest("#customer-sale-restore-unpaid");
  if ((restorePaidBtn || restoreUnpaidBtn) && pendingCustomerSaleRestore?.saleId) {
    e.preventDefault();
    const saleId = pendingCustomerSaleRestore.saleId;
    if (!pendingCustomerSaleRestore.verified) {
      const alertEl = document.getElementById("customer-sale-restore-alert");
      if (alertEl) {
        alertEl.className = "alert alert-danger py-2 small";
        alertEl.textContent = "Verify admin password first.";
        alertEl.classList.remove("d-none");
      }
      return;
    }
    const passEl = document.getElementById("customer-sale-restore-password");
    const alertEl = document.getElementById("customer-sale-restore-alert");
    if (!passEl) return;
    const adminPassword = passEl.value;
    const desiredStatus = restorePaidBtn ? "paid" : "unpaid";
    try {
      const r = await fetch(`${SALES_API}/${encodeURIComponent(saleId)}/restore-status`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ status: desiredStatus, admin_password: adminPassword }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.message || "Failed to restore sale.");

      // Update modal details for the sale if currently open, without wiping the edit form.
      if (currentCustomerDetails && Array.isArray(currentCustomerDetails.transactions)) {
        try {
          // Preserve any unsaved edits currently typed into the modal inputs.
          const nameInput = document.getElementById("customer-detail-name");
          const contactInput = document.getElementById("customer-detail-contact");
          const addressInput = document.getElementById("customer-detail-address");
          if (nameInput) currentCustomerDetails.name = nameInput.value;
          if (contactInput) currentCustomerDetails.contact = contactInput.value;
          if (addressInput) currentCustomerDetails.address = addressInput.value;

          const tx = currentCustomerDetails.transactions.find((t) => String(t.sale_id) === String(saleId));
          if (tx) {
            const total = Number(tx.total_amount || 0);
            tx.status = desiredStatus;
            // Once restored to paid/unpaid, it should no longer be considered void/refunded.
            tx.issue_resolution_status = null;
            tx.amount_paid = desiredStatus === "paid" ? total : 0;
            tx.remaining_balance = desiredStatus === "paid" ? 0 : total;
          }

          const modalEl = document.getElementById("customerDetailsModal");
          const bodyEl = modalEl?.querySelector(".modal-body");
          if (modalEl && bodyEl) {
            bodyEl.innerHTML = buildDetailsHtml(currentCustomerDetails);
            updateCustomerSaleIssueButtons(bodyEl);
          }
        } catch (_) {}
      }

      // Close restore modal.
      const modalEl = document.getElementById("customerSaleRestoreModal");
      if (modalEl) {
        const m = bootstrap.Modal.getInstance(modalEl);
        if (m) m.hide();
      }
      pendingCustomerSaleRestore = { saleId: null, verified: false };
      // Also refresh the list so totals/status stay correct.
      loadCustomers({ ...getCustomersParams() });
    } catch (err) {
      if (alertEl) {
        alertEl.className = "alert alert-danger py-2 small";
        alertEl.textContent = err.message || "Failed to restore sale.";
        alertEl.classList.remove("d-none");
      }
    }
    return;
  }
  const saleActionBtn = e.target.closest("[data-action='customer-sale-mark']");
  if (saleActionBtn) {
    e.preventDefault();
    const saleId = saleActionBtn.getAttribute("data-sale-id");
    const kind = saleActionBtn.getAttribute("data-kind") || "resolved";
    if (saleId) openCustomerSaleConfirmModal(saleId, kind);
    return;
  }
  const confirmBtn = e.target.closest("#btn-customer-sale-confirm");
  if (confirmBtn) {
    e.preventDefault();
    if (pendingCustomerSaleConfirm && pendingCustomerSaleConfirm.saleId) {
      const { saleId, kind } = pendingCustomerSaleConfirm;
      pendingCustomerSaleConfirm = null;
      const confirmModalEl = document.getElementById("customerSaleConfirmModal");
      if (confirmModalEl) {
        const cm = bootstrap.Modal.getInstance(confirmModalEl);
        if (cm) cm.hide();
      }
      void (async () => {
        const result = await ensureAndResolveIssueForSale(saleId, kind);
        const detailsModal = document.getElementById("customerDetailsModal");
        const bodyEl = detailsModal?.querySelector(".modal-body");
        if (result.ok) {
          delete saleDetailsCache[saleId];
          if (bodyEl) await updateCustomerSaleIssueButtons(bodyEl);
          loadCustomers({ ...getCustomersParams() });
          flashMessageInCustomerDetailsModal(result.message, "success");
        } else {
          flashMessageInCustomerDetailsModal(result.message, "danger");
        }
      })();
    }
    return;
  }
  const openSaleBtn = e.target.closest("[data-action='customer-sale-open']");
  if (openSaleBtn) {
    e.preventDefault();
    const saleId = openSaleBtn.getAttribute("data-sale-id");
    if (saleId) {
      const params = new URLSearchParams({ saleId: String(saleId), focusIssue: "1" });
      window.location.href = `./sales.html?${params.toString()}`;
    }
    return;
  }

  const sendAllBtn = e.target.closest("[data-action='send-notifyall-email']");
  if (sendAllBtn) {
    const modalEl = document.getElementById("customerNotifyAllModal");
    const alertEl = document.getElementById("customer-notifyall-alert");
    const textEl = document.getElementById("customer-notifyall-text");
    const resultEl = document.getElementById("customer-notifyall-result");
    const waBtn = document.getElementById("btn-open-notifyall-whatsapp");
    if (!modalEl || !alertEl || !textEl || !resultEl || !waBtn) return;
    if (sendAllBtn.disabled) return;

    sendAllBtn.disabled = true;
    waBtn.classList.add("d-none");
    alertEl.className = "alert alert-info py-2 small";
    alertEl.textContent = "Sending emails…";
    alertEl.classList.remove("d-none");

    const subject = "Outstanding Balance Reminder";
    const text = textEl.value.trim();

    fetch(CUSTOMER_REMIND_BALANCE_BULK_API, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ subject, text }),
    })
      .then(async (r) => {
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.message || `HTTP ${r.status}`);
        return data;
      })
      .then((data) => {
        const sent = Number(data?.sent || 0);
        const skipped = Number(data?.skipped || 0);
        const phoneOnly = Array.isArray(data?.phoneOnly) ? data.phoneOnly : [];
        const noContact = Array.isArray(data?.noContact) ? data.noContact : [];
        notifyAllPhoneOnly = phoneOnly;

        alertEl.className = "alert alert-success py-2 small";
        alertEl.textContent = data?.message || `Sent ${sent} email(s).`;
        alertEl.classList.remove("d-none");

        resultEl.classList.remove("d-none");
        resultEl.innerHTML =
          `<div class="border rounded p-2 bg-light small">` +
          `<div><strong>Sent:</strong> ${sent}</div>` +
          `<div><strong>Skipped:</strong> ${skipped}</div>` +
          `<div class="text-muted mt-1">Phone-only: ${phoneOnly.length} · No contact: ${noContact.length}</div>` +
          `</div>`;

        if (phoneOnly.length > 0) {
          waBtn.classList.remove("d-none");
        }
      })
      .catch((err) => {
        alertEl.className = "alert alert-warning py-2 small";
        alertEl.textContent = err.message || "Failed to send emails.";
        alertEl.classList.remove("d-none");
      })
      .finally(() => {
        sendAllBtn.disabled = false;
      });
    return;
  }

  const waAllBtn = e.target.closest("[data-action='open-notifyall-whatsapp']");
  if (waAllBtn) {
    const modalEl = document.getElementById("customerNotifyAllModal");
    const alertEl = document.getElementById("customer-notifyall-alert");
    const textEl = document.getElementById("customer-notifyall-text");
    if (!modalEl || !alertEl || !textEl) return;
    if (!Array.isArray(notifyAllPhoneOnly) || notifyAllPhoneOnly.length === 0) return;

    const msg = textEl.value.trim();
    while (notifyAllPhoneOnlyCursor < notifyAllPhoneOnly.length) {
      const item = notifyAllPhoneOnly[notifyAllPhoneOnlyCursor];
      notifyAllPhoneOnlyCursor += 1;
      const ok = openWhatsAppOnce({ phone09: item?.contact || "", text: msg });
      if (ok) break;
    }

    const remaining = Math.max(0, notifyAllPhoneOnly.length - notifyAllPhoneOnlyCursor);
    alertEl.className = "alert alert-info py-2 small";
    alertEl.textContent =
      remaining > 0
        ? `Opened WhatsApp (${notifyAllPhoneOnlyCursor}/${notifyAllPhoneOnly.length}). Click again to open next (${remaining} remaining).`
        : `Opened WhatsApp for all phone-only customers (${notifyAllPhoneOnly.length}).`;
    alertEl.classList.remove("d-none");

    if (remaining <= 0) {
      waAllBtn.classList.add("d-none");
    }
    return;
  }
});

document.addEventListener("keydown", (e) => {
  if (e.target.id === "customer-search" && e.key === "Enter") {
    e.preventDefault();
    if (customerSearchDebounceTimer) clearTimeout(customerSearchDebounceTimer);
    customerSearchDebounceTimer = null;
    applyCustomersFilter();
  }
});


function checkAndLoadIfCustomersPage() {
  const tbody = document.getElementById("customers-tbody");
  if (tbody && document.body?.dataset.page === "customers") {
    loadCustomers();
  }
}


if (document.readyState !== "loading") {
  setTimeout(checkAndLoadIfCustomersPage, 100);
}


window.addEventListener("DOMContentLoaded", () => {
  checkAndLoadIfCustomersPage();
});


window.addEventListener("pjax:complete", (e) => {
  if (e.detail && e.detail.page === "customers") {
    setTimeout(() => {
      loadCustomers();
    }, 100);
  }
});

function setupCustomersPageObserver() {
  if (!document.body) {
    setTimeout(setupCustomersPageObserver, 50);
    return;
  }
  
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === "attributes" && mutation.attributeName === "data-page") {
        if (document.body.dataset.page === "customers") {
          setTimeout(() => {
            loadCustomers();
          }, 100);
        }
        break;
      }
    }
  });
  
  observer.observe(document.body, {
    attributes: true,
    attributeFilter: ["data-page"]
  });
}


if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", setupCustomersPageObserver);
} else {
  setupCustomersPageObserver();
}
