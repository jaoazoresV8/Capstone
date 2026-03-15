/**
 * Customers page: list customers with search and filter functionality
 */
import { API_ORIGIN } from "./config.js";
const CUSTOMERS_API = `${API_ORIGIN}/api/customers`;

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

const SALES_API = `${API_ORIGIN}/api/sales`;

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

async function ensureAndResolveIssueForSale(saleId, kind) {
  if (!isAdmin()) return;
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
    alert("Could not create or find an issue for this sale.");
    return;
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
      alert(data.message || "Failed to update sale issue.");
      return;
    }
    alert(`Sale #${saleId} marked as ${status}.`);
  } catch (err) {
    alert(err.message || "Failed to update sale issue.");
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
      const rawStatus = (t.status || "").toLowerCase();
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
      html += '<div class="transaction-card">';
      html += '<div class="transaction-header">';
      html += `<span class="sale-id">Sale #${escapeHtml(String(t.sale_id))}</span>`;
      html += `<span class="text-muted">${escapeHtml(dateStr)}</span>`;
      html += `<span>Total ₱${Number(t.total_amount || 0).toFixed(2)}</span>`;
      html += `<span>Paid ₱${Number(t.amount_paid || 0).toFixed(2)}</span>`;
      html += `<span class="ms-2" data-sale-status-label="${t.sale_id}"><span class="${statusClass}">${escapeHtml(statusLabel)}</span></span>`;
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
      if (statusEl && sale.status) {
        const raw = String(sale.status).toLowerCase();
        let label = sale.status;
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
  const m = new bootstrap.Modal(modalEl);
  m.show();
}

function renderCustomers(customers) {
  const tbody = document.getElementById("customers-tbody");
  if (!tbody) return;
  lastRenderedCustomers = customers;

  const balance = (c) => Number(c.total_balance || 0);
  const balanceRounded = (c) => Math.round(balance(c) * 100) / 100;
  const hasBalance = (c) => balanceRounded(c) > 0;
  const statusText = (c) => (hasBalance(c) ? "With balance" : "Paid");
  const statusClass = (c) => (hasBalance(c) ? "text-danger fw-medium" : "text-success");

  tbody.innerHTML = customers
    .map(
      (c, i) => {
        const summary = c.products_bought || "—";
        const hasDetails = ((c.products_detail && c.products_detail.length) || (c.transactions && c.transactions.length));
        const rowClass = hasBalance(c) ? " customer-with-balance" : "";
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
          <td>${escapeHtml(c.name || "—")}</td>
          <td>${escapeHtml(c.contact || "—")}</td>
          <td>${escapeHtml(c.address || "—")}</td>
          <td class="small">${escapeHtml(summary)}</td>
          <td>₱${balanceRounded(c).toFixed(2)}</td>
          <td><span class="${statusClass(c)}">${escapeHtml(statusText(c))}</span></td>
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

document.addEventListener("click", (e) => {
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
    const bodyEl = document.getElementById("customer-details-body");
    const titleEl = document.getElementById("customerDetailsModalLabel");
    if (!modalEl || !bodyEl || !titleEl) return;
    titleEl.textContent = customer.name || "Customer details";
    bodyEl.innerHTML = buildDetailsHtml(customer);
    updateCustomerSaleIssueButtons(bodyEl);
    const m = new bootstrap.Modal(modalEl);
    m.show();
    return;
  }
  const saveBtn = e.target.closest("#btn-customer-detail-save");
  if (saveBtn) {
    e.preventDefault();
    updateCustomerBasicInfo();
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
      ensureAndResolveIssueForSale(saleId, kind);
      const modalEl = document.getElementById("customerSaleConfirmModal");
      if (modalEl) {
        const m = bootstrap.Modal.getInstance(modalEl);
        if (m) m.hide();
      }
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
