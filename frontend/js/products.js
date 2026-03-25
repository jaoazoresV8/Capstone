import { API_ORIGIN } from "./config.js";
const PRODUCTS_API = `${API_ORIGIN}/api/products`;
const PRODUCTS_REORDER_EMAIL_API = (id) => `${PRODUCTS_API}/${encodeURIComponent(id)}/reorder-email`;
const SUPPLIERS_API = `${API_ORIGIN}/api/suppliers`;
const SETTINGS_API = `${API_ORIGIN}/api/settings`;

function getToken() {
  return localStorage.getItem("sm_token");
}

function authHeaders() {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function getProductsTbody() {
  return document.getElementById("products-tbody");
}
function getProductsAlert() {
  return document.getElementById("products-alert");
}
const alertEl = null;

function showAlert(message, type) {
  const el = getProductsAlert();
  if (!el) return;
  el.textContent = message;
  el.className = `alert alert-${type || "info"} py-2 small`;
  el.classList.remove("d-none");
}

function clearAlert() {
  const el = getProductsAlert();
  if (el) el.classList.add("d-none");
}

function promptTextInput({ title, defaultValue = "", placeholder = "" } = {}) {
  const modalWrapperId = "categoryPromptModalWrapper";
  const modalId = "categoryPromptModal";
  const inputId = "categoryPromptInput";
  const okBtnId = "categoryPromptOkBtn";
  const cancelBtnId = "categoryPromptCancelBtn";

  return new Promise((resolve) => {
    // Inject styles once per page for a consistent, polished modal look.
    const STYLE_ID = "dmCategoryPromptModalStyles";
    if (!document.getElementById(STYLE_ID)) {
      const styleEl = document.createElement("style");
      styleEl.id = STYLE_ID;
      styleEl.textContent = `
#categoryPromptModalWrapper .dm-category-prompt-content {
  border-radius: 16px;
  border: 1px solid rgba(13,110,253,0.25);
  box-shadow: 0 18px 45px rgba(2,6,23,0.28);
  overflow: hidden;
}
#categoryPromptModalWrapper .dm-category-prompt-header {
  background: linear-gradient(135deg, rgba(13,110,253,1) 0%, rgba(79,70,229,1) 100%);
  color: #fff;
  border-bottom: 1px solid rgba(255,255,255,0.18);
  padding: 0.75rem 1rem;
}
#categoryPromptModalWrapper .dm-category-prompt-header .modal-title {
  font-weight: 800;
  letter-spacing: 0.01em;
}
#categoryPromptModalWrapper .dm-category-prompt-close.btn-close {
  filter: brightness(100);
  opacity: 0.95;
}
#categoryPromptModalWrapper .dm-category-prompt-body {
  padding: 1rem;
}
#categoryPromptModalWrapper .dm-category-prompt-help {
  margin-bottom: 0.65rem;
  color: rgba(15,23,42,0.62);
}
#categoryPromptModalWrapper .dm-category-prompt-input {
  border-radius: 12px;
  border: 1px solid rgba(148,163,184,0.75);
  padding: 0.6rem 0.85rem;
  background: rgba(248,250,252,1);
}
#categoryPromptModalWrapper .dm-category-prompt-input:focus {
  border-color: rgba(13,110,253,0.65);
  box-shadow: 0 0 0 0.25rem rgba(13,110,253,0.18);
  background: #fff;
}
#categoryPromptModalWrapper .dm-category-prompt-ok {
  border-radius: 12px;
  font-weight: 700;
  padding: 0.55rem 0.95rem;
}
#categoryPromptModalWrapper .dm-category-prompt-cancel {
  border-radius: 12px;
  padding: 0.55rem 0.95rem;
}
#categoryPromptModalWrapper .dm-category-prompt-modal.show .modal-dialog {
  animation: dmCategoryPromptIn 180ms cubic-bezier(0.2, 0.9, 0.2, 1);
}
@keyframes dmCategoryPromptIn {
  from { opacity: 0; transform: translateY(10px) scale(0.98); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
`;
      document.head.appendChild(styleEl);
    }

    let wrapper = document.getElementById(modalWrapperId);
    if (!wrapper || !wrapper.querySelector(".dm-category-prompt-content")) {
      if (!wrapper) {
        wrapper = document.createElement("div");
        wrapper.id = modalWrapperId;
      }
      wrapper.innerHTML = `
        <div class="modal fade dm-category-prompt-modal" id="${modalId}" tabindex="-1" aria-hidden="true">
          <div class="modal-dialog modal-dialog-centered">
            <div class="modal-content dm-category-prompt-content">
              <div class="modal-header dm-category-prompt-header">
                <h5 class="modal-title" id="categoryPromptModalLabel">
                  <i class="bi bi-tags-fill me-2"></i>
                  <span>Input</span>
                </h5>
                <button type="button" class="dm-category-prompt-close btn-close btn-close-white" data-bs-dismiss="modal" aria-label="Close"></button>
              </div>
              <div class="modal-body dm-category-prompt-body">
                <div class="dm-category-prompt-help small">Type a category name and press <b>Enter</b>.</div>
                <input
                  type="text"
                  class="form-control dm-category-prompt-input"
                  id="${inputId}"
                  autocomplete="off"
                  placeholder="${placeholder}"
                />
              </div>
              <div class="modal-footer" style="justify-content: flex-end; padding: 0.85rem 1rem;">
                <button type="button" class="btn btn-outline-secondary dm-category-prompt-cancel" data-bs-dismiss="modal" id="${cancelBtnId}">Cancel</button>
                <button type="button" class="btn btn-primary dm-category-prompt-ok" id="${okBtnId}">OK</button>
              </div>
            </div>
          </div>
        </div>
      `;
      if (!wrapper.parentNode) document.body.appendChild(wrapper);
    }

    const modalEl = document.getElementById(modalId);
    if (!modalEl) return resolve(null);

    const labelEl = document.getElementById("categoryPromptModalLabel");
    const inputEl = document.getElementById(inputId);
    const okBtn = document.getElementById(okBtnId);
    const cancelBtn = document.getElementById(cancelBtnId);
    if (!labelEl || !inputEl || !okBtn || !cancelBtn) return resolve(null);

    const labelTextEl = labelEl.querySelector("span") || labelEl;
    labelTextEl.textContent = title || "Input";
    inputEl.placeholder = placeholder || "";
    inputEl.value = defaultValue || "";

    // Focus after modal is attached/visible
    try {
      inputEl.focus();
      inputEl.select?.();
    } catch {}

    const modal = new bootstrap.Modal(modalEl, { backdrop: "static" });
    let settled = false;
    const settle = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };

    const onOk = () => {
      const v = String(inputEl.value || "").trim();
      modal.hide();
      settle(v || null);
    };
    const onCancel = () => {
      modal.hide();
      settle(null);
    };

    const updateOkDisabled = () => {
      const v = String(inputEl.value || "").trim();
      okBtn.disabled = v.length === 0;
    };
    updateOkDisabled();

    okBtn.onclick = onOk;
    cancelBtn.onclick = onCancel;
    okBtn.disabled = okBtn.disabled || false;
    inputEl.oninput = updateOkDisabled;
    inputEl.onkeydown = (e) => {
      if (e.key === "Enter") okBtn.click();
      if (e.key === "Escape") cancelBtn.click();
    };

    modalEl.addEventListener(
      "hidden.bs.modal",
      () => {
        if (!settled) settle(null);
      },
      { once: true }
    );

    modal.show();
  });
}

const PRODUCTS_PAGE_SIZE = 20;

let allProducts = []; 
let globalMarkupPercent = 10; 
let productsHasMore = false;
let productsLoading = false;

let productCategories = [];

function isCurrentUserAdmin() {
  const raw = localStorage.getItem("sm_user");
  if (!raw) return false;
  try {
    const user = JSON.parse(raw);
    return !!user && user.role === "admin";
  } catch {
    return false;
  }
}

function computeProductCategories(list) {
  const set = new Set();
  (list || []).forEach((p) => {
    const cat = (p.category || "").trim();
    if (cat) set.add(cat);
  });
  productCategories = Array.from(set).sort((a, b) => a.localeCompare(b));
}

function renderProductCategoryFilterOptions() {
  const select = document.getElementById("product-filter-category");
  if (!select) return;
  const current = select.value;
  select.innerHTML =
    '<option value="">All categories</option>' +
    productCategories.map((c) => `<option value="${c}">${c}</option>`).join("");
  if (current && productCategories.includes(current)) {
    select.value = current;
  }
}

function renderProductCategoryOptions() {
  const select = document.getElementById("product-category");
  if (!select) return;
  const current = select.value;
  const previous = select.getAttribute("data-prev") || "";
  const desiredValue = current || previous || "";

  select.innerHTML = '<option value="">Select category…</option>' + productCategories.map((c) => `<option value="${c}">${c}</option>`).join("");

  if (desiredValue && productCategories.includes(desiredValue)) {
    select.value = desiredValue;
  } else {
    select.value = "";
  }
}

function setProductCategoryValue(category) {
  const select = document.getElementById("product-category");
  if (!select) return;
  const cat = (category || "").trim();
  select.setAttribute("data-prev", cat);
  if (cat && !productCategories.includes(cat)) {
    productCategories.push(cat);
    productCategories.sort((a, b) => a.localeCompare(b));
  }
  renderProductCategoryOptions();
  if (cat) select.value = cat;
}

function getProductsParams() {
  const q = document.getElementById("product-search-filter")?.value?.trim() ?? "";
  const category = document.getElementById("product-filter-category")?.value?.trim() ?? "";
  const filter = document.getElementById("product-filter-today")?.value ?? "";
  const sort = document.getElementById("product-sort")?.value ?? "name_asc";
  return { q, category, filter, sort };
}

function loadProducts(opts = {}) {
  const { append = false } = opts;
  const params = opts.q !== undefined ? opts : getProductsParams();
  const q = params.q ?? "";
  const category = params.category ?? "";
  const filter = params.filter ?? "";
  const sort = params.sort ?? "name_asc";
  const offset = append ? allProducts.length : 0;

  const tbody = getProductsTbody();
  if (!tbody) {
    console.warn("Products tbody not found, retrying...");
    setTimeout(() => loadProducts(opts), 100);
    return Promise.resolve({ list: [], total: 0, hasMore: false });
  }

  const token = getToken();
  if (!token) {
    console.warn("No auth token found");
    tbody.innerHTML = '<tr><td colspan="6" class="text-danger small">Authentication required. Please login.</td></tr>';
    return Promise.resolve({ list: [], total: 0, hasMore: false });
  }

  if (!append) {
    productsLoading = true;
    tbody.innerHTML = '<tr><td colspan="6" class="text-muted small">Loading products…</td></tr>';
    allProducts = [];
  } else {
    productsLoading = true;
    const loadMoreEl = document.getElementById("products-load-more");
    if (loadMoreEl) {
      loadMoreEl.classList.remove("d-none");
      loadMoreEl.textContent = "Loading more…";
    }
  }

  const searchParams = new URLSearchParams();
  if (q) searchParams.set("q", q);
  if (category) searchParams.set("category", category);
  if (filter === "today") searchParams.set("filter", "today");
  searchParams.set("sort", sort);
  searchParams.set("limit", String(PRODUCTS_PAGE_SIZE));
  searchParams.set("offset", String(offset));
  const url = `${PRODUCTS_API}?${searchParams.toString()}`;

  return fetch(url, { headers: authHeaders() })
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${r.statusText}`);
      return r.json();
    })
    .then((data) => {
      productsLoading = false;
      const list = data.products || [];
      const total = data.total ?? 0;
      const hasMore = data.hasMore === true;
      productsHasMore = hasMore;

      if (append) {
        allProducts = allProducts.concat(list);
        appendProductRows(list);
      } else {
        allProducts = list;
        if (list.length === 0) {
          tbody.innerHTML = '<tr><td colspan="6" class="text-muted small">No products found. Try different search or filters.</td></tr>';
        } else {
          renderProducts(list);
        }
      }

      computeProductCategories(allProducts);
      renderProductCategoryOptions();
      renderProductCategoryFilterOptions();

      const loadMoreEl = document.getElementById("products-load-more");
      if (loadMoreEl) {
        if (hasMore) {
          loadMoreEl.classList.remove("d-none");
          loadMoreEl.textContent = `Showing ${allProducts.length} of ${total} — scroll for more`;
        } else if (allProducts.length > 0) {
          loadMoreEl.classList.remove("d-none");
          loadMoreEl.textContent = total <= PRODUCTS_PAGE_SIZE ? "" : `All ${total} products loaded`;
        } else {
          loadMoreEl.classList.add("d-none");
        }
      }
      return { list: allProducts, total, hasMore };
    })
    .catch((err) => {
      productsLoading = false;
      console.error("Failed to load products:", err);
      if (!append) {
        tbody.innerHTML = `<tr><td colspan="6" class="text-danger small">Failed to load products: ${err.message || "Unknown error"}</td></tr>`;
      }
      const loadMoreEl = document.getElementById("products-load-more");
      if (loadMoreEl) loadMoreEl.classList.add("d-none");
      return { list: allProducts, total: 0, hasMore: false };
    });
}

function appendProductRows(products) {
  const tbody = getProductsTbody();
  if (!tbody || !products.length) return;

  const selectedCategory =
    document.getElementById("product-filter-category")?.value?.trim() ?? "";
  const visibleProducts = selectedCategory
    ? products.filter(
        (p) => (p.category || "").trim() === selectedCategory
      )
    : products;
  if (!visibleProducts.length) return;

  const fragment = visibleProducts
    .map((p) => {
      const hasSupplier = p.supplier_id != null;
      const stockQty = Number(p.stock_quantity ?? 0);
      const isLowStock = stockQty <= 10;
      const reorderBtnClass = isLowStock ? "btn-outline-danger" : "btn-outline-warning";
      const reorderBtn = hasSupplier
        ? `<button type="button" class="btn ${reorderBtnClass} btn-sm" data-action="reorder-product" data-product-id="${p.id}" title="Reorder via email to supplier"><i class="bi bi-arrow-repeat"></i></button>`
        : "";
      const supplierCell = hasSupplier
        ? `<span class="d-inline-flex align-items-center gap-1">
             <span>${escapeHtml(p.supplier_name || "—")}</span>
             <button type="button" class="btn btn-link btn-sm p-0 text-secondary" data-action="show-supplier-info" data-supplier-id="${p.supplier_id}" title="View contact &amp; address">
               <i class="bi bi-plus-lg"></i>
             </button>
           </span>`
        : escapeHtml(p.supplier_name || "—");
      return `<tr data-product-id="${p.id}">
        <td>${escapeHtml(p.name || "—")}</td>
        <td>${escapeHtml(p.category || "—")}</td>
        <td>${supplierCell}</td>
        <td>${p.stock_quantity ?? 0}</td>
        <td>₱${Number(p.selling_price ?? 0).toFixed(2)}</td>
        <td>
          <button type="button" class="btn btn-link btn-sm p-0 text-secondary me-1" data-action="show-record-info" data-product-id="${p.id}" title="When &amp; who recorded">
            <i class="bi bi-clock-history"></i>
          </button>
          ${reorderBtn}
          <button type="button" class="btn btn-outline-primary btn-sm" data-action="edit-product" data-product-id="${p.id}" title="Edit Product">
            <i class="bi bi-pencil-square"></i>
          </button>
        </td>
      </tr>`;
    })
    .join("");
  tbody.insertAdjacentHTML("beforeend", fragment);

  // Ask the view-toggle helper to refresh card/kanban views for products.
  try {
    const section = document.querySelector('.data-view-section[data-view-id="products"]');
    if (section && typeof CustomEvent === "function") {
      section.dispatchEvent(new CustomEvent("data-view:refresh"));
    }
  } catch (_) {
    // Ignore; table view still renders correctly.
  }
}

function renderProducts(products) {
  const tbody = getProductsTbody();
  if (!tbody) return;

  const selectedCategory =
    document.getElementById("product-filter-category")?.value?.trim() ?? "";
  const visibleProducts = selectedCategory
    ? products.filter(
        (p) => (p.category || "").trim() === selectedCategory
      )
    : products;

  tbody.innerHTML = visibleProducts
    .map(
      (p) => {
        const supplierName = p.supplier_name || "—";
        const hasSupplier = p.supplier_id != null;
        const stockQty = Number(p.stock_quantity ?? 0);
        const isLowStock = stockQty <= 10;
        const reorderBtnClass = isLowStock ? "btn-outline-danger" : "btn-outline-warning";
        const reorderBtn = hasSupplier
          ? `<button type="button" class="btn ${reorderBtnClass} btn-sm" data-action="reorder-product" data-product-id="${p.id}" title="Reorder via email to supplier"><i class="bi bi-arrow-repeat"></i></button>`
          : "";
        const supplierCell = hasSupplier
          ? `<span class="d-inline-flex align-items-center gap-1">
               <span>${escapeHtml(p.supplier_name || "—")}</span>
               <button type="button" class="btn btn-link btn-sm p-0 text-secondary" data-action="show-supplier-info" data-supplier-id="${p.supplier_id}" title="View contact &amp; address">
                 <i class="bi bi-plus-lg"></i>
               </button>
             </span>`
          : escapeHtml(supplierName);
        return `<tr data-product-id="${p.id}">
          <td>${escapeHtml(p.name || "—")}</td>
          <td>${escapeHtml(p.category || "—")}</td>
          <td>${supplierCell}</td>
          <td>${p.stock_quantity ?? 0}</td>
          <td>₱${Number(p.selling_price ?? 0).toFixed(2)}</td>
          <td>
            <button type="button" class="btn btn-link btn-sm p-0 text-secondary me-1" data-action="show-record-info" data-product-id="${p.id}" title="When &amp; who recorded">
              <i class="bi bi-clock-history"></i>
            </button>
            ${reorderBtn}
            <button type="button" class="btn btn-outline-primary btn-sm" data-action="edit-product" data-product-id="${p.id}" title="Edit Product">
              <i class="bi bi-pencil-square"></i>
            </button>
          </td>
        </tr>`;
      }
    )
    .join("");

  // Ask the view-toggle helper to refresh card/kanban views for products.
  try {
    const section = document.querySelector('.data-view-section[data-view-id="products"]');
    if (section && typeof CustomEvent === "function") {
      section.dispatchEvent(new CustomEvent("data-view:refresh"));
    }
  } catch (_) {
    // Ignore; table view still renders correctly.
  }
}

function applyProductsFilter() {
  loadProducts({ ...getProductsParams(), append: false });
}
let searchDebounceTimer = null;
function scheduleSearchApply() {
  if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    searchDebounceTimer = null;
    if (document.body?.dataset?.page === "products" && getProductsTbody()) {
      applyProductsFilter();
    }
  }, 380);
}

let cachedSuppliers = [];
let lastAutocompleteSuppliers = []; // exact list last shown (so click finds the item even if cache changed)
let supplierAutocompleteDebounce = null;

function clearSupplierFields() {
  const nameEl = document.getElementById("product-supplier-name");
  const contactEl = document.getElementById("product-supplier-contact");
  const addressEl = document.getElementById("product-supplier-address");
  const supplierPriceEl = document.getElementById("product-supplier-price");
  if (nameEl) nameEl.value = "";
  if (contactEl) contactEl.value = "";
  if (addressEl) addressEl.value = "";
  if (supplierPriceEl) supplierPriceEl.value = "0";
  const contactErrEl = document.getElementById("product-supplier-contact-error");
  if (contactErrEl) {
    contactErrEl.classList.add("d-none");
    contactErrEl.textContent = "";
  }
  const form = document.getElementById("product-form");
  if (form) form.dataset.supplierId = "";
  hideSupplierAutocomplete();
  updateSupplierDetailsErrorState();
  computeSellingPrice();
}

function fetchSuppliers(query = "") {
  const params = query ? `?q=${encodeURIComponent(query)}` : "";
  return fetch(`${SUPPLIERS_API}${params}`, { headers: authHeaders() })
    .then((r) => (r.ok ? r.json() : { suppliers: [] }))
    .then((data) => {
      cachedSuppliers = data.suppliers || [];
      return cachedSuppliers;
    })
    .catch(() => []);
}

function hideSupplierAutocomplete() {
  const ac = document.getElementById("product-supplier-autocomplete");
  if (ac) {
    ac.classList.add("d-none");
    ac.innerHTML = "";
  }
}

function showSupplierAutocomplete(items) {
  const ac = document.getElementById("product-supplier-autocomplete");
  if (!ac) return;
  if (!items || items.length === 0) {
    lastAutocompleteSuppliers = [];
    ac.classList.add("d-none");
    ac.innerHTML = "";
    return;
  }
  lastAutocompleteSuppliers = items.slice();
  ac.innerHTML = items
    .map(
      (s) =>
        `<button type="button" class="list-group-item list-group-item-action list-group-item-light small text-start" data-supplier-id="${Number(s.id)}">${escapeHtml(s.name || "—")}${(s.contact || s.address) ? " <span class=\"text-muted\">· " + escapeHtml([s.contact, s.address].filter(Boolean).join(" · ").slice(0, 50)) + "</span>" : ""}</button>`
    )
    .join("");
  ac.classList.remove("d-none");
}

function selectSupplierFromAutocomplete(supplierId, name, contact, address) {
  const nameEl = document.getElementById("product-supplier-name");
  const contactEl = document.getElementById("product-supplier-contact");
  const addressEl = document.getElementById("product-supplier-address");
  const form = document.getElementById("product-form");
  if (nameEl) nameEl.value = name || "";
  if (contactEl) contactEl.value = contact || "";
  if (addressEl) addressEl.value = address || "";
  if (form) form.dataset.supplierId = String(supplierId || "");
  hideSupplierAutocomplete();
  updateSupplierDetailsErrorState();
}

function getSupplierFromCache(id) {
  if (id == null || id === "") return null;
  const fromLast = lastAutocompleteSuppliers.find((s) => String(s.id) === String(id));
  if (fromLast) return fromLast;
  return cachedSuppliers.find((s) => String(s.id) === String(id)) || null;
}

function fetchSupplierById(id) {
  return fetch(`${SUPPLIERS_API}/${id}`, { headers: authHeaders() })
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => data?.supplier || null)
    .catch(() => null);
}

function isContactNumericOnly(val) {
  return /^\d*$/.test(val);
}

/** Phone must start with 09 and be exactly 11 digits. Returns normalized value (digits only, max 11, may prefix 09). */
function normalizePhoneInput(val) {
  const digits = val.replace(/\D/g, "");
  if (digits.length === 0) return "";
  let s = digits.slice(0, 11);
  if (s.length >= 1 && s[0] === "9") s = "0" + s.slice(0, 10);
  return s.slice(0, 11);
}

function isPhoneValid(val) {
  return /^09\d{9}$/.test(val);
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
    // In regular browsers, prefer same-tab navigation to avoid popup blockers
    // (especially when URL is opened after async supplier lookup).
    window.location.assign(url);
  } catch {}
}

function toWhatsAppPhoneDigitsPhilippines(phone09) {
  const digits = String(phone09 || "").replace(/\D/g, "");
  if (/^09\d{9}$/.test(digits)) return `63${digits.slice(1)}`;
  if (/^9\d{9}$/.test(digits)) return `63${digits}`;
  if (/^63\d{10}$/.test(digits)) return digits;
  return "";
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

function isTemporarilyUnavailableContact(contact) {
  const s = String(contact || "").trim();
  if (!s) return true;
  const lower = s.toLowerCase();
  if (lower === "no." || lower === "no" || lower === "n/a" || lower === "na" || lower === "none" || lower === "-") return true;
  return false;
}

function isValidEmailContact(contact) {
  if (isTemporarilyUnavailableContact(contact)) return false;
  const s = String(contact || "").trim();
  return s.includes("@");
}

function defaultReorderEmailText({ productName, stockQuantity }) {
  const product = productName || "the requested product";
  const stock = stockQuantity != null ? String(stockQuantity) : "0";
  return (
    `Hi,\n\n` +
    `We would like to reorder ${product}. Our current stock is ${stock}.\n\n` +
    `Please confirm availability, price, and lead time. Also let us know if there are any ordering requirements.\n\n` +
    `Thank you.`
  );
}

function openReorderModal(productId) {
  const modalEl = document.getElementById("reorderModal");
  const alertEl = document.getElementById("reorder-alert");
  const textEl = document.getElementById("reorder-email-text");
  const sendBtn = document.getElementById("btn-send-reorder-email");
  const waBtn = document.getElementById("btn-open-reorder-whatsapp");
  if (!modalEl || !alertEl || !textEl || !sendBtn || !waBtn) return;

  const product = allProducts.find((p) => String(p.id) === String(productId)) || null;
  if (!product) {
    alertEl.textContent = "Product not found.";
    alertEl.className = "alert alert-danger py-2 small";
    alertEl.classList.remove("d-none");
    sendBtn.disabled = true;
    waBtn.disabled = true;
    return;
  }

  modalEl.dataset.productId = String(productId);
  modalEl.dataset.subject = `Reorder request: ${product.name || "Product"}`;
  alertEl.className = "alert alert-info py-2 small d-none";
  alertEl.textContent = "";
  sendBtn.disabled = true;
  waBtn.disabled = true;
  textEl.value = defaultReorderEmailText({
    productName: product.name,
    stockQuantity: product.stock_quantity,
  });

  if (product.supplier_id != null) {
    fetch(`${SUPPLIERS_API}/${encodeURIComponent(product.supplier_id)}`, { headers: authHeaders() })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        const contact = data?.supplier?.contact ?? "";
        const emailAvailable = isValidEmailContact(contact);
        const phoneLocal = normalizePhoneInput(String(contact || ""));
        const phoneAvailable = isPhoneValid(phoneLocal);

        sendBtn.disabled = !emailAvailable;
        waBtn.disabled = !phoneAvailable;

        if (!emailAvailable && !phoneAvailable) {
          alertEl.textContent = "Temporarily not available";
          alertEl.className = "alert alert-warning py-2 small";
          alertEl.classList.remove("d-none");
          return;
        }

        const availabilityText = [
          emailAvailable ? "Email available" : null,
          phoneAvailable ? "WhatsApp available" : null,
        ]
          .filter(Boolean)
          .join(" · ");

        alertEl.textContent = availabilityText;
        alertEl.className = "alert alert-info py-2 small";
        alertEl.classList.remove("d-none");
      })
      .catch(() => {
        alertEl.textContent = "Failed to load supplier contact.";
        alertEl.className = "alert alert-danger py-2 small";
        alertEl.classList.remove("d-none");
        sendBtn.disabled = true;
        waBtn.disabled = true;
      });
  } else {
    alertEl.textContent = "No supplier assigned.";
    alertEl.className = "alert alert-warning py-2 small";
    alertEl.classList.remove("d-none");
    waBtn.disabled = true;
  }

  const m = new bootstrap.Modal(modalEl);
  m.show();
}

function updateContactInputBehavior() {
  const contactEl = document.getElementById("product-supplier-contact");
  if (!contactEl) return;
  const val = contactEl.value;
  if (!isContactNumericOnly(val)) return;
  const normalized = normalizePhoneInput(val);
  if (normalized !== val) contactEl.value = normalized;
  else if (val.length > 11) contactEl.value = val.slice(0, 11);
}

function validateContactAndShowError() {
  const contactEl = document.getElementById("product-supplier-contact");
  const errEl = document.getElementById("product-supplier-contact-error");
  if (!contactEl || !errEl) return true;
  const val = contactEl.value.trim();
  if (!val) {
    errEl.classList.add("d-none");
    errEl.textContent = "";
    return true;
  }
  if (isContactNumericOnly(val)) {
    const normalized = normalizePhoneInput(val);
    if (normalized !== val) contactEl.value = normalized;
    if (val.length > 11) contactEl.value = normalized;
    if (!isPhoneValid(contactEl.value)) {
      errEl.textContent = "Phone must start with 09 and be 11 digits (e.g. 09171234567).";
      errEl.classList.remove("d-none");
      errEl.setAttribute("aria-live", "polite");
      return false;
    }
    errEl.classList.add("d-none");
    errEl.textContent = "";
    return true;
  }
  // Non-numeric: treat as email, must contain @
  if (!val.includes("@")) {
    errEl.textContent = "Please enter a valid email (must contain @).";
    errEl.classList.remove("d-none");
    errEl.setAttribute("aria-live", "polite");
    return false;
  }
  errEl.classList.add("d-none");
  errEl.textContent = "";
  return true;
}

function updateSupplierDetailsErrorState() {
  const nameEl = document.getElementById("product-supplier-name");
  const contactEl = document.getElementById("product-supplier-contact");
  const addressEl = document.getElementById("product-supplier-address");
  const form = document.getElementById("product-form");
  const supplierId = form?.dataset.supplierId?.trim();
  const name = nameEl?.value?.trim() ?? "";
  const contact = contactEl?.value?.trim() ?? "";
  const address = addressEl?.value?.trim() ?? "";

  const isNewSupplier = name && !supplierId;
  const missingInfo = isNewSupplier && (!contact || !address);

  const errEl = document.getElementById("supplier-details-error");
  const dotEl = document.querySelector("#btn-supplier-details .supplier-details-error-dot");
  if (errEl) {
    if (missingInfo) {
      errEl.classList.remove("d-none");
      errEl.setAttribute("aria-live", "polite");
    } else {
      errEl.classList.add("d-none");
    }
  }
  if (dotEl) {
    if (missingInfo) dotEl.classList.remove("d-none");
    else dotEl.classList.add("d-none");
  }
}

function validateSupplierDetailsForSubmit() {
  const nameEl = document.getElementById("product-supplier-name");
  const contactEl = document.getElementById("product-supplier-contact");
  const addressEl = document.getElementById("product-supplier-address");
  const form = document.getElementById("product-form");
  const supplierId = form?.dataset.supplierId?.trim();
  const name = nameEl?.value?.trim() ?? "";
  const contact = contactEl?.value?.trim() ?? "";
  const address = addressEl?.value?.trim() ?? "";

  if (!name) return { valid: true };
  if (supplierId) return { valid: true };

  // Contact: if non-numeric (email), must contain @; if numeric (phone), must be 09 + 9 digits
  if (contact && !isContactNumericOnly(contact) && !contact.includes("@")) {
    validateContactAndShowError();
    const ext = document.getElementById("supplier-details-extension");
    const collapse = ext ? bootstrap.Collapse.getInstance(ext) || new bootstrap.Collapse(ext, { toggle: false }) : null;
    if (collapse && !ext.classList.contains("show")) collapse.show();
    return { valid: false, message: "Please enter a valid email (Contact must contain @) or use a phone number (09 + 9 digits)." };
  }
  if (contact && isContactNumericOnly(contact) && !isPhoneValid(normalizePhoneInput(contact))) {
    validateContactAndShowError();
    const ext = document.getElementById("supplier-details-extension");
    const collapse = ext ? bootstrap.Collapse.getInstance(ext) || new bootstrap.Collapse(ext, { toggle: false }) : null;
    if (collapse && !ext.classList.contains("show")) collapse.show();
    return { valid: false, message: "Phone must start with 09 and be 11 digits (e.g. 09171234567)." };
  }
  if (contact && address) return { valid: true };

  updateSupplierDetailsErrorState();
  const ext = document.getElementById("supplier-details-extension");
  const collapse = ext ? bootstrap.Collapse.getInstance(ext) || new bootstrap.Collapse(ext, { toggle: false }) : null;
  if (collapse && !ext.classList.contains("show")) collapse.show();
  return { valid: false, message: "Please fill Contact and Address for the new supplier." };
}

function computeSellingPrice() {
  const supplierPrice = parseFloat(document.getElementById("product-supplier-price")?.value) || 0;
  // Margin-based: Selling Price = Cost / (1 - Margin). e.g. 14% margin => cost / (1 - 0.14) = cost / 0.86
  const marginPct = Math.min(globalMarkupPercent, 99.99);
  const selling = marginPct >= 100 ? supplierPrice : supplierPrice / (1 - marginPct / 100);
  const sellingEl = document.getElementById("product-selling-price");
  if (sellingEl) {
    sellingEl.value = (Math.round(selling * 100) / 100).toFixed(2);
  }
}

function fetchGlobalMarkup() {
  return fetch(SETTINGS_API, { headers: authHeaders() })
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      if (data != null && typeof data.markup_percent === "number") {
        globalMarkupPercent = data.markup_percent;
        const input = document.getElementById("products-markup-percent");
        if (input) input.value = data.markup_percent;
      }
    })
    .catch(() => {});
}

function initProductsPageMarkup() {
  // Update button is handled by document-level delegation so it works after pjax navigation.
}

function showRecordInfoModal(product) {
  const modalEl = document.getElementById("recordInfoModal");
  const bodyEl = document.getElementById("record-info-body");
  if (!modalEl || !bodyEl) return;
  const recordedAt = product.recorded_at
    ? new Date(product.recorded_at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" })
    : "—";
  const recordedBy =
    product.recorded_by_name ||
    (product.recorded_by != null && String(product.recorded_by).trim() !== ""
      ? `User #${product.recorded_by}`
      : "—");
  bodyEl.innerHTML = `<p class="mb-1"><strong>Recorded at</strong><br/>${escapeHtml(String(recordedAt))}</p><p class="mb-0"><strong>Recorded by</strong><br/>${escapeHtml(recordedBy)}</p>`;
  const modal = new bootstrap.Modal(modalEl);
  modal.show();
}

function collapseSupplierDetailsExtension() {
  const ext = document.getElementById("supplier-details-extension");
  const btn = document.getElementById("btn-supplier-details");
  if (ext && btn) {
    const collapse = bootstrap.Collapse.getInstance(ext) || new bootstrap.Collapse(ext, { toggle: false });
    collapse.hide();
    btn.classList.remove("supplier-details-open");
    btn.setAttribute("aria-expanded", "false");
  }
}

// Arrow animation: keep button class in sync with collapse open state (point down when open)
let supplierDetailsArrowObserver = null;

function syncSupplierDetailsArrowState(ext, btn) {
  if (!ext || !btn) return;
  if (ext.classList.contains("show")) {
    btn.classList.add("supplier-details-open");
    btn.setAttribute("aria-expanded", "true");
  } else {
    btn.classList.remove("supplier-details-open");
    btn.setAttribute("aria-expanded", "false");
  }
}

function setupSupplierDetailsArrowAnimation() {
  const ext = document.getElementById("supplier-details-extension");
  const btn = document.getElementById("btn-supplier-details");
  const modal = document.getElementById("productModal");
  if (!ext || !btn) return;
  if (supplierDetailsArrowObserver) {
    supplierDetailsArrowObserver.disconnect();
    supplierDetailsArrowObserver = null;
  }
  syncSupplierDetailsArrowState(ext, btn);
  ext.addEventListener("show.bs.collapse", () => syncSupplierDetailsArrowState(ext, btn));
  ext.addEventListener("hidden.bs.collapse", () => syncSupplierDetailsArrowState(ext, btn));
  supplierDetailsArrowObserver = new MutationObserver(() => syncSupplierDetailsArrowState(ext, btn));
  supplierDetailsArrowObserver.observe(ext, { attributes: true, attributeFilter: ["class"] });
  if (modal && !modal.dataset.supplierArrowSynced) {
    modal.dataset.supplierArrowSynced = "1";
    modal.addEventListener("shown.bs.modal", () => {
      syncSupplierDetailsArrowState(
        document.getElementById("supplier-details-extension"),
        document.getElementById("btn-supplier-details")
      );
    });
  }
}

function showSupplierInfoModal(supplierId) {
  const modalEl = document.getElementById("supplierInfoModal");
  const bodyEl = document.getElementById("supplier-info-body");
  const titleEl = document.getElementById("supplierInfoModalLabel");
  if (!modalEl || !bodyEl) return;
  bodyEl.innerHTML = "<p class=\"text-muted mb-0\">Loading…</p>";
  const modal = new bootstrap.Modal(modalEl);
  modal.show();
  fetch(`${SUPPLIERS_API}/${supplierId}`, { headers: authHeaders() })
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      if (data?.supplier) {
        const s = data.supplier;
        const contact = s.contact ? escapeHtml(s.contact) : "<span class=\"text-muted\">—</span>";
        const address = s.address ? escapeHtml(s.address) : "<span class=\"text-muted\">—</span>";
        bodyEl.innerHTML = `<p class="mb-1"><strong>Contact</strong><br/>${contact}</p><p class="mb-0"><strong>Address</strong><br/>${address}</p>`;
      } else {
        bodyEl.innerHTML = "<p class=\"text-muted mb-0\">No details found.</p>";
      }
    })
    .catch(() => {
      bodyEl.innerHTML = "<p class=\"text-danger small mb-0\">Failed to load details.</p>";
    });
}

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

document.addEventListener("input", (e) => {
  if (e.target.id === "product-supplier-price") {
    computeSellingPrice();
  }
  if (e.target.id === "product-supplier-contact") {
    updateContactInputBehavior();
    validateContactAndShowError();
    updateSupplierDetailsErrorState();
  }
  if (e.target.id === "product-supplier-address") {
    updateSupplierDetailsErrorState();
  }
  if (e.target.id === "product-supplier-name") {
    const form = document.getElementById("product-form");
    if (form) form.dataset.supplierId = "";
    updateSupplierDetailsErrorState();
    if (supplierAutocompleteDebounce) clearTimeout(supplierAutocompleteDebounce);
    const query = (e.target.value || "").trim();
    if (query.length < 1) {
      hideSupplierAutocomplete();
      return;
    }
    supplierAutocompleteDebounce = setTimeout(() => {
      supplierAutocompleteDebounce = null;
      fetchSuppliers(query).then((list) => showSupplierAutocomplete(list));
    }, 220);
  }
});

document.addEventListener("change", (e) => {
  if (e.target.id === "product-supplier-price") {
    computeSellingPrice();
  }
  if (
    e.target.id === "product-filter-today" ||
    e.target.id === "product-sort" ||
    e.target.id === "product-filter-category"
  ) {
    applyProductsFilter();
  }
});
document.addEventListener("input", (e) => {
  if (e.target.id === "product-search-filter") {
    scheduleSearchApply();
  }
});
document.addEventListener("keydown", (e) => {
  if (e.target.id === "product-search-filter" && e.key === "Enter") {
    e.preventDefault();
    if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
    searchDebounceTimer = null;
    applyProductsFilter();
  }
});

document.addEventListener("focusin", (e) => {
  if (e.target.id === "product-supplier-name") {
    const query = (e.target.value || "").trim();
    if (query.length >= 1) {
      if (cachedSuppliers.length > 0) {
        const q = query.toLowerCase();
        const filtered = cachedSuppliers.filter((s) => (s.name || "").toLowerCase().includes(q));
        showSupplierAutocomplete(filtered.length ? filtered : cachedSuppliers);
      } else {
        fetchSuppliers(query).then((list) => showSupplierAutocomplete(list));
      }
    }
  }
});
document.addEventListener("focusout", (e) => {
  if (e.target.id === "product-supplier-name") {
    setTimeout(hideSupplierAutocomplete, 200);
  }
  if (e.target.id === "product-supplier-contact") {
    updateContactInputBehavior();
    validateContactAndShowError();
  }
});
document.addEventListener("mousedown", (e) => {
  const ac = document.getElementById("product-supplier-autocomplete");
  const btn = e.target.closest("#product-supplier-autocomplete button[data-supplier-id]");
  if (ac && btn) {
    e.preventDefault();
    e.stopPropagation();
    const id = btn.dataset.supplierId;
    let s = getSupplierFromCache(id);
    if (s) {
      selectSupplierFromAutocomplete(s.id, s.name, s.contact || "", s.address || "");
      return;
    }
    fetchSupplierById(id).then((supplier) => {
      if (supplier) selectSupplierFromAutocomplete(supplier.id, supplier.name, supplier.contact || "", supplier.address || "");
    });
    return;
  }
});

// Capture-phase handler for category modal buttons.
// Some Electron/pjax scenarios can prevent the bubble-phase delegation from firing.
document.addEventListener(
  "click",
  (e) => {
    const addBtn = e.target.closest("#btn-product-add-category");
    if (addBtn) {
      e.preventDefault();
      e.stopPropagation();

      if (!isCurrentUserAdmin()) {
        showAlert("Only admins can add new categories.", "warning");
        return;
      }
      promptTextInput({ title: "Enter new product category name:" })
        .then((name) => {
          const n = String(name || "").trim();
          if (!n) return;

          if (productCategories.some((c) => c.toLowerCase() === n.toLowerCase())) {
            setProductCategoryValue(n);
            showAlert("Category already exists; selected for new products.", "info");
            return;
          }
          productCategories.push(n);
          productCategories.sort((a, b) => a.localeCompare(b));
          setProductCategoryValue(n);
          showAlert(`Category added: ${n}`, "success");
        })
        .catch(() => {});
      return;
    }

    const editBtn = e.target.closest("#btn-product-edit-category");
    if (editBtn) {
      e.preventDefault();
      e.stopPropagation();

      if (!isCurrentUserAdmin()) {
        showAlert("Only admins can rename categories.", "warning");
        return;
      }
      const select = document.getElementById("product-category");
      if (!select) return;
      const current = (select.value || "").trim();
      if (!current) {
        showAlert("Select a category to rename.", "warning");
        return;
      }
      promptTextInput({ title: "Rename category:", defaultValue: current })
        .then((name) => {
          const n = String(name || "").trim();
          if (!n || n === current) return;

          const exists = productCategories.some((c) => c.toLowerCase() === n.toLowerCase());
          if (exists && n.toLowerCase() !== current.toLowerCase()) {
            showAlert("A category with that name already exists.", "warning");
            return;
          }
          productCategories = productCategories.map((c) => (c === current ? n : c));
          productCategories.sort((a, b) => a.localeCompare(b));
          setProductCategoryValue(n);
          showAlert(
            "Category renamed for new products. Existing products keep their saved category.",
            "info"
          );
        })
        .catch(() => {});
      return;
    }

    const archiveBtn = e.target.closest("#btn-product-archive-category");
    if (archiveBtn) {
      e.preventDefault();
      e.stopPropagation();

      if (!isCurrentUserAdmin()) {
        showAlert("Only admins can archive categories.", "warning");
        return;
      }
      const select = document.getElementById("product-category");
      if (!select) return;
      const current = (select.value || "").trim();
      if (!current) {
        showAlert("Select a category to archive.", "warning");
        return;
      }
      if (
        !window.confirm(
          `Archive category "${current}"?\n\nExisting products will keep this category, but it will no longer be available for new products.`
        )
      ) {
        return;
      }
      productCategories = productCategories.filter((c) => c !== current);
      setProductCategoryValue("");
      showAlert(
        "Category archived. Existing products keep this category, but it is no longer available for new products.",
        "success"
      );
      return;
    }
  },
  true
);
document.addEventListener("click", (e) => {
  if (e.target.closest("#product-supplier-autocomplete")) {
    return;
  }
  hideSupplierAutocomplete();
  if (e.target.closest("#btn-products-update-markup")) {
    const input = document.getElementById("products-markup-percent");
    if (!input) return;
    const value = parseFloat(input.value);
    if (isNaN(value) || value < 0 || value >= 100) {
      showAlert("Enter a margin between 0 and 99.99 (e.g. 14 for 14% profit margin).", "warning");
      return;
    }
    fetch(SETTINGS_API, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ markup_percent: value }),
    })
      .then((r) => (r.ok ? r.json() : r.json().then((d) => Promise.reject(new Error(d.message || "Failed")))))
      .then((data) => {
        globalMarkupPercent = data.markup_percent;
        if (input) input.value = data.markup_percent;
        showAlert("Margin updated. All product selling prices have been recalculated.", "success");
        applyProductsFilter();
      })
      .catch((err) => showAlert(err.message || "Failed to update margin.", "danger"));
    return;
  }
  if (e.target.closest("#btn-product-add-category")) {
    if (!isCurrentUserAdmin()) {
      showAlert("Only admins can add new categories.", "warning");
      return;
    }
    promptTextInput({ title: "Enter new product category name:" })
      .then((name) => {
        const n = String(name || "").trim();
        if (!n) return;
        if (productCategories.some((c) => c.toLowerCase() === n.toLowerCase())) {
          setProductCategoryValue(n);
          showAlert("Category already exists; selected for new products.", "info");
          return;
        }
        productCategories.push(n);
        productCategories.sort((a, b) => a.localeCompare(b));
        setProductCategoryValue(n);
        showAlert(`Category added: ${n}`, "success");
      })
      .catch(() => {});
    return;
  }
  if (e.target.closest("#btn-product-edit-category")) {
    if (!isCurrentUserAdmin()) {
      showAlert("Only admins can rename categories.", "warning");
      return;
    }
    const select = document.getElementById("product-category");
    if (!select) return;
    const current = (select.value || "").trim();
    if (!current) {
      showAlert("Select a category to rename.", "warning");
      return;
    }
    promptTextInput({ title: "Rename category:", defaultValue: current })
      .then((name) => {
        const n = String(name || "").trim();
        if (!n || n === current) return;

        const exists = productCategories.some((c) => c.toLowerCase() === n.toLowerCase());
        if (exists && n.toLowerCase() !== current.toLowerCase()) {
          showAlert("A category with that name already exists.", "warning");
          return;
        }
        productCategories = productCategories.map((c) => (c === current ? n : c));
        productCategories.sort((a, b) => a.localeCompare(b));
        setProductCategoryValue(n);
        showAlert(
          "Category renamed for new products. Existing products keep their saved category.",
          "info"
        );
      })
      .catch(() => {});
    return;
  }
  if (e.target.closest("#btn-product-archive-category")) {
    if (!isCurrentUserAdmin()) {
      showAlert("Only admins can archive categories.", "warning");
      return;
    }
    const select = document.getElementById("product-category");
    if (!select) return;
    const current = (select.value || "").trim();
    if (!current) {
      showAlert("Select a category to archive.", "warning");
      return;
    }
    if (!window.confirm(`Archive category "${current}"?\n\nExisting products will keep this category, but it will no longer be available for new products.`)) {
      return;
    }
    productCategories = productCategories.filter((c) => c !== current);
    setProductCategoryValue("");
    showAlert("Category archived. Existing products keep this category, but it is no longer available for new products.", "success");
    return;
  }
  if (e.target.closest("#btn-product-search-filter")) {
    applyProductsFilter();
  }
  
  if (e.target.closest("#btn-add-product")) {
    const modal = document.getElementById("productModal");
    const formEl = document.getElementById("product-form");
    if (!modal) return;
    if (formEl) {
      formEl.reset();
      formEl.dataset.productId = "";
      formEl.dataset.supplierId = "";
    }
    document.getElementById("productModalLabel").textContent = "Add Product";
    document.getElementById("product-id").value = "";
    setProductCategoryValue("");
    clearSupplierFields();
    collapseSupplierDetailsExtension();
    hideSupplierAutocomplete();
    fetchSuppliers("").then(() => updateSupplierDetailsErrorState());
    fetchGlobalMarkup().then(() => computeSellingPrice());
    const m = new bootstrap.Modal(modal);
    m.show();
  }
  if (e.target.closest("[data-action='show-supplier-info']")) {
    const btn = e.target.closest("[data-action='show-supplier-info']");
    const supplierId = btn?.dataset.supplierId;
    if (supplierId) showSupplierInfoModal(supplierId);
  }
  if (e.target.closest("[data-action='show-record-info']")) {
    const btn = e.target.closest("[data-action='show-record-info']");
    const productId = btn?.dataset.productId;
    const product = productId ? allProducts.find((p) => p.id == productId) : null;
    if (product) showRecordInfoModal(product);
  }
  if (e.target.closest("[data-action='reorder-product']")) {
    const btn = e.target.closest("[data-action='reorder-product']");
    const productId = btn?.dataset.productId;
    if (productId) openReorderModal(productId);
    return;
  }

  const sendReorderBtn = e.target.closest("[data-action='send-reorder-email']");
  if (sendReorderBtn) {
    const modalEl = document.getElementById("reorderModal");
    const alertEl = document.getElementById("reorder-alert");
    const productId = modalEl?.dataset?.productId;
    const textEl = document.getElementById("reorder-email-text");
    const waBtn = document.getElementById("btn-open-reorder-whatsapp");
    if (!modalEl || !alertEl || !productId || !textEl || !waBtn) return;
    if (sendReorderBtn.disabled) return;

    sendReorderBtn.disabled = true;
    waBtn.disabled = true;
    alertEl.className = "alert alert-info py-2 small";
    alertEl.textContent = "Sending…";
    alertEl.classList.remove("d-none");

    const subject = (modalEl.dataset.subject || "").trim();
    const text = textEl.value.trim();

    fetch(PRODUCTS_REORDER_EMAIL_API(productId), {
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
        alertEl.className = "alert alert-success py-2 small";
        alertEl.textContent = data?.message || "Email sent.";
        setTimeout(() => {
          try {
            const m = bootstrap.Modal.getInstance(modalEl) || new bootstrap.Modal(modalEl);
            m.hide();
          } catch {}
        }, 650);
      })
      .catch((err) => {
        alertEl.className = "alert alert-warning py-2 small";
        alertEl.textContent = err.message || "Failed to send email.";
      })
      .finally(() => {
        sendReorderBtn.disabled = false;
        try {
          const pid = modalEl?.dataset?.productId;
          const product = pid ? allProducts.find((p) => String(p.id) === String(pid)) : null;
          if (product?.supplier_id != null) {
            fetch(`${SUPPLIERS_API}/${encodeURIComponent(product.supplier_id)}`, { headers: authHeaders() })
              .then((r) => (r.ok ? r.json() : null))
              .then((data) => {
                const contact = data?.supplier?.contact ?? "";
                const phoneLocal = normalizePhoneInput(String(contact || ""));
                waBtn.disabled = !isPhoneValid(phoneLocal);
              })
              .catch(() => {
                waBtn.disabled = true;
              });
          } else {
            waBtn.disabled = true;
          }
        } catch {
          waBtn.disabled = true;
        }
      });
    return;
  }

  const openReorderWaBtn = e.target.closest("[data-action='open-reorder-whatsapp']");
  if (openReorderWaBtn) {
    const modalEl = document.getElementById("reorderModal");
    const alertEl = document.getElementById("reorder-alert");
    const productId = modalEl?.dataset?.productId;
    const textEl = document.getElementById("reorder-email-text");
    if (!modalEl || !alertEl || !productId || !textEl) return;
    if (openReorderWaBtn.disabled) return;

    openReorderWaBtn.disabled = true;
    alertEl.className = "alert alert-info py-2 small";
    alertEl.textContent = "Opening WhatsApp…";
    alertEl.classList.remove("d-none");

    const text = textEl.value.trim();
    const product = allProducts.find((p) => String(p.id) === String(productId)) || null;
    if (!product?.supplier_id) {
      alertEl.className = "alert alert-warning py-2 small";
      alertEl.textContent = "No supplier assigned.";
      openReorderWaBtn.disabled = false;
      return;
    }

    fetch(`${SUPPLIERS_API}/${encodeURIComponent(product.supplier_id)}`, { headers: authHeaders() })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        const contact = data?.supplier?.contact ?? "";
        const ok = openWhatsAppOnce({ phone09: contact, text });
        if (!ok) throw new Error("Temporarily not available");
        alertEl.className = "alert alert-success py-2 small";
        alertEl.textContent = "Opening WhatsApp…";
        setTimeout(() => {
          try {
            const m = bootstrap.Modal.getInstance(modalEl) || new bootstrap.Modal(modalEl);
            m.hide();
          } catch {}
        }, 450);
      })
      .catch((err) => {
        alertEl.className = "alert alert-warning py-2 small";
        alertEl.textContent = err?.message || "Failed to open WhatsApp.";
      })
      .finally(() => {
        openReorderWaBtn.disabled = false;
      });
    return;
  }
  // Handle edit product button click
  const editBtn = e.target.closest("button[data-action='edit-product']");
  if (editBtn) {
    const productId = editBtn.dataset.productId;
    const product = allProducts.find(p => p.id == productId);
    if (product) {
      openEditModalWithProduct(product, productId);
    }
  }
});

function openEditModalWithProduct(product, productId) {
  const modal = document.getElementById("productModal");
  const formEl = document.getElementById("product-form");
  if (!modal) return;
  document.getElementById("productModalLabel").textContent = "Edit Product";
  document.getElementById("product-name").value = product.name || "";
  setProductCategoryValue(product.category || "");
  document.getElementById("product-supplier-price").value = product.supplier_price ?? 0;
  fetchGlobalMarkup().then(() => computeSellingPrice());
  document.getElementById("product-stock").value = product.stock_quantity ?? 0;
  document.getElementById("product-id").value = productId || "";
  document.getElementById("product-supplier-name").value = product.supplier_name || "";
  collapseSupplierDetailsExtension();
  if (product.supplier_id) {
    fetch(`${SUPPLIERS_API}/${product.supplier_id}`, { headers: authHeaders() })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        const contactEl = document.getElementById("product-supplier-contact");
        const addressEl = document.getElementById("product-supplier-address");
        if (data?.supplier) {
          if (contactEl) contactEl.value = data.supplier.contact || "";
          if (addressEl) addressEl.value = data.supplier.address || "";
        }
        updateSupplierDetailsErrorState();
      })
      .catch(() => updateSupplierDetailsErrorState());
  } else {
    document.getElementById("product-supplier-contact").value = "";
    document.getElementById("product-supplier-address").value = "";
    updateSupplierDetailsErrorState();
  }
  if (formEl) {
    formEl.dataset.productId = productId;
    formEl.dataset.supplierId = product.supplier_id != null ? String(product.supplier_id) : "";
  }
  fetchSuppliers("").then(() => updateSupplierDetailsErrorState());
  const m = new bootstrap.Modal(modal);
  m.show();
}

function openEditModalForProductId(productId) {
  fetch(`${PRODUCTS_API}/${productId}`, { headers: authHeaders() })
    .then((r) => {
      if (!r.ok) throw new Error("Product not found.");
      return r.json();
    })
    .then((data) => {
      const product = data.product;
      if (product) openEditModalWithProduct(product, String(product.id));
    })
    .catch(() => showAlert("Could not load the existing product.", "warning"));
}

document.addEventListener("submit", (e) => {
  if (e.target.id !== "product-form") return;
  e.preventDefault();
  clearAlert();
  const name = document.getElementById("product-name")?.value?.trim();
  const category = document.getElementById("product-category")?.value?.trim() || null;
  const supplierName = document.getElementById("product-supplier-name")?.value?.trim() ?? "";
  const supplierContact = document.getElementById("product-supplier-contact")?.value?.trim() ?? "";
  const supplierAddress = document.getElementById("product-supplier-address")?.value?.trim() ?? "";
  const supplier_price = document.getElementById("product-supplier-price")?.value;
  const selling_price = document.getElementById("product-selling-price")?.value;
  const stock_quantity = document.getElementById("product-stock")?.value;
  const productIdFromForm = document.getElementById("product-id")?.value || e.target.dataset.productId;
  const existingSupplierId = e.target.dataset.supplierId || null;

  if (!name) {
    showAlert("Product name is required.", "warning");
    return;
  }

  const supplierValidation = validateSupplierDetailsForSubmit();
  if (!supplierValidation.valid) {
    showAlert(supplierValidation.message || "Please fill Contact and Address for the new supplier.", "warning");
    return;
  }

  const url = productIdFromForm ? `${PRODUCTS_API}/${productIdFromForm}` : PRODUCTS_API;
  const method = productIdFromForm ? "PUT" : "POST";
  const headers = { "Content-Type": "application/json", ...authHeaders() };

  function resolveSupplierId() {
    if (!supplierName) return Promise.resolve(null);
    if (existingSupplierId) {
      return fetch(`${SUPPLIERS_API}/${existingSupplierId}`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ name: supplierName, contact: supplierContact || null, address: supplierAddress || null }),
      })
        .then((r) => {
          if (!r.ok) return r.json().then((d) => Promise.reject(new Error(d.message || "Failed to update supplier.")));
          return r.json();
        })
        .then(() => parseInt(existingSupplierId, 10));
    }
    return fetch(SUPPLIERS_API, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: supplierName, contact: supplierContact || null, address: supplierAddress || null }),
    })
      .then((r) => {
        if (!r.ok) return r.json().then((d) => Promise.reject(new Error(d.message || "Failed to create supplier.")));
        return r.json();
      })
      .then((data) => data.supplier?.id ?? null);
  }

  resolveSupplierId()
    .then((supplierId) =>
      fetch(url, {
        method,
        headers,
        body: JSON.stringify({
          name,
          category: category || null,
          supplier_id: supplierId,
          supplier_price: supplier_price != null && supplier_price !== "" ? parseFloat(supplier_price) : 0,
          selling_price: selling_price ? parseFloat(selling_price) : 0,
          stock_quantity: stock_quantity ? parseInt(stock_quantity, 10) : 0,
        }),
      })
    )
    .then((r) => {
      if (r.status === 409) {
        return r.json().then((d) => ({ conflict: true, existingId: d.existingId, message: d.message }));
      }
      if (!r.ok) return r.json().then((d) => Promise.reject(new Error(d.message || "Failed to save.")));
      return r.json();
    })
    .then((response) => {
      if (response && response.conflict && response.existingId) {
        showAlert(response.message || "Product already exists. Opening for edit.", "info");
        const modal = document.getElementById("productModal");
        if (modal) {
          const m = bootstrap.Modal.getInstance(modal);
          if (m) m.hide();
        }
        openEditModalForProductId(response.existingId);
        return;
      }
      const modal = document.getElementById("productModal");
      if (modal) {
        const m = bootstrap.Modal.getInstance(modal);
        if (m) m.hide();
      }
      showAlert(productIdFromForm ? "Product updated successfully." : "Product added successfully.", "success");
      applyProductsFilter();
      e.target.reset();
      e.target.dataset.productId = "";
      e.target.dataset.supplierId = "";
      document.getElementById("product-id").value = "";
      document.getElementById("productModalLabel").textContent = "Add Product";
      clearSupplierFields();
    })
    .catch((err) => {
      showAlert(err.message || "Failed to save product.", "danger");
    });
});

// Function to check and load products if on products page
function setupProductsInfiniteScroll() {
  const sentinel = document.getElementById("products-load-more");
  if (!sentinel) return;
  const observer = new IntersectionObserver(
    (entries) => {
      const entry = entries[0];
      if (!entry?.isIntersecting || productsLoading || !productsHasMore) return;
      loadProducts({ ...getProductsParams(), append: true });
    },
    { rootMargin: "200px", threshold: 0 }
  );
  observer.observe(sentinel);
}

function checkAndLoadIfProductsPage() {
  const tbody = getProductsTbody();
  if (tbody && document.body?.dataset.page === "products") {
    loadProducts(); // uses getProductsParams() via default
    fetchGlobalMarkup(); // So global markup is ready when Add/Edit modal opens
  }
}

// Immediate check if script loads after DOM is ready
if (document.readyState !== "loading") {
  setTimeout(checkAndLoadIfProductsPage, 100);
}

// Simple initialization on page load - exact same approach as users.js
window.addEventListener("DOMContentLoaded", () => {
  checkAndLoadIfProductsPage();
  setupSupplierDetailsArrowAnimation();
  if (document.body?.dataset.page === "products") {
    initProductsPageMarkup();
    setupProductsInfiniteScroll();
  }
});

// Handle pjax navigation - load data when navigating to products page
window.addEventListener("pjax:complete", (e) => {
  if (e.detail && e.detail.page === "products") {
    setupSupplierDetailsArrowAnimation();
    setTimeout(() => {
      fetchGlobalMarkup();
      loadProducts();
    }, 100);
  }
});

// Watch for data-page attribute changes (handles all navigation scenarios)
// Set up observer after DOM is ready
function setupPageObserver() {
  if (!document.body) {
    setTimeout(setupPageObserver, 50);
    return;
  }
  
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === "attributes" && mutation.attributeName === "data-page") {
        if (document.body.dataset.page === "products") {
          setupSupplierDetailsArrowAnimation();
          setTimeout(() => {
            fetchGlobalMarkup();
            loadProducts();
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
  document.addEventListener("DOMContentLoaded", setupPageObserver);
} else {
  setupPageObserver();
}

// Also watch for main content changes (pjax swaps the main element)
function setupMainObserver() {
  const main = document.querySelector("main");
  if (!main) {
    setTimeout(setupMainObserver, 50);
    return;
  }
  
  const observer = new MutationObserver((mutations) => {
    // Check if we're on products page and main content changed
    if (document.body?.dataset.page === "products") {
      const tbody = getProductsTbody();
      if (tbody) {
        const firstRow = tbody.querySelector("tr");
        // If showing "Loading" or empty, reload
        if (!firstRow || firstRow.textContent.includes("Loading")) {
          setTimeout(() => {
            fetchGlobalMarkup();
            loadProducts();
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
  document.addEventListener("DOMContentLoaded", setupMainObserver);
} else {
  setupMainObserver();
}
