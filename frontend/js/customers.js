/**
 * Customers page: list customers with search and filter functionality
 */
const API_ORIGIN =
  window.location.port === "5500"
    ? "http://localhost:5000"
    : window.location.origin;
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
  if (!hasProducts && !hasTransactions) return "<span class=\"text-muted small\">No purchase history.</span>";

  let html = '<div class="customer-details-expanded small">';

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
    html += '<div class="detail-section-title">Transaction history</div>';
    transactions.forEach((t) => {
      const dateStr = t.sale_date ? new Date(t.sale_date).toLocaleDateString(undefined, { dateStyle: "short" }) : "—";
      html += '<div class="transaction-card">';
      html += '<div class="transaction-header">';
      html += `<span class="sale-id">Sale #${escapeHtml(String(t.sale_id))}</span>`;
      html += `<span class="text-muted">${escapeHtml(dateStr)}</span>`;
      html += `<span>Total ₱${Number(t.total_amount || 0).toFixed(2)}</span>`;
      html += `<span>Paid ₱${Number(t.amount_paid || 0).toFixed(2)}</span>`;
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
        const btn = hasDetails
          ? `<button type="button" class="btn btn-link btn-sm p-0 ms-1 align-baseline" data-action="toggle-details" data-index="${i}" aria-expanded="false"><i class="bi bi-chevron-down" aria-hidden="true"></i> View details</button>`
          : "";
        const rowClass = hasBalance(c) ? " customer-with-balance" : "";
        const bal = balance(c);
        const firstUnpaid = (c.transactions || []).find((t) => Number(t.remaining_balance || 0) > 0);
        const saleId = firstUnpaid ? firstUnpaid.sale_id : "";
        const saleBalance = firstUnpaid ? Number(firstUnpaid.remaining_balance || 0) : bal;
        const payParams = new URLSearchParams({ pay: "1", customerId: String(c.customer_id || c.id || ""), customerName: (c.name || "").trim(), balance: String(saleBalance) });
        if (saleId) payParams.set("saleId", String(saleId));
        const payBtn = hasBalance(c)
          ? `<a href="./payments.html?${payParams.toString()}" class="btn btn-danger btn-sm" data-action="pay-customer" title="Record payment">Pay</a>`
          : "";
        return `<tr data-customer-row data-index="${i}" class="${rowClass}">
          <td>${escapeHtml(c.name || "—")}</td>
          <td>${escapeHtml(c.contact || "—")}</td>
          <td>${escapeHtml(c.address || "—")}</td>
          <td class="small">${escapeHtml(summary)}${btn}</td>
          <td>₱${balanceRounded(c).toFixed(2)}</td>
          <td><span class="${statusClass(c)}">${escapeHtml(statusText(c))}</span></td>
          <td>${payBtn}</td>
        </tr>
        <tr data-detail-row data-for-index="${i}" class="d-none"><td colspan="7" class="bg-light pt-2 pb-3 px-3"></td></tr>`;
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
  const toggleBtn = e.target.closest("[data-action='toggle-details']");
  if (toggleBtn) {
    e.preventDefault();
    const index = toggleBtn.getAttribute("data-index");
    if (index == null) return;
    const idx = parseInt(index, 10);
    const detailRow = document.querySelector(`tr[data-detail-row][data-for-index="${index}"]`);
    const customer = lastRenderedCustomers[idx];
    if (!detailRow || !customer) return;
    const td = detailRow.querySelector("td");
    const isExpanded = !detailRow.classList.contains("d-none");
    if (isExpanded) {
      detailRow.classList.add("d-none");
      if (td) td.innerHTML = "";
      toggleBtn.innerHTML = '<i class="bi bi-chevron-down" aria-hidden="true"></i> View details';
      toggleBtn.setAttribute("aria-expanded", "false");
    } else {
      if (td) td.innerHTML = buildDetailsHtml(customer);
      detailRow.classList.remove("d-none");
      toggleBtn.innerHTML = '<i class="bi bi-chevron-up" aria-hidden="true"></i> Hide details';
      toggleBtn.setAttribute("aria-expanded", "true");
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
