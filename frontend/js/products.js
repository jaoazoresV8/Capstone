import { API_ORIGIN } from "./config.js";
const PRODUCTS_API = `${API_ORIGIN}/api/products`;
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
  const filter = document.getElementById("product-filter-today")?.value ?? "";
  const sort = document.getElementById("product-sort")?.value ?? "name_asc";
  return { q, filter, sort };
}

function loadProducts(opts = {}) {
  const { append = false } = opts;
  const params = opts.q !== undefined ? opts : getProductsParams();
  const q = params.q ?? "";
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
  const fragment = products
    .map((p) => {
      const hasSupplier = p.supplier_id != null;
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
          <button type="button" class="btn btn-outline-primary btn-sm" data-action="edit-product" data-product-id="${p.id}" title="Edit Product">
            <i class="bi bi-pencil-square"></i>
          </button>
        </td>
      </tr>`;
    })
    .join("");
  tbody.insertAdjacentHTML("beforeend", fragment);
}

function renderProducts(products) {
  const tbody = getProductsTbody();
  if (!tbody) return;
  
  tbody.innerHTML = products
    .map(
      (p) => {
        const supplierName = p.supplier_name || "—";
        const hasSupplier = p.supplier_id != null;
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
            <button type="button" class="btn btn-outline-primary btn-sm" data-action="edit-product" data-product-id="${p.id}" title="Edit Product">
              <i class="bi bi-pencil-square"></i>
            </button>
          </td>
        </tr>`;
      }
    )
    .join("");
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
  const selling = supplierPrice * (1 + globalMarkupPercent / 100);
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
  if (e.target.id === "product-filter-today" || e.target.id === "product-sort") {
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
document.addEventListener("click", (e) => {
  if (e.target.closest("#product-supplier-autocomplete")) {
    return;
  }
  hideSupplierAutocomplete();
  if (e.target.closest("#btn-products-update-markup")) {
    const input = document.getElementById("products-markup-percent");
    if (!input) return;
    const value = parseFloat(input.value);
    if (isNaN(value) || value < 0 || value > 999) {
      showAlert("Enter a markup between 0 and 999.", "warning");
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
        showAlert("Markup updated. All product selling prices have been recalculated.", "success");
        applyProductsFilter();
      })
      .catch((err) => showAlert(err.message || "Failed to update markup.", "danger"));
    return;
  }
  if (e.target.closest("#btn-product-add-category")) {
    if (!isCurrentUserAdmin()) {
      showAlert("Only admins can add new categories.", "warning");
      return;
    }
    const name = (window.prompt("Enter new product category name:") || "").trim();
    if (!name) return;
    if (productCategories.some((c) => c.toLowerCase() === name.toLowerCase())) {
      setProductCategoryValue(name);
      return;
    }
    productCategories.push(name);
    productCategories.sort((a, b) => a.localeCompare(b));
    setProductCategoryValue(name);
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
    const name = (window.prompt("Rename category:", current) || "").trim();
    if (!name || name === current) return;
    const exists = productCategories.some((c) => c.toLowerCase() === name.toLowerCase());
    if (exists && name.toLowerCase() !== current.toLowerCase()) {
      showAlert("A category with that name already exists.", "warning");
      return;
    }
    productCategories = productCategories.map((c) => (c === current ? name : c));
    productCategories.sort((a, b) => a.localeCompare(b));
    setProductCategoryValue(name);
    showAlert("Category renamed for new products. Existing products keep their saved category.", "info");
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
