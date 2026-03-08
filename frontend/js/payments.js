
import { API_ORIGIN } from "./config.js";
import { enqueueSyncOperation, getSaleUuidForLocalId } from "./sync-queue.js";
const PAYMENTS_API = `${API_ORIGIN}/api/sales/payments`;
const SALES_API = `${API_ORIGIN}/api/sales`;

function authHeaders() {
  const token = localStorage.getItem("sm_token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function escapeHtml(s) {
  if (s == null || s === "") return "";
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

function formatDate(dateStr) {
  if (!dateStr) return "—";
  return dateStr.replace("T", " ").slice(0, 19);
}

function formatDateShort(dateStr) {
  if (!dateStr) return "—";
  const s = dateStr.replace("T", " ").slice(0, 16);
  return s.replace(" ", " · ");
}

/** Build HTML for expanded payment history of one sale (method, date, amount, reference). */
function buildSalePaymentDetailsHtml(saleId) {
  const list = (allPayments || []).filter((p) => p.sale_id === saleId).sort((a, b) => new Date(a.payment_date || 0) - new Date(b.payment_date || 0));
  if (list.length === 0) return "<span class=\"text-muted small\">No payments.</span>";
  let html = '<div class="small">';
  html += '<div class="detail-section-title mb-2">Payment history</div>';
  list.forEach((p, i) => {
    const mode = getModeLabel(p.payment_method, p.reference_number);
    const refDisplay = getRefDisplay(p.payment_method, p.reference_number);
    const refClass = mode === "GCash" ? "payments-ref-gcash" : mode === "PayMaya" ? "payments-ref-paymaya" : mode === "Cash" ? "payments-ref-cash" : "";
    html += '<div class="d-flex flex-wrap align-items-center gap-2 py-1 border-bottom border-light">';
    html += '<span class="text-muted">' + escapeHtml(formatDateShort(p.payment_date)) + '</span>';
    html += '<span class="fw-medium">' + escapeHtml(mode) + '</span>';
    html += '<span>₱' + Number(p.amount_paid || 0).toFixed(2) + '</span>';
    if (refDisplay !== "—") html += '<span class="' + refClass + ' px-1">' + escapeHtml(refDisplay) + '</span>';
    html += '</div>';
  });
  html += '</div>';
  return html;
}

/** Mode label from payment_method (cash/gcash/paymaya). Falls back to reference_number for old rows. */
function getModeLabel(paymentMethod, referenceNumber) {
  const method = (paymentMethod != null && String(paymentMethod).trim()) ? String(paymentMethod).trim().toLowerCase() : "";
  if (method === "cash") return "Cash";
  if (method === "gcash") return "GCash";
  if (method === "paymaya") return "PayMaya";
  const ref = (referenceNumber != null && String(referenceNumber).trim()) ? String(referenceNumber).trim().toLowerCase() : "";
  if (ref === "cash") return "Cash";
  if (ref === "gcash") return "GCash";
  if (ref === "paymaya") return "PayMaya";
  return "E-wallet";
}

/** Reference column: "—" for cash, otherwise the reference number. */
function getRefDisplay(paymentMethod, referenceNumber) {
  const method = (paymentMethod != null && String(paymentMethod).trim()) ? String(paymentMethod).trim().toLowerCase() : "";
  if (method === "cash") return "—";
  const ref = (referenceNumber != null && String(referenceNumber).trim()) ? String(referenceNumber).trim() : "";
  if (ref === "cash" || ref === "gcash" || ref === "paymaya") return "—";
  return ref || "—";
}

let allPayments = [];

function renderPaymentsRows(payments) {
  const tbody = document.getElementById("payments-tbody");
  if (!tbody) return;
  if (!payments || payments.length === 0) {
    tbody.innerHTML = "<tr id=\"payments-empty-row\"><td colspan=\"6\" class=\"text-muted small\">No payment records found.</td></tr>";
    return;
  }
  const bySale = {};
  payments.forEach((p) => {
    const sid = p.sale_id;
    if (!bySale[sid]) bySale[sid] = [];
    bySale[sid].push(p);
  });
  const saleIds = Object.keys(bySale).map(Number).sort((a, b) => b - a);
  saleIds.forEach((sid) => {
    bySale[sid].sort((a, b) => new Date(a.payment_date || 0) - new Date(b.payment_date || 0));
  });
  let html = "";
  saleIds.forEach((saleId) => {
    const list = bySale[saleId];
    const totalPaid = list.reduce((sum, p) => sum + Number(p.amount_paid || 0), 0);
    const last = list[list.length - 1];
    const lastMode = last ? getModeLabel(last.payment_method, last.reference_number) : "—";
    const lastDate = last && last.payment_date ? formatDate(last.payment_date) : "—";
    const count = list.length;
    const viewDetailsBtn = "<button type=\"button\" class=\"btn btn-outline-secondary btn-sm\" data-action=\"open-payment-details\" data-sale-id=\"" + saleId + "\"><i class=\"bi bi-receipt-cutoff me-1\" aria-hidden=\"true\"></i>Details</button>";
    html += "<tr data-payment-row data-sale-id=\"" + saleId + "\">";
    html += "<td>" + escapeHtml(String(saleId)) + "</td>";
    html += "<td class=\"small\">" + count + " payment" + (count !== 1 ? "s" : "") + "</td>";
    html += "<td class=\"text-end text-nowrap payments-amount-col\">₱" + totalPaid.toFixed(2) + "</td>";
    html += "<td class=\"payments-date-col\">" + escapeHtml(lastDate) + "</td>";
    html += "<td>" + escapeHtml(lastMode) + "</td>";
    html += "<td class=\"text-end\">" + viewDetailsBtn + "</td>";
    html += "</tr>";
  });
  tbody.innerHTML = html;

  // If the Payments page is using card/kanban view, notify the generic
  // view-toggle helper so it can rebuild the currently active layout
  // from the updated table rows (search/filter results).
  try {
    const section = document.querySelector('.data-view-section[data-view-id="payments"]');
    if (section && typeof CustomEvent === "function") {
      section.dispatchEvent(new CustomEvent("data-view:refresh"));
    }
  } catch (_) {
    // Ignore; table view will still render correctly.
  }
}

function filterPayments(query, modeFilter) {
  const searchTerm = (query || "").trim().toLowerCase();
  const mode = (modeFilter || "").trim().toLowerCase();
  let filtered = allPayments;
  if (searchTerm) {
    filtered = filtered.filter((p) => {
      const paymentId = String(p.payment_id || "");
      const saleId = String(p.sale_id || "");
      const ref = (p.reference_number || "").toLowerCase();
      const method = (p.payment_method || "").toLowerCase();
      return paymentId.toLowerCase().includes(searchTerm) ||
        saleId.toLowerCase().includes(searchTerm) ||
        ref.includes(searchTerm) ||
        method.includes(searchTerm);
    });
  }
  if (mode) {
    filtered = filtered.filter((p) => {
      const m = getModeLabel(p.payment_method, p.reference_number).toLowerCase();
      return m === mode || m.replace(/\s/g, "") === mode;
    });
  }
  renderPaymentsRows(filtered);
}

function applyPaymentsFilter() {
  const searchInput = document.getElementById("payments-search");
  const modeSelect = document.getElementById("payments-filter-mode");
  const query = searchInput ? searchInput.value.trim() : "";
  const mode = modeSelect ? (modeSelect.value || "").trim() : "";
  filterPayments(query, mode);
}

function loadPayments() {
  const tbody = document.getElementById("payments-tbody");
  const emptyRow = document.getElementById("payments-empty-row");
  if (!tbody) return;

  tbody.innerHTML = emptyRow ? emptyRow.outerHTML : "<tr><td colspan=\"6\" class=\"text-muted small\">Loading…</td></tr>";

  fetch(PAYMENTS_API, { headers: authHeaders() })
    .then((r) => {
      if (!r.ok) throw new Error("Failed to load payments");
      return r.json();
    })
    .then((data) => {
      allPayments = data.payments || [];
      applyPaymentsFilter();
    })
    .catch(() => {
      tbody.innerHTML = "<tr><td colspan=\"6\" class=\"text-danger small\">Failed to load payments.</td></tr>";
    });
}

let paymentsSearchTimeout = null;

document.addEventListener("input", function (e) {
  if (e.target.id === "payments-search") {
    if (paymentsSearchTimeout) clearTimeout(paymentsSearchTimeout);
    paymentsSearchTimeout = setTimeout(applyPaymentsFilter, 300);
  }
});

document.addEventListener("click", function (e) {
  const detailsBtn = e.target.closest("[data-action='open-payment-details'][data-sale-id]");
  if (detailsBtn) {
    e.preventDefault();
    const saleId = Number(detailsBtn.getAttribute("data-sale-id") || "0");
    if (!saleId) return;
    const modalEl = document.getElementById("paymentDetailsModal");
    const bodyEl = document.getElementById("payment-details-body");
    const titleEl = document.getElementById("paymentDetailsModalLabel");
    if (!modalEl || !bodyEl || !titleEl) return;

    titleEl.textContent = "Payment details for Sale #" + saleId;
    bodyEl.innerHTML = buildSalePaymentDetailsHtml(saleId);

    const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
    modal.show();
    return;
  }
  if (e.target.closest("#btn-payments-search")) {
    applyPaymentsFilter();
  }
});

document.addEventListener("change", function (e) {
  if (e.target.id === "payments-filter-mode") {
    applyPaymentsFilter();
  }
});

document.addEventListener("DOMContentLoaded", function () {
  loadPayments();
  openRecordPaymentModalFromParams();
});

// Load when navigating to payments via pjax (same as sales/products)
window.addEventListener("pjax:complete", function (e) {
  if (e.detail && e.detail.page === "payments") {
    loadPayments();
    openRecordPaymentModalFromParams();
  }
});

// When script is injected after pjax swap, DOMContentLoaded already fired; run load if we're on payments page
if (document.body && document.body.dataset.page === "payments" && document.getElementById("payments-tbody")) {
  loadPayments();
  // Open Record Payment modal when URL has pay=1 (from Customers Pay); delay so URL is updated after pjax pushState
  setTimeout(openRecordPaymentModalFromParams, 80);
}

// ----- Record Payment modal (from Customers Pay) -----
let recordPaymentContext = { saleId: null, balance: 0, customerName: "" };

function getRecordPaymentParams() {
  const params = new URLSearchParams(window.location.search);
  const pay = params.get("pay");
  const customerId = params.get("customerId") || "";
  const customerName = params.get("customerName") || "";
  const balance = params.get("balance") || "";
  const saleId = params.get("saleId") || "";
  return { pay: pay === "1", customerId, customerName, balance: parseFloat(balance) || 0, saleId: saleId ? parseInt(saleId, 10) : null };
}

function openRecordPaymentModalFromParams() {
  const { pay, customerName, balance, saleId } = getRecordPaymentParams();
  if (!pay || !saleId || balance <= 0) return;
  recordPaymentContext = { saleId, balance, customerName: customerName || "—" };
  const modalEl = document.getElementById("recordPaymentModal");
  if (!modalEl) return;
  const nameEl = document.getElementById("record-payment-customer-name");
  const balanceEl = document.getElementById("record-payment-balance");
  if (nameEl) nameEl.textContent = customerName || "—";
  if (balanceEl) balanceEl.textContent = "₱" + (balance || 0).toFixed(2);
  const amountInput = document.getElementById("record-payment-amount");
  if (amountInput) {
    amountInput.value = balance > 0 ? String(Number(balance).toFixed(2)) : "0.00";
    amountInput.setAttribute("max", String(balance));
  }
  const receivedInput = document.getElementById("record-payment-received");
  if (receivedInput) receivedInput.value = "0.00";
  updateRecordPaymentChange();
  resetRecordPaymentModalState();
  
  setTimeout(function () {
    var modal = new bootstrap.Modal(modalEl);
    modal.show();
  }, 150);
  if (window.history && window.history.replaceState) {
    var url = new URL(window.location.href);
    url.searchParams.delete("pay");
    url.searchParams.delete("customerId");
    url.searchParams.delete("customerName");
    url.searchParams.delete("balance");
    url.searchParams.delete("saleId");
    window.history.replaceState({}, "", url.pathname + url.search || url.pathname);
  }
}

function updateRecordPaymentChange() {
  const amountInput = document.getElementById("record-payment-amount");
  const receivedInput = document.getElementById("record-payment-received");
  const changeWrap = document.getElementById("record-payment-change-wrap");
  const changeEl = document.getElementById("record-payment-change");
  if (!amountInput || !receivedInput || !changeWrap || !changeEl) return;
  const toPay = parseFloat(amountInput.value) || 0;
  const received = parseFloat(receivedInput.value) || 0;
  if (received > toPay && toPay >= 0) {
    const change = Math.round((received - toPay) * 100) / 100;
    changeEl.textContent = "₱" + change.toFixed(2);
    changeWrap.classList.remove("d-none");
  } else {
    changeWrap.classList.add("d-none");
  }
}

document.addEventListener("input", function (e) {
  if (e.target.id === "record-payment-amount" || e.target.id === "record-payment-received") {
    updateRecordPaymentChange();
  }
});

function resetRecordPaymentModalState() {
  document.querySelectorAll(".record-payment-option").forEach((el) => {
    el.classList.remove("selected");
    el.disabled = false;
  });
  const manualVerification = document.getElementById("record-payment-manual-verification");
  if (manualVerification) manualVerification.classList.add("d-none");
  const refInput = document.getElementById("record-payment-reference");
  if (refInput) refInput.value = "";
  const refError = document.getElementById("record-payment-reference-error");
  if (refError) refError.textContent = "";
  const amountError = document.getElementById("record-payment-amount-error");
  if (amountError) amountError.textContent = "";
  const amountErrorBig = document.getElementById("record-payment-amount-error-big");
  if (amountErrorBig) {
    amountErrorBig.classList.add("d-none");
    amountErrorBig.textContent = "";
  }
  const changeWrap = document.getElementById("record-payment-change-wrap");
  if (changeWrap) changeWrap.classList.add("d-none");
}

document.addEventListener("click", function (e) {
  const opt = e.target.closest(".record-payment-option[data-payment]");
  if (opt && !opt.disabled) {
    const paymentMethod = opt.dataset.payment;
    document.querySelectorAll(".record-payment-option").forEach((el) => {
      el.classList.remove("selected");
      el.disabled = false;
    });
    opt.classList.add("selected");
    if (paymentMethod === "gcash") {
      const paymayaBtn = document.querySelector(".record-payment-option[data-payment='paymaya']");
      if (paymayaBtn) paymayaBtn.disabled = true;
    } else if (paymentMethod === "paymaya") {
      const gcashBtn = document.querySelector(".record-payment-option[data-payment='gcash']");
      if (gcashBtn) gcashBtn.disabled = true;
    }
    const manualVerification = document.getElementById("record-payment-manual-verification");
    if (manualVerification) {
      if (paymentMethod === "gcash" || paymentMethod === "paymaya") {
        manualVerification.classList.remove("d-none");
      } else {
        manualVerification.classList.add("d-none");
      }
    }
  }
});

document.addEventListener("click", function (e) {
  if (!e.target.closest("#btn-record-payment-submit")) return;
  e.preventDefault();
  const { saleId: saleIdToUse, balance: balanceNum } = recordPaymentContext;
  const selectedOpt = document.querySelector(".record-payment-option.selected");
  const paymentMethod = selectedOpt ? (selectedOpt.dataset.payment || "cash") : "cash";
  const referenceInput = document.getElementById("record-payment-reference");
  const referenceNumber = referenceInput ? (referenceInput.value || "").trim() : "";
  const amountInput = document.getElementById("record-payment-amount");
  const amount = amountInput ? (parseFloat(amountInput.value) || 0) : 0;

  if (!saleIdToUse) {
    alert("Missing sale. Please use the Pay button from the Customers page.");
    return;
  }

  if (!selectedOpt) {
    alert("Please select a payment method.");
    return;
  }
  if (paymentMethod === "gcash" || paymentMethod === "paymaya") {
    if (!referenceNumber) {
      if (referenceInput) referenceInput.classList.add("is-invalid");
      const refError = document.getElementById("record-payment-reference-error");
      if (refError) refError.textContent = "Please enter the reference number.";
      return;
    }
  }
  if (amount <= 0) {
    if (amountInput) amountInput.classList.add("is-invalid");
    const errEl = document.getElementById("record-payment-amount-error");
    if (errEl) errEl.textContent = "Please enter the amount to pay.";
    return;
  }
  var amountRounded = Math.round(amount * 100) / 100;
  var balanceRounded = Math.round(balanceNum * 100) / 100;
  if (amountRounded > balanceRounded) {
    if (amountInput) amountInput.classList.add("is-invalid");
    const errBig = document.getElementById("record-payment-amount-error-big");
    if (errBig) {
      errBig.textContent = "Amount cannot exceed balance due (₱" + balanceRounded.toFixed(2) + ").";
      errBig.classList.remove("d-none");
    }
    return;
  }

  const btn = e.target.closest("#btn-record-payment-submit");
  if (btn) btn.disabled = true;

  fetch(`${SALES_API}/${saleIdToUse}/payments`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({
      amount_paid: amountRounded,
      payment_method: paymentMethod,
      reference_number: referenceNumber || undefined,
    }),
  })
    .then(function (r) {
      if (!r.ok) return r.json().then(function (d) { return Promise.reject(new Error(d.message || "Failed to record payment.")); });
      return r.json();
    })
    .then(function (data) {
      const modalEl = document.getElementById("recordPaymentModal");
      if (modalEl) {
        const m = bootstrap.Modal.getInstance(modalEl);
        if (m) m.hide();
      }
      loadPayments();
      alert("Payment recorded successfully.");

      // Queue payment sync operation so central can update balances.
      try {
        const saleUuid = getSaleUuidForLocalId(saleIdToUse);
        enqueueSyncOperation({
          entityType: "payment",
          operation: "create",
          entityId: saleIdToUse,
          localId: null,
          data: {
            sale_id: saleIdToUse,
            sale_uuid: saleUuid || undefined,
            amount_paid: amountRounded,
            payment_method: paymentMethod,
            reference_number: referenceNumber || undefined,
          },
        });
      } catch (_) {
        // Ignore queue errors; local payment has already been recorded.
      }
    })
    .catch(function (err) {
      alert(err.message || "Failed to record payment.");
    })
    .finally(function () {
      if (btn) btn.disabled = false;
    });
});
