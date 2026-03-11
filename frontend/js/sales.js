/**
 * Sales page: 3-step New Sale (Customer → Items → Payment), list sales, receipt.
 * Uses event delegation so "New Sale" works after pjax load.
 */
import { API_ORIGIN } from "./config.js";
import {
  enqueueSyncOperation,
  generateUuidV4,
  rememberSaleUuidMapping,
} from "./sync-queue.js";
const SALES_API = `${API_ORIGIN}/api/sales`;
const CUSTOMERS_API = `${API_ORIGIN}/api/customers`;
const PRODUCTS_API = `${API_ORIGIN}/api/products`;

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

function getCurrentUser() {
  const raw = localStorage.getItem("sm_user");
  if (!raw) return null;
  try {
    const user = JSON.parse(raw);
    if (!user || typeof user !== "object") return null;
    return user;
  } catch {
    return null;
  }
}

function isAdmin() {
  const user = getCurrentUser();
  return !!user && user.role === "admin";
}

function getTerminalPrefix() {
  try {
    const stored = localStorage.getItem("dm_terminal_prefix");
    if (stored && typeof stored === "string" && stored.trim()) {
      return stored.trim();
    }
  } catch (_) {}
  return "C01";
}

function nextReceiptSequence(todayKey) {
  try {
    const raw = localStorage.getItem("dm_receipt_seq");
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.date === todayKey && typeof parsed.seq === "number") {
        const next = parsed.seq + 1;
        localStorage.setItem("dm_receipt_seq", JSON.stringify({ date: todayKey, seq: next }));
        return next;
      }
    }
  } catch (_) {}
  const first = 1;
  try {
    localStorage.setItem("dm_receipt_seq", JSON.stringify({ date: todayKey, seq: first }));
  } catch (_) {}
  return first;
}

function generateLocalReceiptNumber() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const hours = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");
  const seconds = String(now.getSeconds()).padStart(2, "0");
  const datePart = `${year}${month}${day}`;
  const timePart = `${hours}${minutes}${seconds}`;
  const seq = nextReceiptSequence(datePart);
  const seqPart = String(seq).padStart(6, "0");
  const prefix = getTerminalPrefix();
  return `${prefix}-${datePart}-${timePart}-${seqPart}`;
}

/**
 * Validate Contact field: phone (must start with 09, 11 digits) or email (must contain @).
 * - Empty/whitespace: valid, value undefined.
 * - All digits: treat as phone; must start with 09 and be exactly 11 digits.
 * - Contains @: treat as email → return string.
 * - Text without @: reject.
 */
function normalizeSalePhoneInput(val) {
  const digits = (val != null ? String(val) : "").replace(/\D/g, "");
  if (digits.length === 0) return "";
  let s = digits.slice(0, 11);
  if (s.length >= 1 && s[0] === "9") s = "0" + s.slice(0, 10);
  return s.slice(0, 11);
}

function validateAndNormalizeContact(raw) {
  const trimmed = (raw != null ? String(raw) : "").trim();
  if (trimmed === "") return { valid: true, value: undefined };

  const hasAt = trimmed.includes("@");
  // Phone: only digits, spaces, and optional leading + allowed; reject if any letters
  const phoneAllowed = /^[\s\d+]*\d[\s\d]*$/.test(trimmed);
  const digitsOnly = trimmed.replace(/\s/g, "").replace(/^\+/, "").replace(/\D/g, "");
  const isNumeric = digitsOnly.length > 0 && /^\d+$/.test(digitsOnly);

  if (hasAt) {
    return { valid: true, value: trimmed };
  }
  if (!phoneAllowed || /[a-zA-Z]/.test(trimmed)) {
    return { valid: false, message: "Contact must be a valid phone (09 + 9 digits, numbers only) or email (with @)." };
  }
  if (isNumeric) {
    const normalized = normalizeSalePhoneInput(trimmed);
    if (!/^09\d{9}$/.test(normalized)) {
      return { valid: false, message: "Phone must start with 09 and be 11 digits (e.g. 09171234567)." };
    }
    return { valid: true, value: normalized };
  }
  return { valid: false, message: "Contact must be a valid phone (09 + 9 digits, numbers only) or email (with @)." };
}

/** Address: must not be only numbers (e.g. "1255" is invalid). */
function validateAddress(raw) {
  const trimmed = (raw != null ? String(raw) : "").trim();
  if (trimmed === "") return { valid: true };
  const withoutSpaces = trimmed.replace(/\s/g, "");
  if (/^\d+$/.test(withoutSpaces)) {
    return { valid: false, message: "Address cannot be only numbers; enter a street, barangay, or full address." };
  }
  return { valid: true };
}

// ----- Step state -----
let saleCurrentStep = 1;
let customersList = [];

// Debounce timers for real-time search
let customerSearchTimeout = null;
let productSearchTimeout = null;

function showStep(step) {
  saleCurrentStep = step;
  document.querySelectorAll(".sale-step-pane").forEach((el) => el.classList.add("d-none"));
  const pane = document.getElementById("sale-step-" + step);
  if (pane) pane.classList.remove("d-none");

  document.querySelectorAll(".sale-step").forEach((el) => {
    el.classList.remove("active", "done");
    const n = parseInt(el.dataset.step, 10);
    if (n === step) el.classList.add("active");
    else if (n < step) el.classList.add("done");
  });

  const backBtn = document.getElementById("btn-sale-back");
  const nextBtn = document.getElementById("btn-sale-next");
  const submitBtn = document.getElementById("btn-sale-submit");
  if (backBtn) {
    backBtn.classList.toggle("d-none", step === 1);
  }
  if (nextBtn) {
    nextBtn.classList.toggle("d-none", step === 3);
  }
  if (submitBtn) {
    submitBtn.classList.toggle("d-none", step !== 3);
  }
  if (step === 3) {
    const totalRaw = getSaleTotalRaw();
    const totalRounded = Math.round(totalRaw * 100) / 100;
    const amountToPayEl = document.getElementById("sale-amount-to-pay");
    const amountPaidInput = document.getElementById("sale-amount-paid");
    const amountReceivedInput = document.getElementById("sale-amount-received");
    if (amountToPayEl) amountToPayEl.value = totalRounded > 0 ? String(totalRounded) : "0.00";
    if (amountPaidInput) {
      amountPaidInput.value = totalRounded > 0 ? String(totalRounded) : "0";
    }
    if (amountReceivedInput) amountReceivedInput.value = "0";
    updateSaleChange();
  }
}

function updateSaleChange() {
  const amountPaidInput = document.getElementById("sale-amount-paid");
  const amountReceivedInput = document.getElementById("sale-amount-received");
  const changeWrap = document.getElementById("sale-change-wrap");
  const changeEl = document.getElementById("sale-change");
  if (!amountPaidInput || !amountReceivedInput || !changeWrap || !changeEl) return;
  const toPay = parseFloat(amountPaidInput.value) || 0;
  const received = parseFloat(amountReceivedInput.value) || 0;
  if (received > toPay && toPay >= 0) {
    const change = Math.round((received - toPay) * 100) / 100;
    changeEl.textContent = "₱" + change.toFixed(2);
    changeWrap.classList.remove("d-none");
  } else {
    changeWrap.classList.add("d-none");
  }
}

function resetNewSaleModal() {
  saleCurrentStep = 1;
  const nameInput = document.getElementById("sale-customer-name");
  const customerIdInput = document.getElementById("sale-customer-id");
  const contactInput = document.getElementById("sale-customer-contact");
  const addressInput = document.getElementById("sale-customer-address");
  const customerList = document.getElementById("sale-customer-list");
  const updateWrap = document.getElementById("sale-customer-update-wrap");
  const updateMsg = document.getElementById("sale-update-customer-msg");
  const amountPaid = document.getElementById("sale-amount-paid");
  const tbody = document.getElementById("sale-items-tbody");
  const totalEl = document.getElementById("sale-total");
  const emptyRow = document.getElementById("sale-items-empty");
  const productSearch = document.getElementById("product-search");
  const productResults = document.getElementById("product-search-results");
  const manualVerification = document.getElementById("sale-manual-verification");
  const paymentReference = document.getElementById("sale-payment-reference");

  if (nameInput) nameInput.value = "";
  if (customerIdInput) customerIdInput.value = "";
  if (contactInput) {
    contactInput.value = "";
    contactInput.classList.remove("is-invalid");
    contactInput.disabled = false;
  }
  if (addressInput) {
    addressInput.value = "";
    addressInput.disabled = false;
    addressInput.classList.remove("is-invalid");
  }
  const contactErrorEl = document.getElementById("sale-contact-error");
  if (contactErrorEl) contactErrorEl.textContent = "";
  const addressErrorEl = document.getElementById("sale-address-error");
  if (addressErrorEl) addressErrorEl.textContent = "";
  if (customerList) customerList.innerHTML = "";
  if (updateWrap) updateWrap.classList.add("d-none");
  if (updateMsg) { updateMsg.classList.add("d-none"); updateMsg.textContent = ""; }
  const amountToPay = document.getElementById("sale-amount-to-pay");
  if (amountToPay) amountToPay.value = "0.00";
  if (amountPaid) {
    amountPaid.value = "0";
    amountPaid.placeholder = "0.00";
    amountPaid.readOnly = false;
  }
  const amountReceived = document.getElementById("sale-amount-received");
  if (amountReceived) {
    amountReceived.value = "0";
    amountReceived.readOnly = false;
    amountReceived.disabled = false;
  }
  const changeWrap = document.getElementById("sale-change-wrap");
  if (changeWrap) changeWrap.classList.add("d-none");
  if (productSearch) productSearch.value = "";
  if (productResults) productResults.innerHTML = "";
  if (manualVerification) manualVerification.classList.add("d-none");
  if (paymentReference) paymentReference.value = "";

  saleLineItems = [];
  if (tbody) {
    tbody.innerHTML = "";
    if (emptyRow) tbody.appendChild(emptyRow);
  }
  if (totalEl) totalEl.textContent = "₱0.00";

  document.querySelectorAll(".sale-payment-option").forEach((el) => {
    el.classList.remove("selected");
    el.disabled = false;
  });
  showStep(1);
}

// Contact input: enforce 09 prefix and max 11 digits when typing numbers
function updateSaleContactInputBehavior() {
  const contactEl = document.getElementById("sale-customer-contact");
  if (!contactEl || contactEl.disabled) return;
  const val = contactEl.value;
  if (!/^\d*$/.test(val)) return;
  const normalized = normalizeSalePhoneInput(val);
  if (normalized !== val) contactEl.value = normalized;
  else if (val.length > 11) contactEl.value = val.slice(0, 11);
}

// Clear contact/address validation state when user edits the field; enforce phone 09 + 11 digits
document.addEventListener("input", (e) => {
  if (e.target && e.target.id === "sale-customer-contact") {
    updateSaleContactInputBehavior();
    e.target.classList.remove("is-invalid");
    const errEl = document.getElementById("sale-contact-error");
    if (errEl) errEl.textContent = "";
  }
  if (e.target && e.target.id === "sale-customer-address") {
    e.target.classList.remove("is-invalid");
    const errEl = document.getElementById("sale-address-error");
    if (errEl) errEl.textContent = "";
  }
});

document.addEventListener("focusout", (e) => {
  if (e.target && e.target.id === "sale-customer-contact") {
    updateSaleContactInputBehavior();
  }
});

// ----- Open modal & customer autocomplete -----
document.addEventListener("click", (e) => {
  if (!e.target.closest("#btn-new-sale")) return;
  const modalEl = document.getElementById("newSaleModal");
  if (!modalEl) return;
  e.preventDefault();
  const modal = new bootstrap.Modal(modalEl);
  resetNewSaleModal();
  loadCustomersForAutocomplete();
  // Clear any alerts
  const alertEl = document.getElementById("sales-alert");
  if (alertEl) {
    alertEl.classList.add("d-none");
    alertEl.textContent = "";
  }
  modal.show();
});

function loadCustomersForAutocomplete() {
  // Pre-load customers list for faster initial filtering
  fetch(CUSTOMERS_API, { headers: authHeaders() })
    .then((r) => {
      if (!r.ok) {
        throw new Error(`HTTP ${r.status}: ${r.statusText}`);
      }
      return r.json();
    })
    .then((data) => {
      customersList = data.customers || [];
      console.log(`Loaded ${customersList.length} customers for autocomplete`);
    })
    .catch((err) => {
      console.error("Failed to load customers:", err);
      customersList = [];
    });
}

// Real-time customer search with API call
function searchCustomersRealTime(query) {
  const listEl = document.getElementById("sale-customer-list");
  const idInput = document.getElementById("sale-customer-id");
  if (!listEl) return;
  
  if (idInput) idInput.value = "";
  
  const q = query.trim();
  if (q.length < 1) {
    listEl.innerHTML = "";
    return;
  }
  
  // Show loading state
  listEl.innerHTML = "<li class='list-group-item text-muted'>Searching customers…</li>";
  
  // Search customers API with query parameter
  fetch(`${CUSTOMERS_API}?q=${encodeURIComponent(q)}`, { headers: authHeaders() })
    .then((r) => {
      if (!r.ok) {
        throw new Error(`HTTP ${r.status}: ${r.statusText}`);
      }
      return r.json();
    })
    .then((data) => {
      const matches = (data.customers || []).slice(0, 10);
      if (matches.length === 0) {
        listEl.innerHTML = "<li class='list-group-item text-muted'>No customers found. Try a different search term.</li>";
        return;
      }
      listEl.innerHTML = matches
        .map(
          (c) =>
            `<button type="button" class="list-group-item list-group-item-action text-start" data-customer-id="${c.id != null ? c.id : ""}" data-customer-name="${escapeHtml(c.name || "")}" data-customer-contact="${escapeHtml((c.contact != null ? c.contact : "") || "")}" data-customer-address="${escapeHtml((c.address != null ? c.address : "") || "")}">${escapeHtml(c.name || "")}</button>`
        )
        .join("");
    })
    .catch((err) => {
      console.error("Customer search error:", err);
      listEl.innerHTML = `<li class='list-group-item text-danger'>Failed to search customers: ${err.message || "Unknown error"}</li>`;
    });
}

document.addEventListener("input", (e) => {
  if (e.target.id !== "sale-customer-name") return;
  
  const q = e.target.value || "";
  const listEl = document.getElementById("sale-customer-list");
  if (!listEl) return;
  
  // Clear alert when user starts typing
  const alertEl = document.getElementById("sales-alert");
  if (alertEl && !alertEl.classList.contains("d-none")) {
    alertEl.classList.add("d-none");
  }
  
  // Clear previous timeout
  if (customerSearchTimeout) {
    clearTimeout(customerSearchTimeout);
  }
  
  // Debounce: wait 300ms after user stops typing before searching
  customerSearchTimeout = setTimeout(() => {
    searchCustomersRealTime(q);
  }, 300);
});

document.addEventListener("click", (e) => {
  const customerItem = e.target.closest("#sale-customer-list button[data-customer-id]");
  if (customerItem) {
    const nameInput = document.getElementById("sale-customer-name");
    const idInput = document.getElementById("sale-customer-id");
    const contactInput = document.getElementById("sale-customer-contact");
    const addressInput = document.getElementById("sale-customer-address");
    const updateWrap = document.getElementById("sale-customer-update-wrap");
    const updateMsg = document.getElementById("sale-update-customer-msg");
    if (nameInput) nameInput.value = customerItem.dataset.customerName || "";
    if (idInput) idInput.value = customerItem.dataset.customerId || "";
    if (contactInput) {
      contactInput.value = customerItem.dataset.customerContact || "";
      contactInput.disabled = true;
    }
    if (addressInput) {
      addressInput.value = customerItem.dataset.customerAddress || "";
      addressInput.disabled = true;
    }
    if (updateWrap) updateWrap.classList.add("d-none");
    if (updateMsg) { updateMsg.classList.add("d-none"); updateMsg.textContent = ""; }
    const listEl = document.getElementById("sale-customer-list");
    if (listEl) listEl.innerHTML = "";
  }
});

// "Buyer changed their contact or address" – enable contact/address and show update wrap (existing customer)
document.addEventListener("click", (e) => {
  if (!e.target.closest("#btn-sale-customer-changed-info")) return;
  const idInput = document.getElementById("sale-customer-id");
  const contactInput = document.getElementById("sale-customer-contact");
  const addressInput = document.getElementById("sale-customer-address");
  const updateWrap = document.getElementById("sale-customer-update-wrap");
  if (contactInput) contactInput.disabled = false;
  if (addressInput) addressInput.disabled = false;
  if (idInput && (idInput.value || "").trim()) {
    if (updateWrap) updateWrap.classList.remove("d-none");
  } else {
    const alertEl = document.getElementById("sales-alert");
    if (alertEl) {
      alertEl.textContent = "For a new customer, contact and address are required below.";
      alertEl.className = "alert alert-info py-2 small";
      alertEl.classList.remove("d-none");
    }
  }
});

// Update customer (PUT) – save name, contact, address to customers
document.addEventListener("click", (e) => {
  if (!e.target.closest("#btn-sale-update-customer")) return;
  const idInput = document.getElementById("sale-customer-id");
  const customerId = idInput ? (idInput.value || "").trim() : "";
  const id = customerId ? parseInt(customerId, 10) : NaN;
  if (!Number.isInteger(id) || id <= 0) return;
  const nameInput = document.getElementById("sale-customer-name");
  const contactInput = document.getElementById("sale-customer-contact");
  const addressInput = document.getElementById("sale-customer-address");
  const name = nameInput ? nameInput.value.trim() : "";
  const contactRaw = contactInput ? contactInput.value : "";
  const contactResult = validateAndNormalizeContact(contactRaw);
  if (!contactResult.valid) {
    const alertEl = document.getElementById("sales-alert");
    if (alertEl) {
      alertEl.textContent = contactResult.message;
      alertEl.className = "alert alert-warning py-2 small";
      alertEl.classList.remove("d-none");
    }
    if (contactInput) {
      contactInput.classList.add("is-invalid");
      const errEl = document.getElementById("sale-contact-error");
      if (errEl) errEl.textContent = contactResult.message;
    }
    return;
  }
  const contact = contactResult.value;
  const address = addressInput ? addressInput.value.trim() : "";
  const addressResult = validateAddress(address);
  if (!addressResult.valid) {
    const alertEl = document.getElementById("sales-alert");
    if (alertEl) {
      alertEl.textContent = addressResult.message;
      alertEl.className = "alert alert-warning py-2 small";
      alertEl.classList.remove("d-none");
    }
    if (addressInput) {
      addressInput.classList.add("is-invalid");
      const errEl = document.getElementById("sale-address-error");
      if (errEl) errEl.textContent = addressResult.message;
    }
    return;
  }
  if (!name) {
    const alertEl = document.getElementById("sales-alert");
    if (alertEl) {
      alertEl.textContent = "Customer name is required.";
      alertEl.className = "alert alert-warning py-2 small";
      alertEl.classList.remove("d-none");
    }
    return;
  }
  const msgEl = document.getElementById("sale-update-customer-msg");
  fetch(`${CUSTOMERS_API}/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ name, contact, address }),
  })
    .then((r) => {
      if (!r.ok) return r.json().then((d) => Promise.reject(new Error(d.message || "Failed to update customer")));
      return r.json();
    })
    .then(() => {
      if (msgEl) {
        msgEl.textContent = "Updated. Changes will appear on the Customers page.";
        msgEl.classList.remove("d-none");
      }
    })
    .catch((err) => {
      const alertEl = document.getElementById("sales-alert");
      if (alertEl) {
        alertEl.textContent = err.message || "Failed to update customer.";
        alertEl.className = "alert alert-danger py-2 small";
        alertEl.classList.remove("d-none");
      }
    });
});

// ----- Next / Back -----
document.addEventListener("click", (e) => {
  if (e.target.closest("#btn-sale-next")) {
    if (saleCurrentStep === 1) {
      const customerNameInput = document.getElementById("sale-customer-name");
      const idInput = document.getElementById("sale-customer-id");
      const customerName = customerNameInput ? customerNameInput.value.trim() : "";
      const customerId = (idInput && idInput.value) ? (idInput.value || "").trim() : "";
      const isNewCustomer = !customerId;
      if (!customerName) {
        const alertEl = document.getElementById("sales-alert");
        if (alertEl) {
          alertEl.textContent = "Please enter customer name.";
          alertEl.className = "alert alert-warning py-2 small";
          alertEl.classList.remove("d-none");
        }
        return;
      }
      const contactInput = document.getElementById("sale-customer-contact");
      const addressInput = document.getElementById("sale-customer-address");
      const contactRaw = contactInput ? contactInput.value : "";
      const addressTrimmed = addressInput ? addressInput.value.trim() : "";
      if (isNewCustomer) {
        if (!contactRaw.trim()) {
          const alertEl = document.getElementById("sales-alert");
          if (alertEl) {
            alertEl.textContent = "Contact is required for new customers.";
            alertEl.className = "alert alert-warning py-2 small";
            alertEl.classList.remove("d-none");
          }
          if (contactInput) {
            contactInput.classList.add("is-invalid");
            const errEl = document.getElementById("sale-contact-error");
            if (errEl) errEl.textContent = "Contact is required for new customers.";
          }
          return;
        }
        if (!addressTrimmed) {
          const alertEl = document.getElementById("sales-alert");
          if (alertEl) {
            alertEl.textContent = "Address is required for new customers.";
            alertEl.className = "alert alert-warning py-2 small";
            alertEl.classList.remove("d-none");
          }
          if (addressInput) {
            addressInput.classList.add("is-invalid");
            const errEl = document.getElementById("sale-address-error");
            if (errEl) errEl.textContent = "Address is required for new customers.";
          }
          return;
        }
        const addressResult = validateAddress(addressTrimmed);
        if (!addressResult.valid) {
          const alertEl = document.getElementById("sales-alert");
          if (alertEl) {
            alertEl.textContent = addressResult.message;
            alertEl.className = "alert alert-warning py-2 small";
            alertEl.classList.remove("d-none");
          }
          if (addressInput) {
            addressInput.classList.add("is-invalid");
            const errEl = document.getElementById("sale-address-error");
            if (errEl) errEl.textContent = addressResult.message;
          }
          return;
        }
      }
      const contactResult = validateAndNormalizeContact(contactRaw);
      if (!contactResult.valid) {
        const alertEl = document.getElementById("sales-alert");
        if (alertEl) {
          alertEl.textContent = contactResult.message;
          alertEl.className = "alert alert-warning py-2 small";
          alertEl.classList.remove("d-none");
        }
        if (contactInput) {
          contactInput.classList.add("is-invalid");
          const errEl = document.getElementById("sale-contact-error");
          if (errEl) errEl.textContent = contactResult.message;
        }
        return;
      }
      const contactValue = contactResult.value;
      const hasContact = contactValue != null && String(contactValue).trim() !== "";
      if (hasContact) {
        const params = new URLSearchParams({ contact: String(contactValue).trim() });
        if (customerId) params.set("exclude_customer_id", customerId);
        fetch(`${CUSTOMERS_API}/check-contact?${params}`, { headers: authHeaders() })
          .then((r) => r.json())
          .then((data) => {
            if (data.available !== false) {
              if (contactInput) contactInput.classList.remove("is-invalid");
              if (addressInput) addressInput.classList.remove("is-invalid");
              const errEl = document.getElementById("sale-contact-error");
              if (errEl) errEl.textContent = "";
              const addressErrEl = document.getElementById("sale-address-error");
              if (addressErrEl) addressErrEl.textContent = "";
              showStep(2);
            } else {
              const msg = data.message || "That contact is already used by another customer.";
              const alertEl = document.getElementById("sales-alert");
              if (alertEl) {
                alertEl.textContent = msg;
                alertEl.className = "alert alert-warning py-2 small";
                alertEl.classList.remove("d-none");
              }
              if (contactInput) {
                contactInput.classList.add("is-invalid");
                const errEl = document.getElementById("sale-contact-error");
                if (errEl) errEl.textContent = msg;
              }
            }
          })
          .catch(() => {
            const alertEl = document.getElementById("sales-alert");
            if (alertEl) {
              alertEl.textContent = "Could not verify contact. Please try again.";
              alertEl.className = "alert alert-warning py-2 small";
              alertEl.classList.remove("d-none");
            }
          });
        return;
      }
      if (contactInput) contactInput.classList.remove("is-invalid");
      if (addressInput) addressInput.classList.remove("is-invalid");
      const errEl = document.getElementById("sale-contact-error");
      if (errEl) errEl.textContent = "";
      const addressErrEl = document.getElementById("sale-address-error");
      if (addressErrEl) addressErrEl.textContent = "";
      showStep(2);
      return;
    }
    if (saleCurrentStep === 2) {
      if (saleLineItems.length === 0) {
        const alertEl = document.getElementById("sales-alert");
        if (alertEl) {
          alertEl.textContent = "Add at least one item before continuing.";
          alertEl.className = "alert alert-warning py-2 small";
          alertEl.classList.remove("d-none");
        }
        return;
      }
      const tbody = document.getElementById("sale-items-tbody");
      let qtyExceedsStock = null;
      if (tbody) {
        tbody.querySelectorAll("tr[data-product-id]").forEach((row) => {
          const qtyInput = row.querySelector("input[data-qty]");
          const qty = qtyInput ? Math.max(1, parseInt(qtyInput.value, 10) || 1) : 1;
          const productId = parseInt(row.dataset.productId, 10);
          const it = saleLineItems.find((i) => i.product_id === productId);
          if (it) {
            it.quantity = qty;
            if (it.stock_quantity != null && qty > it.stock_quantity) {
              qtyExceedsStock = { name: it.product_name, stock: it.stock_quantity, qty };
              if (qtyInput) qtyInput.classList.add("is-invalid");
            } else if (qtyInput) {
              qtyInput.classList.remove("is-invalid");
            }
          }
        });
      }
      if (qtyExceedsStock) {
        const alertEl = document.getElementById("sales-alert");
        if (alertEl) {
          alertEl.textContent = `Quantity for "${qtyExceedsStock.name}" exceeds available stock (${qtyExceedsStock.stock}). Reduce the quantity to proceed.`;
          alertEl.className = "alert alert-warning py-2 small";
          alertEl.classList.remove("d-none");
        }
        return;
      }
      showStep(3);
    }
  }
  if (e.target.closest("#btn-sale-back")) {
    if (saleCurrentStep === 2) showStep(1);
    else if (saleCurrentStep === 3) showStep(2);
  }
});

// ----- Payment option selection + QR code generation -----
// GCash/PayMaya numbers (configure these in your environment/config)
const GCASH_NUMBER = "09100429321"; // Replace with your actual GCash number
const PAYMAYA_NUMBER = "09100429321"; // Replace with your actual PayMaya number

// GCash Merchant Configuration (Update with your actual GCash merchant details)
// IMPORTANT: To generate valid GCash QR codes, you need:
// 1. A registered GCash Merchant Account (not just a personal GCash account)
// 2. Your official GCash Merchant ID (provided by GCash when you register as a merchant)
// 3. Contact GCash Business/Enterprise support to get your merchant credentials
const GCASH_MERCHANT_NAME = "D&M Construction Supply"; // Your business name (max 25 chars)
const GCASH_MERCHANT_CITY = "Manila"; // Your city (max 15 chars)
const GCASH_MERCHANT_ID = GCASH_NUMBER; // GCash merchant ID - MUST be your official GCash Merchant Account Number
// Note: If you only have a personal GCash account, you'll need to register as a merchant first
// Visit: https://www.gcash.com/business or contact GCash Business Support

document.addEventListener("click", (e) => {
  const opt = e.target.closest(".sale-payment-option[data-payment]");
  if (opt && !opt.disabled) {
    const paymentMethod = opt.dataset.payment;
    
    document.querySelectorAll(".sale-payment-option").forEach((el) => {
      el.classList.remove("selected");
      el.disabled = false;
    });
    opt.classList.add("selected");
    
    if (paymentMethod === "gcash") {
      const paymayaBtn = document.querySelector(".sale-payment-option[data-payment='paymaya']");
      if (paymayaBtn) paymayaBtn.disabled = true;
    } else if (paymentMethod === "paymaya") {
      const gcashBtn = document.querySelector(".sale-payment-option[data-payment='gcash']");
      if (gcashBtn) gcashBtn.disabled = true;
    }
    
    const manualVerification = document.getElementById("sale-manual-verification");
    if (paymentMethod === "gcash" || paymentMethod === "paymaya") {
      if (manualVerification) manualVerification.classList.remove("d-none");
    } else {
      if (manualVerification) manualVerification.classList.add("d-none");
      document.querySelectorAll(".sale-payment-option").forEach((el) => {
        el.disabled = false;
      });
    }
    const totalRaw = getSaleTotalRaw();
    const totalRounded = Math.round(totalRaw * 100) / 100;
    const amountToPayEl = document.getElementById("sale-amount-to-pay");
    const amountPaidInput = document.getElementById("sale-amount-paid");
    const amountReceivedInput = document.getElementById("sale-amount-received");
    if (amountToPayEl) amountToPayEl.value = totalRounded > 0 ? String(totalRounded) : "0.00";
    if (paymentMethod === "credit") {
      if (amountPaidInput) {
        amountPaidInput.value = "0";
        amountPaidInput.readOnly = true;
        amountPaidInput.placeholder = "0";
      }
      if (amountReceivedInput) {
        amountReceivedInput.value = "0";
        amountReceivedInput.readOnly = true;
        amountReceivedInput.disabled = true;
      }
    } else {
      if (amountPaidInput) {
        amountPaidInput.readOnly = false;
        amountPaidInput.value = totalRounded > 0 ? String(totalRounded) : "0";
        amountPaidInput.placeholder = "0";
      }
      if (amountReceivedInput) {
        amountReceivedInput.readOnly = false;
        amountReceivedInput.disabled = false;
      }
    }
    updateSaleChange();
  }
});

// ----- Product search and line items -----
let saleLineItems = [];

// Real-time product search on input
document.addEventListener("input", (e) => {
  if (e.target.id === "product-search") {
    const q = (e.target.value || "").trim();
    const resultsEl = document.getElementById("product-search-results");
    if (!resultsEl) return;
    
    // Clear previous timeout
    if (productSearchTimeout) {
      clearTimeout(productSearchTimeout);
    }
    
    if (q.length < 1) {
      resultsEl.innerHTML = "";
      return;
    }
    
    // Debounce: wait 300ms after user stops typing before searching
    productSearchTimeout = setTimeout(() => {
      searchProducts(q);
    }, 300);
    return;
  }
});

document.addEventListener("click", (e) => {
  const searchBtn = e.target.closest("#btn-product-search");
  if (searchBtn) {
    const input = document.getElementById("product-search");
    if (input && input.value.trim()) {
      // Clear timeout and search immediately
      if (productSearchTimeout) {
        clearTimeout(productSearchTimeout);
      }
      searchProducts(input.value.trim());
    }
    return;
  }
  const addBtn = e.target.closest("[data-action='add-product']");
  if (addBtn) {
    const id = parseInt(addBtn.dataset.productId, 10);
    const name = addBtn.dataset.productName || "";
    const price = parseFloat(addBtn.dataset.price) || 0;
    const stock = parseInt(addBtn.dataset.stock, 10) || 0;
    addLineItem({ product_id: id, product_name: name, price, quantity: 1, stock_quantity: stock });
    const results = document.getElementById("product-search-results");
    if (results) results.innerHTML = "";
    const productSearch = document.getElementById("product-search");
    if (productSearch) productSearch.value = "";
    return;
  }
  const removeBtn = e.target.closest("[data-action='remove-line']");
  if (removeBtn) {
    const row = removeBtn.closest("tr");
    const productId = row && parseInt(row.dataset.productId, 10);
    if (productId !== undefined) removeLineItem(productId);
  }
});

document.addEventListener("input", (e) => {
  if (e.target.id === "sale-amount-paid" || e.target.matches("#sale-items-tbody input[data-qty]")) {
    e.target.classList.remove("is-invalid");
    const amountErrorBig = document.getElementById("sale-amount-paid-error-big");
    if (amountErrorBig) {
      amountErrorBig.classList.add("d-none");
      amountErrorBig.textContent = "";
    }
    const amountFeedback = document.getElementById("sale-amount-paid-error");
    if (amountFeedback) amountFeedback.textContent = "";
    updateSaleTotal();
    updateSaleChange();
  }
  if (e.target.id === "sale-amount-received") {
    e.target.classList.remove("is-invalid");
    const errEl = document.getElementById("sale-amount-received-error");
    if (errEl) errEl.textContent = "";
    updateSaleChange();
  }
  if (e.target.id === "sale-payment-reference") {
    e.target.classList.remove("is-invalid");
  }
});

// Round amount paid to whole pesos on blur (avoid cents; ≥0.50 rounds up)
document.addEventListener("blur", (e) => {
  if (e.target.id !== "sale-amount-paid") return;
  const input = e.target;
  const val = parseFloat(input.value);
  if (Number.isNaN(val) || val < 0) {
    input.value = "0";
    return;
  }
  const rounded = roundToWholePeso(val);
  input.value = String(rounded);
  updateSaleTotal();
});

document.addEventListener("change", (e) => {
  if (e.target.matches("#sale-items-tbody input[data-qty]")) updateSaleTotal();
});

function searchProducts(q) {
  const resultsEl = document.getElementById("product-search-results");
  if (!resultsEl) return;
  resultsEl.innerHTML = "<li class='list-group-item text-muted'>Searching…</li>";
  fetch(`${PRODUCTS_API}?q=${encodeURIComponent(q)}`, {
    headers: authHeaders(),
  })
    .then((r) => r.json())
    .then((data) => {
      const list = data.products || [];
      if (list.length === 0) {
        resultsEl.innerHTML = "<li class='list-group-item text-muted'>No products found.</li>";
        return;
      }
      resultsEl.innerHTML = list
        .map(
          (p) => {
            const stock = p.stock_quantity != null ? Number(p.stock_quantity) : 0;
            return `<button type="button" class="list-group-item list-group-item-action" data-action="add-product" data-product-id="${p.id}" data-product-name="${escapeHtml(p.name)}" data-price="${p.selling_price || 0}" data-stock="${stock}">${escapeHtml(p.name)} <span class="text-muted small">(${stock} in stock)</span> – ₱${Number(p.selling_price || 0).toFixed(2)}</button>`;
          }
        )
        .join("");
    })
    .catch(() => {
      resultsEl.innerHTML = "<li class='list-group-item text-danger'>Failed to search.</li>";
    });
}

function addLineItem(item) {
  const existing = saleLineItems.find((i) => i.product_id === item.product_id);
  if (existing) {
    existing.quantity += item.quantity || 1;
  } else {
    saleLineItems.push({
      product_id: item.product_id,
      product_name: item.product_name,
      price: item.price,
      quantity: item.quantity || 1,
      stock_quantity: item.stock_quantity != null ? item.stock_quantity : undefined,
    });
  }
  renderSaleItems();
  updateSaleTotal();
}

function removeLineItem(productId) {
  saleLineItems = saleLineItems.filter((i) => i.product_id !== productId);
  renderSaleItems();
  updateSaleTotal();
}

function renderSaleItems() {
  const tbody = document.getElementById("sale-items-tbody");
  const emptyRow = document.getElementById("sale-items-empty");
  if (!tbody) return;
  if (saleLineItems.length === 0) {
    tbody.innerHTML = "";
    if (emptyRow) tbody.appendChild(emptyRow);
    return;
  }
  if (emptyRow) emptyRow.remove();
  tbody.innerHTML = saleLineItems
    .map(
      (it) => {
        const sub = it.price * it.quantity;
        const stockText = it.stock_quantity != null ? ` <span class="text-muted small">(${it.stock_quantity} in stock)</span>` : "";
        return `<tr data-product-id="${it.product_id}">
          <td>${escapeHtml(it.product_name)}${stockText}</td>
          <td class="text-end"><input type="number" min="1" class="form-control form-control-sm text-end" data-qty value="${it.quantity}" style="width:70px" /></td>
          <td class="text-end">₱${Number(it.price).toFixed(2)}</td>
          <td class="text-end">₱${Number(sub).toFixed(2)}</td>
          <td><button type="button" class="btn btn-outline-danger btn-sm" data-action="remove-line" aria-label="Remove"><i class="bi bi-x"></i></button></td>
        </tr>`;
      }
    )
    .join("");
  tbody.querySelectorAll("input[data-qty]").forEach((input) => {
    input.addEventListener("change", () => {
      const row = input.closest("tr");
      const productId = row && parseInt(row.dataset.productId, 10);
      const qty = Math.max(1, parseInt(input.value, 10) || 1);
      const it = saleLineItems.find((i) => i.product_id === productId);
      if (it) it.quantity = qty;
      updateSaleTotal();
    });
  });
}

/**
 * Round to whole pesos: cents >= 0.5 round up, otherwise round down.
 */
function roundToWholePeso(value) {
  const n = Number(value);
  if (Number.isNaN(n)) return 0;
  return Math.round(n);
}

/**
 * Get current sale total from line items (raw sum).
 */
function getSaleTotalRaw() {
  const tbody = document.getElementById("sale-items-tbody");
  if (!tbody) return 0;
  let total = 0;
  tbody.querySelectorAll("tr[data-product-id]").forEach((row) => {
    const qtyInput = row.querySelector("input[data-qty]");
    const qty = qtyInput ? Math.max(1, parseInt(qtyInput.value, 10) || 1) : 1;
    const it = saleLineItems.find(
      (i) => i.product_id === parseInt(row.dataset.productId, 10)
    );
    if (it) {
      total += it.price * qty;
    }
  });
  return total;
}

function updateSaleTotal() {
  const tbody = document.getElementById("sale-items-tbody");
  const totalEl = document.getElementById("sale-total");
  if (!tbody || !totalEl) return;
  let total = 0;
  tbody.querySelectorAll("tr[data-product-id]").forEach((row) => {
    const qtyInput = row.querySelector("input[data-qty]");
    const qty = qtyInput ? Math.max(1, parseInt(qtyInput.value, 10) || 1) : 1;
    const it = saleLineItems.find(
      (i) => i.product_id === parseInt(row.dataset.productId, 10)
    );
    if (it) {
      it.quantity = qty;
      total += it.price * qty;
    }
  });
  totalEl.textContent = `₱${Number(total).toFixed(2)}`;
  const amountToPayEl = document.getElementById("sale-amount-to-pay");
  if (amountToPayEl) {
    const rounded = Math.round(total * 100) / 100;
    amountToPayEl.value = rounded > 0 ? String(rounded) : "0.00";
  }
}

// ----- Submit sale -----
document.addEventListener("click", (e) => {
  if (!e.target.closest("#btn-sale-submit")) return;
  e.preventDefault();
  submitSale();
});

function submitSale() {
  const idInput = document.getElementById("sale-customer-id");
  const customerNameInput = document.getElementById("sale-customer-name");
  const amountPaidEl = document.getElementById("sale-amount-paid");
  const amountReceivedEl = document.getElementById("sale-amount-received");
  const selectedPayment = document.querySelector(".sale-payment-option.selected");

  const customerId = idInput ? (idInput.value || null) : null;
  const customerName = customerNameInput ? customerNameInput.value.trim() : "";
  const amountPaid = amountPaidEl ? parseFloat(amountPaidEl.value) || 0 : 0;
  const amountReceivedRaw = amountReceivedEl ? parseFloat(amountReceivedEl.value) || 0 : 0;
  const paymentMethod = selectedPayment ? (selectedPayment.dataset.payment || "cash") : "cash";

  if (!customerName) {
    const alertEl = document.getElementById("sales-alert");
    if (alertEl) {
      alertEl.textContent = "Please enter customer name.";
      alertEl.className = "alert alert-warning py-2 small";
      alertEl.classList.remove("d-none");
    }
    return;
  }

  if (!selectedPayment) {
    const alertEl = document.getElementById("sales-alert");
    if (alertEl) {
      alertEl.textContent = "Please select a payment method.";
      alertEl.className = "alert alert-warning py-2 small";
      alertEl.classList.remove("d-none");
    }
    return;
  }

  const tbody = document.getElementById("sale-items-tbody");
  const items = [];
  tbody.querySelectorAll("tr[data-product-id]").forEach((row) => {
    const productId = parseInt(row.dataset.productId, 10);
    const qtyInput = row.querySelector("input[data-qty]");
    const qty = qtyInput ? Math.max(1, parseInt(qtyInput.value, 10) || 1) : 1;
    const it = saleLineItems.find((i) => i.product_id === productId);
    if (it) items.push({ product_id: productId, quantity: qty });
  });

  if (items.length === 0) {
    const alertEl = document.getElementById("sales-alert");
    if (alertEl) {
      alertEl.textContent = "Add at least one item.";
      alertEl.className = "alert alert-warning py-2 small";
      alertEl.classList.remove("d-none");
    }
    return;
  }

  const overStock = items.find((item) => {
    const it = saleLineItems.find((i) => i.product_id === item.product_id);
    return it && it.stock_quantity != null && item.quantity > it.stock_quantity;
  });
  if (overStock) {
    const it = saleLineItems.find((i) => i.product_id === overStock.product_id);
    const alertEl = document.getElementById("sales-alert");
    if (alertEl) {
      alertEl.textContent = `Quantity for "${it ? it.product_name : "item"}" exceeds available stock (${it ? it.stock_quantity : 0}). Reduce the quantity to proceed.`;
      alertEl.className = "alert alert-warning py-2 small";
      alertEl.classList.remove("d-none");
    }
    return;
  }

  const referenceInput = document.getElementById("sale-payment-reference");
  const referenceNumber = referenceInput ? (referenceInput.value || "").trim() : "";
  const amountPaidInput = document.getElementById("sale-amount-paid");
  const amountPaidErrorBig = document.getElementById("sale-amount-paid-error-big");

  // Clear previous inline validation
  if (referenceInput) referenceInput.classList.remove("is-invalid");
  if (amountPaidInput) amountPaidInput.classList.remove("is-invalid");
  if (amountPaidErrorBig) {
    amountPaidErrorBig.classList.add("d-none");
    amountPaidErrorBig.textContent = "";
  }

  // Reference number required for GCash/PayMaya
  if (paymentMethod === "gcash" || paymentMethod === "paymaya") {
    if (!referenceNumber) {
      const alertEl = document.getElementById("sales-alert");
      if (alertEl) {
        alertEl.textContent = "Please enter the reference number for GCash/PayMaya payment.";
        alertEl.className = "alert alert-warning py-2 small";
        alertEl.classList.remove("d-none");
      }
      if (referenceInput) referenceInput.classList.add("is-invalid");
      return;
    }
  }

  // Amount paid required (except for Credit, where 0 is allowed for full debt)
  const amountPaidRounded = roundToWholePeso(amountPaid);
  if (amountPaidRounded < 0) {
    const alertEl = document.getElementById("sales-alert");
    if (alertEl) {
      alertEl.textContent = "Amount paid cannot be negative.";
      alertEl.className = "alert alert-warning py-2 small";
      alertEl.classList.remove("d-none");
    }
    if (amountPaidInput) amountPaidInput.classList.add("is-invalid");
    return;
  }
  if (amountPaidRounded <= 0 && paymentMethod !== "credit") {
    const alertEl = document.getElementById("sales-alert");
    if (alertEl) {
      alertEl.textContent = "Please enter the amount paid.";
      alertEl.className = "alert alert-warning py-2 small";
      alertEl.classList.remove("d-none");
    }
    if (amountPaidInput) amountPaidInput.classList.add("is-invalid");
    const feedbackEl = document.getElementById("sale-amount-paid-error");
    if (feedbackEl) feedbackEl.textContent = "Please enter the amount paid.";
    return;
  }

  // Amount received required to proceed (except for Credit)
  const amountReceivedRounded = roundToWholePeso(amountReceivedRaw);
  const amountReceivedErrorEl = document.getElementById("sale-amount-received-error");
  if (paymentMethod !== "credit") {
    if (amountReceivedRounded <= 0) {
      const alertEl = document.getElementById("sales-alert");
      if (alertEl) {
        alertEl.textContent = "Please enter the amount received.";
        alertEl.className = "alert alert-warning py-2 small";
        alertEl.classList.remove("d-none");
      }
      if (amountReceivedEl) amountReceivedEl.classList.add("is-invalid");
      if (amountReceivedErrorEl) amountReceivedErrorEl.textContent = "Amount received is required to proceed.";
      return;
    }
    if (amountReceivedRounded < amountPaidRounded) {
      const alertEl = document.getElementById("sales-alert");
      if (alertEl) {
        alertEl.textContent = "Amount received cannot be less than amount paid.";
        alertEl.className = "alert alert-warning py-2 small";
        alertEl.classList.remove("d-none");
      }
      if (amountReceivedEl) amountReceivedEl.classList.add("is-invalid");
      if (amountReceivedErrorEl) amountReceivedErrorEl.textContent = "Must be at least the amount paid.";
      return;
    }
  }
  if (amountReceivedEl) amountReceivedEl.classList.remove("is-invalid");
  if (amountReceivedErrorEl) amountReceivedErrorEl.textContent = "";

  // Round total to whole pesos (cents >= 0.5 round up)
  const totalRaw = getSaleTotalRaw();
  const totalRounded = roundToWholePeso(totalRaw);

  if (amountPaidRounded > totalRounded) {
    if (amountPaidInput) amountPaidInput.classList.add("is-invalid");
    if (amountPaidErrorBig) {
      amountPaidErrorBig.innerHTML = `Amount paid <strong>₱${amountPaidRounded.toLocaleString()}</strong> cannot exceed the sale total <strong>₱${totalRounded.toLocaleString()}</strong>.`;
      amountPaidErrorBig.classList.remove("d-none");
    }
    const alertEl = document.getElementById("sales-alert");
    if (alertEl) {
      alertEl.textContent = `Amount paid (₱${amountPaidRounded}) cannot exceed the sale total (₱${totalRounded}).`;
      alertEl.className = "alert alert-warning py-2 small";
      alertEl.classList.remove("d-none");
    }
    return;
  }

  const idInputForPayload = document.getElementById("sale-customer-id");
  const customerIdForPayload = (idInputForPayload && idInputForPayload.value) ? (idInputForPayload.value || "").trim() : "";
  const isNewCustomerForPayload = !customerIdForPayload;
  const contactInputForPayload = document.getElementById("sale-customer-contact");
  const addressInputForPayload = document.getElementById("sale-customer-address");
  const contactRawForPayload = contactInputForPayload ? contactInputForPayload.value : "";
  const addressTrimmedForPayload = addressInputForPayload ? addressInputForPayload.value.trim() : "";
  if (isNewCustomerForPayload) {
    if (!contactRawForPayload.trim()) {
      const alertEl = document.getElementById("sales-alert");
      if (alertEl) {
        alertEl.textContent = "Contact is required for new customers.";
        alertEl.className = "alert alert-warning py-2 small";
        alertEl.classList.remove("d-none");
      }
      if (contactInputForPayload) {
        contactInputForPayload.classList.add("is-invalid");
        const errEl = document.getElementById("sale-contact-error");
        if (errEl) errEl.textContent = "Contact is required for new customers.";
      }
      return;
    }
    if (!addressTrimmedForPayload) {
      const alertEl = document.getElementById("sales-alert");
      if (alertEl) {
        alertEl.textContent = "Address is required for new customers.";
        alertEl.className = "alert alert-warning py-2 small";
        alertEl.classList.remove("d-none");
      }
      if (addressInputForPayload) {
        addressInputForPayload.classList.add("is-invalid");
        const errEl = document.getElementById("sale-address-error");
        if (errEl) errEl.textContent = "Address is required for new customers.";
      }
      return;
    }
    const addressResultForPayload = validateAddress(addressTrimmedForPayload);
    if (!addressResultForPayload.valid) {
      const alertEl = document.getElementById("sales-alert");
      if (alertEl) {
        alertEl.textContent = addressResultForPayload.message;
        alertEl.className = "alert alert-warning py-2 small";
        alertEl.classList.remove("d-none");
      }
      if (addressInputForPayload) {
        addressInputForPayload.classList.add("is-invalid");
        const errEl = document.getElementById("sale-address-error");
        if (errEl) errEl.textContent = addressResultForPayload.message;
      }
      showStep(1);
      return;
    }
  }
  const contactResultForPayload = validateAndNormalizeContact(contactRawForPayload);
  if (!contactResultForPayload.valid) {
    const alertEl = document.getElementById("sales-alert");
    if (alertEl) {
      alertEl.textContent = contactResultForPayload.message;
      alertEl.className = "alert alert-warning py-2 small";
      alertEl.classList.remove("d-none");
    }
    if (contactInputForPayload) {
      contactInputForPayload.classList.add("is-invalid");
      const errEl = document.getElementById("sale-contact-error");
      if (errEl) errEl.textContent = contactResultForPayload.message;
    }
    return;
  }
  const customerContactValue = contactResultForPayload.value;
  const receiptNumber = generateLocalReceiptNumber();
  const saleUuid = generateUuidV4();
  const changeFromReceived =
    amountReceivedRaw > amountPaidRounded
      ? Math.round((amountReceivedRaw - amountPaidRounded) * 100) / 100
      : null;

  const remainingBalance = Math.max(0, totalRounded - amountPaidRounded);
  let status = "unpaid";
  if (remainingBalance <= 0) status = "paid";
  else if (amountPaidRounded > 0 && remainingBalance > 0) status = "partial";

  fetch(SALES_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
    },
    body: JSON.stringify({
      customer_id: customerId || null,
      customer_name: customerName,
      customer_contact: customerContactValue,
      customer_address: addressTrimmedForPayload || undefined,
      transaction_type: "walk-in",
      items,
      payment_method: paymentMethod,
      amount_paid: amountPaidRounded,
      amount_received: amountReceivedRaw || undefined,
      change_amount: changeFromReceived != null ? changeFromReceived : undefined,
      reference_number: referenceNumber || undefined,
      // New sync-related identifiers (backend can store or ignore extras)
      sale_uuid: saleUuid,
      receipt_no: receiptNumber,
      receipt_number: receiptNumber,
      terminal_id: getTerminalPrefix(),
      total_amount: totalRounded,
      remaining_balance: remainingBalance,
      status,
      sale_date: new Date().toISOString(),
    }),
  })
    .then((r) => {
      if (!r.ok) return r.json().then((d) => Promise.reject(new Error(d.message || "Failed to create sale")));
      return r.json();
    })
    .then((data) => {
      const modalEl = document.getElementById("newSaleModal");
      if (modalEl) {
        const m = bootstrap.Modal.getInstance(modalEl);
        if (m) m.hide();
      }
      saleLineItems = [];
      const customerNameInput = document.getElementById("sale-customer-name");
      const customerName = customerNameInput ? customerNameInput.value.trim() : "";
      const saleData = { ...data.sale };
      if (!saleData.customer_name && customerName) {
        saleData.customer_name = customerName;
      }
      const amountReceived = amountReceivedRaw;
      const change = changeFromReceived;

      // Ensure saleData carries identifiers used for sync/receipts.
      if (!saleData.sale_uuid) saleData.sale_uuid = saleUuid;
      if (!saleData.receipt_no && saleData.receipt_number == null) {
        saleData.receipt_no = receiptNumber;
        saleData.receipt_number = receiptNumber;
      }
      if (!saleData.terminal_id) saleData.terminal_id = getTerminalPrefix();

      showReceipt(saleData, customerName, {
        amountReceived: amountReceived || undefined,
        change: change != null ? change : undefined,
      });

      // Remember mapping for future payment syncs.
      if (saleData.id) {
        rememberSaleUuidMapping(saleData.id, saleData.sale_uuid, saleData.receipt_no || saleData.receipt_number || receiptNumber);
      }

      // Queue sync operation to central (offline‑friendly).
      try {
        const itemsForSync = items.map((item) => {
          const match = saleLineItems.find((i) => i.product_id === item.product_id) || {};
          const price = match.price != null ? match.price : 0;
          const subtotal = price * item.quantity;
          return {
            product_id: item.product_id,
            quantity: item.quantity,
            price,
            subtotal,
          };
        });

        enqueueSyncOperation({
          entityType: "sale",
          operation: "create",
          entityId: saleData.id || null,
          localId: null,
          data: {
            sale_uuid: saleData.sale_uuid,
            receipt_no: saleData.receipt_no || saleData.receipt_number || receiptNumber,
            terminal_id: saleData.terminal_id || getTerminalPrefix(),
            customer_id: customerId || null,
            customer_name: saleData.customer_name || customerName,
            customer_contact: customerContactValue,
            customer_address: addressTrimmedForPayload || undefined,
            transaction_type: "walk-in",
            total_amount: totalRounded,
            amount_paid: amountPaidRounded,
            remaining_balance: remainingBalance,
            status,
            sale_date: saleData.sale_date || new Date().toISOString(),
            items: itemsForSync,
            payment_method: paymentMethod,
            reference_number: referenceNumber || undefined,
          },
        });
      } catch (_) {
        // If queuing fails, we still keep the local sale; sync can be retried later.
      }

      loadSales({});
      const alertEl = document.getElementById("sales-alert");
      if (alertEl) {
        alertEl.textContent = "Sale created successfully.";
        alertEl.className = "alert alert-success py-2 small";
        alertEl.classList.remove("d-none");
      }
    })
    .catch((err) => {
      const alertEl = document.getElementById("sales-alert");
      if (alertEl) {
        alertEl.textContent = err.message || "Failed to create sale.";
        alertEl.className = "alert alert-danger py-2 small";
        alertEl.classList.remove("d-none");
      }
    });
}

/** Company info for receipt header (customize as needed) */
const RECEIPT_COMPANY = {
  name: "D&M Sales Management",
  subtitle: "Construction Supplies",
  address: "Business Address Here",
  tin: "TIN: 000-000-000-000",
  contact: "Tel: (02) 1234-5678",
};

function showReceipt(sale, displayCustomerName, options = {}) {
  const content = document.getElementById("receipt-content");
  const saleIdEl = document.getElementById("receipt-sale-id");
  const customerName = sale.customer_name || displayCustomerName || "—";
  const paymentMethod = sale.payment_method || "cash";
  const paymentLabel = paymentMethod === "gcash" ? "GCash" : paymentMethod === "paymaya" ? "PayMaya" : paymentMethod === "credit" ? "Credit" : "Cash";
  const referenceNumber = sale.reference_number && String(sale.reference_number).trim() && (paymentMethod === "gcash" || paymentMethod === "paymaya")
    ? String(sale.reference_number).trim()
    : "";
  const orNumber = sale.or_number || sale.receipt_number || "";
  if (saleIdEl) saleIdEl.textContent = orNumber || sale.id;
  const totalAmount = Number(sale.total_amount || 0);
  const amountPaid = Number(sale.amount_paid || 0);
  const balance = Number(sale.remaining_balance || 0);
  const amountReceived =
    options.amountReceived != null
      ? Number(options.amountReceived)
      : sale.amount_received != null
      ? Number(sale.amount_received)
      : null;
  const changeAmount =
    options.change != null
      ? Number(options.change)
      : sale.change_amount != null
      ? Number(sale.change_amount)
      : amountReceived != null && amountReceived > amountPaid
      ? Math.round((amountReceived - amountPaid) * 100) / 100
      : null;

  let servedBy = "—";
  try {
    const userRaw = localStorage.getItem("sm_user");
    if (userRaw) {
      const user = JSON.parse(userRaw);
      if (user && user.name) servedBy = user.name;
    }
  } catch (_) {}
  const printedAt = new Date();
  const printedStr = printedAt.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

  if (content) {
    const items = (sale.items || [])
      .map(
        (i) =>
          `<tr><td class="receipt-desc">${escapeHtml(i.product_name || "")}</td><td class="text-end">${i.quantity}</td><td class="text-end receipt-currency">₱${Number(i.price || 0).toFixed(2)}</td><td class="text-end receipt-currency">₱${Number(i.subtotal || 0).toFixed(2)}</td></tr>`
      )
      .join("");

    content.innerHTML = `
      <div class="receipt-print">
        <header class="receipt-header">
          <h1 class="receipt-company-name">${escapeHtml(RECEIPT_COMPANY.name)}</h1>
          <p class="receipt-subtitle">${escapeHtml(RECEIPT_COMPANY.subtitle)}</p>
          <p class="receipt-company-info">${escapeHtml(RECEIPT_COMPANY.address)}</p>
          <p class="receipt-company-info">${escapeHtml(RECEIPT_COMPANY.tin)}</p>
          <p class="receipt-company-info">${escapeHtml(RECEIPT_COMPANY.contact)}</p>
          <hr class="receipt-hr" />
          <h2 class="receipt-title">OFFICIAL RECEIPT</h2>
          ${orNumber ? `<p class="receipt-or"><strong>OR No.</strong> ${escapeHtml(orNumber)}</p>` : ""}
        </header>

        <div class="receipt-meta">
          <p><strong>Sale #</strong> ${sale.id} &nbsp;&nbsp; <strong>Date:</strong> ${sale.sale_date ? new Date(sale.sale_date).toLocaleString() : ""}</p>
          <p><strong>Customer:</strong> ${escapeHtml(customerName)}</p>
          <p><strong>Payment:</strong> ${escapeHtml(paymentLabel)}${referenceNumber ? ` &nbsp;&nbsp; <strong>Ref:</strong> ${escapeHtml(referenceNumber)}` : ""}</p>
        </div>

        <table class="receipt-table">
          <thead><tr><th>Description</th><th class="text-end">Qty</th><th class="text-end">Unit Price</th><th class="text-end">Amount</th></tr></thead>
          <tbody>${items}</tbody>
        </table>

        <div class="receipt-totals">
          <div class="receipt-totals-row"><span>Subtotal (VAT Inclusive)</span><span class="receipt-currency">₱${totalAmount.toFixed(2)}</span></div>
          <hr class="receipt-totals-hr" />
          <div class="receipt-totals-row receipt-totals-grand"><span>TOTAL</span><span class="receipt-currency">₱${totalAmount.toFixed(2)}</span></div>
          <hr class="receipt-totals-hr" />
          ${
            amountReceived != null
              ? `<div class="receipt-totals-row"><span>Amount Received</span><span class="receipt-currency">₱${amountReceived.toFixed(
                  2
                )}</span></div>`
              : ""
          }
          <div class="receipt-totals-row"><span>Amount Paid</span><span class="receipt-currency">₱${amountPaid.toFixed(2)}</span></div>
          ${changeAmount != null ? `<div class="receipt-totals-row"><span>Change</span><span class="receipt-currency">₱${changeAmount.toFixed(2)}</span></div>` : ""}
          ${balance > 0 ? `<div class="receipt-totals-row"><span>Balance</span><span class="receipt-currency">₱${balance.toFixed(2)}</span></div>` : ""}
        </div>

        <footer class="receipt-footer">
          <p class="receipt-served">Served by: ${escapeHtml(servedBy)}</p>
          <p class="receipt-printed">Printed: ${escapeHtml(printedStr)}</p>
          <p class="receipt-thanks">Thank you for your purchase!</p>
          <p class="receipt-disclaimer">This receipt serves as proof of purchase.</p>
        </footer>
      </div>`;
  }

  const receiptModal = document.getElementById("receiptModal");
  if (receiptModal) {
    const m = new bootstrap.Modal(receiptModal);
    m.show();
  }
  const printBtn = document.getElementById("btn-print-receipt");
  if (printBtn) {
    printBtn.onclick = () => printReceiptInNewWindow();
  }
}

async function openReceiptForSale(saleId) {
  if (!saleId) return;
  try {
    const res = await fetch(`${SALES_API}/${encodeURIComponent(saleId)}`, {
      headers: authHeaders(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const alertEl = document.getElementById("sales-alert");
      if (alertEl) {
        alertEl.textContent = data.message || "Failed to load sale details for receipt.";
        alertEl.className = "alert alert-danger py-2 small";
        alertEl.classList.remove("d-none");
      }
      return;
    }
    const sale = data.sale || data;
    if (!sale) {
      const alertEl = document.getElementById("sales-alert");
      if (alertEl) {
        alertEl.textContent = "Sale details not found for this receipt.";
        alertEl.className = "alert alert-danger py-2 small";
        alertEl.classList.remove("d-none");
      }
      return;
    }
    const customerName = sale.customer_name || "";
    showReceipt(sale, customerName);
  } catch (err) {
    const alertEl = document.getElementById("sales-alert");
    if (alertEl) {
      alertEl.textContent = err.message || "Failed to load sale details for receipt.";
      alertEl.className = "alert alert-danger py-2 small";
      alertEl.classList.remove("d-none");
    }
  }
}

// Expose receipt opener globally so other pages (e.g. Payments) can reuse it.
if (typeof window !== "undefined") {
  window.openReceiptForSale = openReceiptForSale;
}

/** Open a new window as print preview: user sees the receipt, then clicks Print to open the printer dialog. */
function printReceiptInNewWindow() {
  const receiptEl = document.querySelector("#receipt-content .receipt-print");
  if (!receiptEl) {
    window.print();
    return;
  }
  const html = receiptEl.innerHTML;
  const printDoc = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Receipt – Print preview</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; padding: 0; font-family: system-ui, sans-serif; font-size: 12px; color: #1a1a1a; background: #e9ecef; }
    .preview-toolbar { background: #495057; color: #fff; padding: 10px 16px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; }
    .preview-toolbar h2 { margin: 0; font-size: 1rem; font-weight: 600; }
    .preview-toolbar .hint { font-size: 0.8rem; opacity: 0.9; }
    .preview-toolbar .actions { display: flex; gap: 8px; }
    .preview-toolbar button { padding: 6px 14px; border: none; border-radius: 4px; cursor: pointer; font-size: 0.9rem; font-weight: 500; }
    .preview-toolbar .btn-print { background: #0d6efd; color: #fff; }
    .preview-toolbar .btn-print:hover { background: #0b5ed7; }
    .preview-toolbar .btn-close { background: #6c757d; color: #fff; }
    .preview-toolbar .btn-close:hover { background: #5c636a; }
    .preview-page { background: #fff; margin: 16px auto; box-shadow: 0 2px 8px rgba(0,0,0,0.15); max-width: 210mm; }
    .receipt-print { max-width: 105mm; margin: 0 auto; padding: 8mm 10mm; }
    .receipt-header { text-align: center; margin-bottom: 10px; }
    .receipt-company-name { font-size: 1.25rem; font-weight: 700; margin: 0 0 2px 0; }
    .receipt-subtitle { font-size: 0.85rem; color: #555; margin: 0 0 4px 0; }
    .receipt-company-info { font-size: 0.8rem; color: #444; margin: 2px 0; }
    .receipt-hr { border: 0; border-top: 1px solid #ccc; margin: 6px auto; width: 80%; }
    .receipt-title { font-size: 1rem; font-weight: 700; margin: 2px 0; }
    .receipt-or { font-size: 0.9rem; margin: 2px 0 0 0; }
    .receipt-meta { margin-bottom: 8px; font-size: 0.85rem; }
    .receipt-meta p { margin: 2px 0; }
    .receipt-table { width: 100%; border-collapse: collapse; margin-bottom: 8px; font-size: 0.85rem; }
    .receipt-table th, .receipt-table td { padding: 3px 4px; border-bottom: 1px solid #e0e0e0; }
    .receipt-table th { text-align: left; font-weight: 600; background: #f8f9fa; }
    .receipt-table th.text-end, .receipt-table td.text-end { text-align: right; }
    .receipt-currency { white-space: nowrap; }
    .receipt-totals { margin: 6px 0 10px 0; font-size: 0.9rem; }
    .receipt-totals-row { display: flex; justify-content: space-between; padding: 2px 0; }
    .receipt-totals-row.receipt-totals-grand { font-size: 1rem; font-weight: 700; padding: 4px 0; }
    .receipt-totals-hr { border: 0; border-top: 1px dashed #999; margin: 2px 0; }
    .receipt-footer { margin-top: 10px; padding-top: 6px; border-top: 1px solid #ccc; font-size: 0.8rem; color: #555; text-align: center; }
    .receipt-footer p { margin: 2px 0; }
    .receipt-thanks { font-weight: 600; color: #1a1a1a; }
    .receipt-disclaimer { font-size: 0.7rem; color: #777; margin-top: 4px; }
    @media print {
      .preview-toolbar { display: none !important; }
      body { background: #fff; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      .preview-page { box-shadow: none; margin: 0; }
      @page { size: A4; margin: 10mm; }
    }
  </style>
</head>
<body>
  <div class="preview-toolbar">
    <div>
      <h2>Receipt – Print preview</h2>
      <span class="hint">This is what will be printed. Click Print to open the printer dialog.</span>
    </div>
    <div class="actions">
      <button type="button" class="btn-print" id="preview-print-btn">Print</button>
      <button type="button" class="btn-close" id="preview-close-btn">Close</button>
    </div>
  </div>
  <div class="preview-page">
    <div class="receipt-print">${html}</div>
  </div>
  <script>
    (function() {
      function doPrint() {
        window.print();
      }
      function doClose() {
        window.close();
      }
      window.onafterprint = function() { window.close(); };
      document.getElementById("preview-print-btn").onclick = doPrint;
      document.getElementById("preview-close-btn").onclick = doClose;
    })();
  <\/script>
</body>
</html>`;
  const w = window.open("", "_blank", "noopener,noreferrer,width=520,height=720,scrollbars=yes");
  if (!w) {
    window.print();
    return;
  }
  w.document.write(printDoc);
  w.document.close();
}

// ----- Sales list -----
const SALES_PAGE_SIZE = 50;
let allSales = []; // Current page (or accumulated pages) of sales
let salesHasMore = false;
let salesLoading = false;

function getSalesParams() {
  const searchInput = document.getElementById("sales-search");
  const statusSelect = document.getElementById("sales-filter-status");
  const q = searchInput ? (searchInput.value || "").trim() : "";
  const status = statusSelect ? (statusSelect.value || "").trim() : "";
  return { q, status };
}

function loadSales(opts = {}) {
  const { append = false } = opts;
  const params =
    opts.q !== undefined || opts.status !== undefined ? opts : getSalesParams();
  const q = params.q || "";
  const status = params.status || "";
  const offset = append ? allSales.length : 0;

  const tbody = document.getElementById("sales-tbody");
  if (!tbody) {
    console.warn("Sales tbody not found, retrying...");
    setTimeout(() => loadSales(opts), 100);
    return;
  }
  
  const token = getToken();
  if (!token) {
    console.warn("No auth token found");
    tbody.innerHTML =
      '<tr><td colspan="8" class="text-danger small">Authentication required. Please login.</td></tr>';
    return;
  }

  if (!append) {
    salesLoading = true;
    tbody.innerHTML =
      '<tr><td colspan="8" class="text-muted small">Loading sales…</td></tr>';
    allSales = [];
  } else {
    salesLoading = true;
  }

  const searchParams = new URLSearchParams();
  if (q) searchParams.set("q", q);
  if (status) searchParams.set("status", status.toLowerCase());
  searchParams.set("limit", String(SALES_PAGE_SIZE));
  searchParams.set("offset", String(offset));
  const url = `${SALES_API}?${searchParams.toString()}`;

  fetch(url, { headers: authHeaders() })
    .then((r) => {
      if (!r.ok) {
        throw new Error(`HTTP ${r.status}: ${r.statusText}`);
      }
      return r.json();
    })
    .then((data) => {
      salesLoading = false;
      const sales = data.sales || [];
      const total = data.total ?? sales.length;
      const hasMore = data.hasMore === true;
      salesHasMore = hasMore;

      const normalized = (sales || []).map((s) => ({
        ...s,
        issueState: s.has_open_issue ? "open" : s.issueState || "none",
      }));

      allSales = append ? allSales.concat(normalized) : normalized;

      if (allSales.length === 0) {
        tbody.innerHTML =
          '<tr><td colspan="8" class="text-muted small">No sales found.</td></tr>';
        return;
      }
      renderSales(allSales);

      const loadMoreEl = document.getElementById("sales-load-more");
      if (loadMoreEl) {
        if (hasMore) {
          loadMoreEl.classList.remove("d-none");
          loadMoreEl.textContent = `Showing ${allSales.length} of ${total} — scroll for more`;
        } else if (allSales.length > 0 && total > allSales.length) {
          loadMoreEl.classList.remove("d-none");
          loadMoreEl.textContent = `Showing latest ${allSales.length} of ${total} sales`;
        } else {
          loadMoreEl.classList.add("d-none");
        }
      }
    })
    .catch((err) => {
      salesLoading = false;
      console.error("Failed to load sales:", err);
      tbody.innerHTML = `<tr><td colspan="8" class="text-danger small">Failed to load sales: ${
        err.message || "Unknown error"
      }</td></tr>`;
    });
}

function renderSales(sales) {
  const tbody = document.getElementById("sales-tbody");
  if (!tbody) return;

  // Always show flagged (open issue) sales first, keeping backend order otherwise
  const orderedSales = (sales || []).slice().sort((a, b) => {
    const aIssue = a.issueState || (a.has_open_issue ? "open" : "none");
    const bIssue = b.issueState || (b.has_open_issue ? "open" : "none");
    const aFlag = aIssue === "open";
    const bFlag = bIssue === "open";
    if (aFlag === bFlag) return 0;
    return aFlag ? -1 : 1;
  });

  tbody.innerHTML = orderedSales
    .map((s) => {
      const transactionType = s.transaction_type || "";
      const transactionTypeBadge =
        transactionType === "walk-in"
          ? '<span class="badge bg-info me-1">Walk-in</span>'
          : transactionType === "online"
          ? '<span class="badge bg-primary me-1">Online</span>'
          : "";

      const statusBadgeClass =
        s.status === "paid"
          ? "success"
          : s.status === "partial"
          ? "warning"
          : "secondary";

      const issueState = s.issueState || (s.has_open_issue ? "open" : "none");
      let flagColorClass = "text-secondary";
      if (issueState === "open") flagColorClass = "text-danger";
      else if (issueState === "resolved") flagColorClass = "text-success";

      const flagButton = `
        <button type="button" class="btn btn-sm btn-link p-0 me-1 ${flagColorClass}" data-action="flag-sale" data-sale-id="${s.id}" title="Flag issue">
          <i class="bi bi-flag-fill"></i>
        </button>`;

      const dropdown =
        isAdmin()
          ? `<div class="btn-group">
              <button type="button" class="btn btn-outline-secondary btn-sm dropdown-toggle" data-bs-toggle="dropdown" aria-expanded="false">
                Details
              </button>
              <ul class="dropdown-menu dropdown-menu-end">
                <li>
                  <button class="dropdown-item" type="button" data-action="review-issues" data-sale-id="${s.id}">
                    <i class="bi bi-clipboard-check"></i> View status & history…
                  </button>
                </li>
              </ul>
            </div>`
          : "";

      const isFlaggedOpen = issueState === "open";
      const rowClasses = isFlaggedOpen ? "sale-issue-open" : "";
      const rowAttrs = [
        `data-sale-id="${s.id}"`,
        issueState ? `data-issue-state="${issueState}"` : "",
        isFlaggedOpen ? 'data-kanban-group="Flagged"' : "",
      ]
        .filter(Boolean)
        .join(" ");

      const saleNoDisplay = (s.or_number || s.receipt_number || s.id);
      return `<tr${rowClasses ? ` class="${rowClasses}"` : ""} ${rowAttrs}>
          <td>${escapeHtml(String(saleNoDisplay))}</td>
          <td>${transactionTypeBadge}${escapeHtml(s.customer_name || "—")}</td>
          <td>₱${Number(s.total_amount || 0).toFixed(2)}</td>
          <td>₱${Number(s.amount_paid || 0).toFixed(2)}</td>
          <td>₱${Number(s.remaining_balance || 0).toFixed(2)}</td>
          <td><span class="badge bg-${statusBadgeClass}">${escapeHtml(s.status || "")}</span></td>
          <td>${s.sale_date ? new Date(s.sale_date).toLocaleDateString() : ""}</td>
          <td class="text-end">
            <div class="d-inline-flex align-items-center">
              ${flagButton}
              <button type="button" class="btn btn-outline-secondary btn-sm me-1" data-action="reprint-receipt" data-sale-id="${s.id}" title="View / Reprint receipt">
                <i class="bi bi-receipt"></i>
              </button>
              ${dropdown}
            </div>
          </td>
        </tr>`;
    })
    .join("");

  // Ask the generic view-toggle helper to rebuild the currently active view
  // (table/card/kanban) so filters/search also affect non-table layouts.
  try {
    const section = document.querySelector('.data-view-section[data-view-id="sales"]');
    if (section && typeof CustomEvent === "function") {
      section.dispatchEvent(new CustomEvent("data-view:refresh"));
    }
  } catch (_) {
    // Ignore; table view still renders correctly.
  }
}

function applySalesFilter() {
  const { q, status } = getSalesParams();
  loadSales({ q, status, append: false });
}

// Sales search/filter functionality
let salesSearchTimeout = null;

document.addEventListener("input", (e) => {
  if (e.target.id === "sales-search") {
    if (salesSearchTimeout) clearTimeout(salesSearchTimeout);
    salesSearchTimeout = setTimeout(applySalesFilter, 300);
  }
});

document.addEventListener("click", (e) => {
  if (e.target.closest("#btn-sales-search")) {
    applySalesFilter();
  }
});

document.addEventListener("change", (e) => {
  if (e.target.id === "sales-filter-status") {
    applySalesFilter();
  }
});

// ----- Flag Issue: cashier/staff -----
let currentFlagSaleId = null;

function openFlagIssueModal(saleId) {
  currentFlagSaleId = saleId;
  const sale = allSales.find((s) => String(s.id) === String(saleId));
  const labelEl = document.getElementById("flag-issue-sale-label");
  const idInput = document.getElementById("flag-issue-sale-id");
  const reasonSelect = document.getElementById("flag-issue-reason");
  const noteInput = document.getElementById("flag-issue-note");
  const errorEl = document.getElementById("flag-issue-error");
  if (labelEl) {
    const saleNo = sale ? (sale.or_number || sale.receipt_number || sale.id) : saleId;
    const label = sale
      ? `${saleNo} – ${sale.customer_name || "Customer"}`
      : `#${saleId}`;
    labelEl.textContent = label;
  }
  if (idInput) idInput.value = String(saleId);
  if (reasonSelect) reasonSelect.value = "";
  if (noteInput) noteInput.value = "";
  if (errorEl) {
    errorEl.textContent = "";
    errorEl.classList.add("d-none");
  }
  const modalEl = document.getElementById("flagIssueModal");
  if (!modalEl) return;
  const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
  modal.show();
}

async function submitFlagIssue() {
  const saleId = currentFlagSaleId || document.getElementById("flag-issue-sale-id")?.value;
  const reasonSelect = document.getElementById("flag-issue-reason");
  const noteInput = document.getElementById("flag-issue-note");
  const errorEl = document.getElementById("flag-issue-error");
  if (!saleId || !reasonSelect) return;

  const reason = reasonSelect.value;
  const note = noteInput ? noteInput.value.trim() : "";
  if (!reason) {
    if (errorEl) {
      errorEl.textContent = "Please select a reason for flagging this sale.";
      errorEl.classList.remove("d-none");
    }
    return;
  }

  try {
    const res = await fetch(`${SALES_API}/${encodeURIComponent(saleId)}/issues`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(),
      },
      body: JSON.stringify({ reason, note }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data.message || "Failed to flag issue for this sale.";
      if (errorEl) {
        errorEl.textContent = msg;
        errorEl.classList.remove("d-none");
      }
      return;
    }

    // Mark this sale as having an open issue in memory and turn flag red
    allSales = allSales.map((s) =>
      String(s.id) === String(saleId)
        ? { ...s, has_open_issue: true, issueState: "open" }
        : s
    );
    renderSales(allSales);

    const modalEl = document.getElementById("flagIssueModal");
    if (modalEl) {
      const modal = bootstrap.Modal.getInstance(modalEl);
      if (modal) modal.hide();
    }
    const alertEl = document.getElementById("sales-alert");
    if (alertEl) {
      alertEl.textContent = "Issue flagged for this sale. An admin can now review it.";
      alertEl.className = "alert alert-warning py-2 small";
      alertEl.classList.remove("d-none");
    }
  } catch (err) {
    if (errorEl) {
      errorEl.textContent = err.message || "Failed to flag issue for this sale.";
      errorEl.classList.remove("d-none");
    }
  }
}

document.addEventListener("click", (e) => {
  const reprintBtn = e.target.closest(
    "button[data-action='reprint-receipt'][data-sale-id]"
  );
  if (reprintBtn) {
    const saleId = reprintBtn.getAttribute("data-sale-id");
    if (saleId) {
      openReceiptForSale(saleId);
    }
  }
  const flagBtn = e.target.closest("button[data-action='flag-sale'][data-sale-id]");
  if (flagBtn) {
    const saleId = flagBtn.getAttribute("data-sale-id");
    if (saleId) openFlagIssueModal(saleId);
  }
  if (e.target.closest("#btn-flag-issue-submit")) {
    submitFlagIssue();
  }
});

// ----- Review / Resolve Issues: admins only -----
let currentReviewSaleId = null;
let currentOpenIssueId = null;

async function openReviewIssuesModal(saleId) {
  if (!isAdmin()) {
    const alertEl = document.getElementById("sales-alert");
    if (alertEl) {
      alertEl.textContent = "Only admins can review and resolve flagged issues.";
      alertEl.className = "alert alert-danger py-2 small";
      alertEl.classList.remove("d-none");
    }
    return;
  }

  currentReviewSaleId = saleId;
  currentOpenIssueId = null;

  const sale = allSales.find((s) => String(s.id) === String(saleId));
  const saleLabelEl = document.getElementById("review-issue-sale-label");
  if (saleLabelEl) {
    const label = sale
      ? `#${sale.id} – ${sale.customer_name || "Customer"}`
      : `#${saleId}`;
    saleLabelEl.textContent = label;
  }

  const listEl = document.getElementById("review-issue-list");
  const errorEl = document.getElementById("review-issue-error");
  const openSummaryEl = document.getElementById("review-issue-open-summary");
  const noOpenEl = document.getElementById("review-issue-no-open");
  const resolveSectionEl = document.getElementById("review-issue-resolve-section");
  if (errorEl) {
    errorEl.textContent = "";
    errorEl.classList.add("d-none");
  }
  if (openSummaryEl) openSummaryEl.textContent = "";
  if (noOpenEl) noOpenEl.classList.add("d-none");
  if (resolveSectionEl) resolveSectionEl.classList.remove("d-none");

  try {
    const res = await fetch(`${SALES_API}/${encodeURIComponent(saleId)}/issues`, {
      headers: authHeaders(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data.message || "Failed to load issues for this sale.";
      if (errorEl) {
        errorEl.textContent = msg;
        errorEl.classList.remove("d-none");
      }
      return;
    }
    const issues = Array.isArray(data.issues) ? data.issues : [];

    if (listEl) {
      if (!issues.length) {
        listEl.innerHTML =
          '<p class="text-muted small mb-0">No issues have been flagged for this sale yet.</p>';
      } else {
        listEl.innerHTML = issues
          .map((iss) => {
            const createdAt = iss.created_at
              ? new Date(iss.created_at).toLocaleString()
              : "";
            const resolvedAt = iss.resolved_at
              ? new Date(iss.resolved_at).toLocaleString()
              : "";
            const statusBadgeClass =
              iss.status === "open"
                ? "danger"
                : iss.status === "voided" || iss.status === "refunded"
                ? "secondary"
                : "success";
            const statusLabel =
              iss.status === "voided"
                ? "Resolved – voided"
                : iss.status === "refunded"
                ? "Resolved – refunded"
                : iss.status === "resolved"
                ? "Resolved"
                : "Open";
            const reasonLabel =
              iss.reason === "wrong_item"
                ? "Wrong item"
                : iss.reason === "pricing_error"
                ? "Pricing error"
                : iss.reason === "duplicate"
                ? "Duplicate transaction"
                : iss.reason === "payment_issue"
                ? "Payment issue"
                : "Other";
            return `
              <div class="border rounded-3 p-2 mb-2">
                <div class="d-flex justify-content-between align-items-center mb-1">
                  <div class="small">
                    <span class="fw-semibold">${reasonLabel}</span>
                    <span class="text-muted"> – flagged by ${
                      iss.cashier_name || `User #${iss.cashier_id}`
                    }</span>
                  </div>
                  <span class="badge bg-${statusBadgeClass}">${statusLabel}</span>
                </div>
                <div class="small text-muted mb-1">Flagged: ${createdAt}</div>
                ${
                  iss.note
                    ? `<div class="small mb-1"><strong>Note:</strong> ${escapeHtml(
                        iss.note
                      )}</div>`
                    : ""
                }
                ${
                  iss.resolution_note
                    ? `<div class="small mt-1 border-top pt-1">
                        <div><strong>Resolved by:</strong> ${
                          iss.resolved_by_admin_name ||
                          (iss.resolved_by_admin_id
                            ? `Admin #${iss.resolved_by_admin_id}`
                            : "Admin")
                        }</div>
                        <div><strong>Resolved at:</strong> ${resolvedAt}</div>
                        <div><strong>Resolution:</strong> ${escapeHtml(
                          iss.resolution_note
                        )}</div>
                      </div>`
                    : ""
                }
              </div>
            `;
          })
          .join("");
      }
    }

    const openIssue = issues.find((iss) => iss.status === "open");
    currentOpenIssueId = openIssue ? openIssue.issue_id : null;
    if (!openIssue) {
      if (resolveSectionEl) resolveSectionEl.classList.add("d-none");
      if (noOpenEl) noOpenEl.classList.remove("d-none");
    } else if (openSummaryEl) {
      const reasonLabel =
        openIssue.reason === "wrong_item"
          ? "Wrong item"
          : openIssue.reason === "pricing_error"
          ? "Pricing error"
          : openIssue.reason === "duplicate"
          ? "Duplicate transaction"
          : openIssue.reason === "payment_issue"
          ? "Payment issue"
          : "Other";
      openSummaryEl.textContent = `${reasonLabel} – flagged by ${
        openIssue.cashier_name || `User #${openIssue.cashier_id}`
      }`;
    }

    const modalEl = document.getElementById("reviewIssueModal");
    if (modalEl) {
      const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
      modal.show();
    }
  } catch (err) {
    if (errorEl) {
      errorEl.textContent = err.message || "Failed to load sale issues.";
      errorEl.classList.remove("d-none");
    }
  }
}

async function submitIssueResolution() {
  if (!isAdmin() || !currentReviewSaleId || !currentOpenIssueId) return;

  const actionSelect = document.getElementById("issue-resolution-action");
  const noteInput = document.getElementById("issue-resolution-note");
  const errorEl = document.getElementById("review-issue-error");
  if (!actionSelect || !noteInput) return;

  const action = actionSelect.value || "resolved";
  const note = noteInput.value.trim();
  if (!note) {
    if (errorEl) {
      errorEl.textContent = "Resolution note is required.";
      errorEl.classList.remove("d-none");
    }
    return;
  }

  let status = "resolved";
  if (action === "void") status = "voided";
  else if (action === "refund") status = "refunded";

  try {
    const res = await fetch(
      `${SALES_API}/${encodeURIComponent(
        currentReviewSaleId
      )}/issues/${encodeURIComponent(currentOpenIssueId)}`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders(),
        },
        body: JSON.stringify({
          resolution_note: note,
          resolution_action: action,
          status,
        }),
      }
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data.message || "Failed to save resolution.";
      if (errorEl) {
        errorEl.textContent = msg;
        errorEl.classList.remove("d-none");
      }
      return;
    }

    // Once resolved, clear open flag for this sale and turn flag green
    allSales = allSales.map((s) =>
      String(s.id) === String(currentReviewSaleId)
        ? { ...s, has_open_issue: false, issueState: "resolved" }
        : s
    );
    renderSales(allSales);

    const modalEl = document.getElementById("reviewIssueModal");
    if (modalEl) {
      const modal = bootstrap.Modal.getInstance(modalEl);
      if (modal) modal.hide();
    }

    const alertEl = document.getElementById("sales-alert");
    if (alertEl) {
      alertEl.textContent = "Issue resolution saved.";
      alertEl.className = "alert alert-success py-2 small";
      alertEl.classList.remove("d-none");
    }
  } catch (err) {
    if (errorEl) {
      errorEl.textContent = err.message || "Failed to save resolution.";
      errorEl.classList.remove("d-none");
    }
  }
}

document.addEventListener("click", (e) => {
  const reviewBtn = e.target.closest(
    "button[data-action='review-issues'][data-sale-id]"
  );
  if (reviewBtn) {
    const saleId = reviewBtn.getAttribute("data-sale-id");
    if (saleId) openReviewIssuesModal(saleId);
  }
  if (e.target.closest("#btn-issue-resolve")) {
    submitIssueResolution();
  }
});

// Function to check and load sales if on sales page
function checkAndLoadIfSalesPage() {
  const tbody = document.getElementById("sales-tbody");
  if (tbody && document.body?.dataset.page === "sales") {
    loadSales({});
  }
}

// Immediate check if script loads after DOM is ready
if (document.readyState !== "loading") {
  setTimeout(checkAndLoadIfSalesPage, 100);
}

// Simple initialization on page load - exact same approach as users.js
window.addEventListener("DOMContentLoaded", () => {
  checkAndLoadIfSalesPage();
});

// Handle pjax navigation - load data when navigating to sales page
window.addEventListener("pjax:complete", (e) => {
  if (e.detail && e.detail.page === "sales") {
    setTimeout(() => {
      loadSales({});
    }, 100);
  }
});

// Watch for data-page attribute changes (handles all navigation scenarios)
// Set up observer after DOM is ready
function setupSalesPageObserver() {
  if (!document.body) {
    setTimeout(setupSalesPageObserver, 50);
    return;
  }
  
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === "attributes" && mutation.attributeName === "data-page") {
        if (document.body.dataset.page === "sales") {
          setTimeout(() => {
            loadSales({});
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

// Set up observer
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", setupSalesPageObserver);
} else {
  setupSalesPageObserver();
}

// Also watch for main content changes (pjax swaps the main element)
function setupSalesMainObserver() {
  const main = document.querySelector("main");
  if (!main) {
    setTimeout(setupSalesMainObserver, 50);
    return;
  }
  
  const observer = new MutationObserver((mutations) => {
    // Check if we're on sales page and main content changed
    if (document.body?.dataset.page === "sales") {
      const tbody = document.getElementById("sales-tbody");
      if (tbody) {
        const firstRow = tbody.querySelector("tr");
        // If showing "Loading" or empty, reload
        if (!firstRow || firstRow.textContent.includes("Loading")) {
          setTimeout(() => {
            loadSales({});
          }, 100);
        }
      }
    }
  });
  
  observer.observe(main, {
    childList: true,
    subtree: false
  });
}

// Set up main observer
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", setupSalesMainObserver);
} else {
  setupSalesMainObserver();
}

// If navigated from the admin "Sale issues" modal with a specific saleId, auto-open its issues modal for admins.
function maybeOpenIssueFromQuery() {
  try {
    const params = new URLSearchParams(window.location.search || "");
    const saleId = params.get("saleId");
    const focusIssue = params.get("focusIssue");
    if (!saleId || focusIssue !== "1") return;
    if (!isAdmin()) return;
    // Give the page a short time to render before opening
    setTimeout(() => {
      openReviewIssuesModal(saleId);
    }, 300);
  } catch {
    // Ignore query parsing errors
  }
}

if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", maybeOpenIssueFromQuery);
} else {
  maybeOpenIssueFromQuery();
}

// Confirm before closing the receipt modal so cashiers don't accidentally lose it
document.addEventListener("hide.bs.modal", (event) => {
  const target = event.target;
  if (!target || target.id !== "receiptModal") return;
  const ok = window.confirm("Are you sure you want to close this receipt?");
  if (!ok) {
    event.preventDefault();
  }
});
