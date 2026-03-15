const REPORTS_API = "/api/reports";

let dailySalesChart = null;
let topProductsChart = null;
let customerBalancesChart = null;
let voidedRefundedChart = null;

const pesoNumber = new Intl.NumberFormat("en-PH", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const commaNumber = new Intl.NumberFormat("en-US");
const fullDateFmt = new Intl.DateTimeFormat("en-US", {
  month: "long",
  day: "numeric",
  year: "numeric",
});

const reportState = {
  loading: false,
  start: "",
  end: "",
};

let globalOnlineListenersBound = false;

function getAuthHeaders() {
  const token = localStorage.getItem("sm_token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function fmtPeso(value) {
  const n = Number(value);
  return `₱${pesoNumber.format(Number.isFinite(n) ? n : 0)}`;
}

function fmtCount(value) {
  const n = Number(value);
  return commaNumber.format(Number.isFinite(n) ? n : 0);
}

function fmtFullDate(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value || "");
  return fullDateFmt.format(d);
}

function toISODateOnly(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

function clampISODate(s) {
  return (s || "").toString().slice(0, 10);
}

function setLoading(isLoading) {
  reportState.loading = !!isLoading;
  document.body?.classList.toggle("reports-loading", reportState.loading);
  const btn = document.getElementById("btn-refresh-reports");
  const spinner = document.getElementById("reports-refresh-spinner");
  if (btn) btn.disabled = reportState.loading;
  if (spinner) spinner.classList.toggle("d-none", !reportState.loading);

  const kpiWrap = document.getElementById("reports-kpis");
  if (kpiWrap) {
    kpiWrap.querySelectorAll(".kpi-placeholder").forEach((el) => {
      el.classList.toggle("d-none", !reportState.loading);
    });
    kpiWrap.querySelectorAll(".kpi-real").forEach((el) => {
      el.classList.toggle("d-none", reportState.loading);
    });
  }
}

async function fetchAllReports({ start, end, force = false } = {}) {
  const qs = new URLSearchParams();
  if (start) qs.set("start", clampISODate(start));
  if (end) qs.set("end", clampISODate(end));
  if (force) qs.set("force", "1");

  const res = await fetch(`${REPORTS_API}/all?${qs.toString()}`, {
    headers: {
      ...getAuthHeaders(),
      "Content-Type": "application/json",
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.message || "Failed to load reports.";
    throw new Error(msg);
  }
  return data;
}

function setStatus(message, type = "info") {
  const el = document.getElementById("reports-status");
  if (!el) return;
  el.classList.remove("d-none");
  el.className = `alert alert-${type} py-2 small`;
  el.textContent = message;
}

function destroyChart(chart) {
  if (chart && typeof chart.destroy === "function") {
    chart.destroy();
  }
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function computeAxisMax(values, headroomRatio = 0.15) {
  const arr = Array.isArray(values)
    ? values.map(toNumber).filter((v) => Number.isFinite(v) && v >= 0)
    : [];
  if (!arr.length) return undefined;
  const maxVal = Math.max(...arr);
  if (maxVal <= 0) return undefined;
  const withHeadroom = maxVal * (1 + headroomRatio);
  const magnitude = Math.pow(10, Math.floor(Math.log10(withHeadroom || 1)));
  const niceMax = Math.ceil(withHeadroom / magnitude) * magnitude;
  return niceMax;
}

function toggleEmpty(id, isEmpty) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.toggle("d-none", !isEmpty);
}

function truncateWithEllipsis(s, maxLen) {
  const str = (s ?? "").toString();
  if (!maxLen || str.length <= maxLen) return str;
  return `${str.slice(0, Math.max(0, maxLen - 1))}…`;
}

function renderDailySales(collections) {
  const docs = Array.isArray(collections.daily_sales) ? collections.daily_sales.slice() : [];
  if (!docs.length) {
    destroyChart(dailySalesChart);
    dailySalesChart = null;
    toggleEmpty("empty-daily", true);
    return;
  }
  toggleEmpty("empty-daily", false);

  docs.sort((a, b) => new Date(a.date || a._id || 0) - new Date(b.date || b._id || 0));

  const labels = docs.map((d) => (d.date || d._id || "").toString().slice(0, 10));
  const sales = docs.map((d) => toNumber(d.totalSales ?? d.total_sales ?? d.sales));
  const payments = docs.map((d) => toNumber(d.totalPayments ?? d.total_payments ?? d.payments));
  const dailyAxisMax = computeAxisMax([...sales, ...payments]);

  const ctx = document.getElementById("chart-daily-sales");
  if (!ctx) return;

  destroyChart(dailySalesChart);
  dailySalesChart = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Sales",
          data: sales,
          borderColor: "#0d6efd",
          backgroundColor: "rgba(13, 110, 253, 0.06)",
          tension: 0.35,
          fill: true,
          pointRadius: 0,
          pointHitRadius: 14,
          borderWidth: 2,
        },
        {
          label: "Payments",
          data: payments,
          borderColor: "#20c997",
          backgroundColor: "rgba(32, 201, 151, 0.06)",
          tension: 0.35,
          fill: false,
          pointRadius: 0,
          pointHitRadius: 14,
          borderWidth: 2,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: {
        duration: 700,
        easing: "easeOutQuart",
      },
      plugins: {
        legend: {
          display: true,
          position: "top",
          align: "start",
          labels: {
            usePointStyle: true,
            pointStyle: "line",
            boxWidth: 10,
            padding: 16,
          },
        },
        tooltip: {
          mode: "index",
          intersect: false,
          callbacks: {
            title(items) {
              const idx = items?.[0]?.dataIndex ?? 0;
              const raw = labels[idx] || "";
              return fmtFullDate(raw);
            },
            label(context) {
              const label = context.dataset?.label || "Value";
              const y = context.parsed?.y ?? 0;
              return `${label}: ${fmtPeso(y)}`;
            },
          },
        },
      },
      scales: {
        x: {
          ticks: { maxRotation: 0 },
          grid: { color: "#f0f0f0" },
        },
        y: {
          beginAtZero: true,
          max: dailyAxisMax,
          title: {
            display: true,
            text: "Amount (₱)",
          },
          grid: { color: "#f0f0f0" },
          ticks: {
            callback(value) {
              return fmtPeso(value);
            },
          },
        },
      },
    },
  });
}

function renderTopProducts(collections) {
  const docs = Array.isArray(collections.top_products) ? collections.top_products.slice() : [];
  if (!docs.length) {
    destroyChart(topProductsChart);
    topProductsChart = null;
    toggleEmpty("empty-top-products", true);
    return;
  }
  toggleEmpty("empty-top-products", false);

  docs.sort((a, b) => toNumber(b.totalQty ?? b.total_qty ?? b.qty ?? b.count) - toNumber(a.totalQty ?? a.total_qty ?? a.qty ?? a.count));

  const top = docs.slice(0, 10);
  const labels = top.map((d) => (d.productName ?? d.product_name ?? d.name ?? "Product").toString().replace(/\s+/g, " ").trim());
  const values = top.map((d) => toNumber(d.totalQty ?? d.total_qty ?? d.qty ?? d.count));
  const productsAxisMax = computeAxisMax(values);

  const ctx = document.getElementById("chart-top-products");
  if (!ctx) return;

  destroyChart(topProductsChart);
  topProductsChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "Quantity sold",
          data: values,
          backgroundColor: "#0d6efd",
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      indexAxis: "y",
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title(items) {
              const idx = items?.[0]?.dataIndex ?? 0;
              return labels[idx] || "Product";
            },
            label(context) {
              const v = context.parsed?.x ?? context.parsed ?? 0;
              return `Quantity: ${fmtCount(v)} pcs`;
            },
          },
        },
      },
      scales: {
        x: {
          beginAtZero: true,
          max: productsAxisMax,
          grid: { color: "#f0f0f0" },
          ticks: {
            callback(value) {
              return fmtCount(value);
            },
          },
        },
        y: {
          grid: { display: false },
          ticks: {
            callback(value, index) {
              const full = labels[index] || "";
              return truncateWithEllipsis(full, 20);
            },
          },
        },
      },
    },
    plugins: [
      {
        id: "barValueLabelsPcs",
        afterDatasetsDraw(chart) {
          const { ctx } = chart;
          const dataset = chart.data.datasets?.[0];
          const meta = chart.getDatasetMeta(0);
          if (!dataset || !meta) return;
          ctx.save();
          ctx.font = "12px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
          ctx.fillStyle = "#64748b";
          ctx.textBaseline = "middle";
          meta.data.forEach((bar, i) => {
            const v = dataset.data?.[i] ?? 0;
            const label = `${fmtCount(v)} pcs`;
            const x = bar.x + 8;
            const y = bar.y;
            ctx.fillText(label, x, y);
          });
          ctx.restore();
        },
      },
    ],
  });
}

function renderCustomerBalances(collections) {
  const docs = Array.isArray(collections.customer_balances) ? collections.customer_balances.slice() : [];
  if (!docs.length) {
    destroyChart(customerBalancesChart);
    customerBalancesChart = null;
    toggleEmpty("empty-customer-balances", true);
    const list = document.getElementById("customer-balances-list");
    if (list) list.innerHTML = "";
    return;
  }
  toggleEmpty("empty-customer-balances", false);

  docs.sort((a, b) => toNumber(b.balance ?? b.totalBalance ?? b.total_balance) - toNumber(a.balance ?? a.totalBalance ?? a.total_balance));

  const top = docs.slice(0, 10);
  const visibleCount = Math.min(5, top.length);
  const names = top.map((d) => (d.customerName ?? d.customer_name ?? d.name ?? "Customer").toString().replace(/\s+/g, " ").trim());
  const values = top.map((d) => toNumber(d.balance ?? d.totalBalance ?? d.total_balance));
  const ids = top.map((d) => (d.customerId ?? d.customer_id ?? d.id ?? "").toString());
  const balancesAxisMax = computeAxisMax(values);

  const ctx = document.getElementById("chart-customer-balances");
  if (!ctx) return;

  destroyChart(customerBalancesChart);
  customerBalancesChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels: names.map((n, i) => `#${i + 1} ${n}`),
      datasets: [
        {
          label: "Outstanding balance",
          data: values,
          backgroundColor: "#dc3545",
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      indexAxis: "y",
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title(items) {
              const idx = items?.[0]?.dataIndex ?? 0;
              return names[idx] || "Customer";
            },
            label(context) {
              const v = context.parsed?.x ?? context.parsed ?? 0;
              return `Outstanding: ${fmtPeso(v)}`;
            },
          },
        },
      },
      scales: {
        x: {
          beginAtZero: true,
          max: balancesAxisMax,
          grid: { color: "#f0f0f0" },
          ticks: {
            callback(value) {
              return fmtPeso(value);
            },
          },
        },
        y: {
          grid: { display: false },
          ticks: {
            callback(value, index) {
              const full = names[index] || "";
              return `#${index + 1} ${truncateWithEllipsis(full, 18)}`;
            },
          },
        },
      },
    },
  });

  const list = document.getElementById("customer-balances-list");
  if (list) {
    const itemsHtml = top
      .map((d, i) => {
        const id = ids[i] || "";
        const name = names[i] || "Customer";
        const bal = values[i] || 0;
        const isOverdue = bal > 0;
        const link = id
          ? `./customers.html?openCustomerId=${encodeURIComponent(id)}`
          : "./customers.html";
        const extraClass = i >= visibleCount ? " extra-balance d-none" : "";
        return `
          <div class="list-group-item px-0 d-flex justify-content-between align-items-center gap-2${extraClass}">
            <div class="text-truncate" title="${name}">
              <span class="text-muted me-2">#${i + 1}</span>
              <span class="fw-medium">${name}</span>
            </div>
            <div class="d-flex align-items-center gap-2 flex-shrink-0">
              <span class="${isOverdue ? "text-danger fw-semibold" : "text-muted"}">${fmtPeso(bal)}</span>
              <a class="btn btn-outline-primary btn-sm" href="${link}">View details</a>
            </div>
          </div>`;
      })
      .join("");

    const hasMore = top.length > visibleCount;

    list.innerHTML = `
      <div class="small text-uppercase text-muted mb-2" style="letter-spacing: .04em;">Top balances</div>
      <div class="list-group list-group-flush">
        ${itemsHtml}
      </div>
      ${
        hasMore
          ? `<button type="button" class="btn btn-link btn-sm px-0 mt-2" id="toggle-balances-list" data-expanded="false">
               View more
             </button>`
          : ""
      }`;
  }
}

function renderVoidedRefunded(collections) {
  const docs = Array.isArray(collections.voided_refunded) ? collections.voided_refunded.slice() : [];
  const list = document.getElementById("void-refunds-list");
  const ctx = document.getElementById("chart-void-refunds");
  const toggleBtn = document.getElementById("btn-toggle-void-refunds");
  if (!list || !ctx) return;

  if (!docs.length) {
    list.innerHTML = "";
    toggleEmpty("empty-void-refunds", true);
    destroyChart(voidedRefundedChart);
    voidedRefundedChart = null;
    if (toggleBtn) {
      toggleBtn.classList.add("d-none");
      toggleBtn.setAttribute("data-expanded", "false");
    }
    list.classList.add("d-none");
    return;
  }

  toggleEmpty("empty-void-refunds", false);

  let totalVoided = 0;
  let totalRefunded = 0;
  docs.forEach((d) => {
    const isRefund =
      (d.issue_status || d.sale_status || "").toString().toLowerCase() === "refunded";
    const amount = Number(d.total_amount ?? d.amount_paid ?? 0) || 0;
    if (isRefund) totalRefunded += amount;
    else totalVoided += amount;
  });

  const voidAxisMax = computeAxisMax([totalVoided, totalRefunded], 0.2);

  destroyChart(voidedRefundedChart);
  voidedRefundedChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels: ["Voided", "Refunded"],
      datasets: [
        {
          label: "Amount",
          data: [totalVoided, totalRefunded],
          backgroundColor: ["#343a40", "#0dcaf0"],
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      indexAxis: "y",
      plugins: {
        legend: {
          display: false,
          labels: {
            font: {
              size: 10,
            },
          },
        },
        tooltip: {
          callbacks: {
            label(context) {
              const v = context.parsed?.x ?? context.parsed ?? 0;
              return fmtPeso(v);
            },
          },
          bodyFont: {
            size: 10,
          },
        },
      },
      scales: {
        x: {
          beginAtZero: true,
          max: voidAxisMax,
          grid: { color: "#f0f0f0" },
          ticks: {
            font: {
              size: 10,
            },
            callback(value) {
              return fmtPeso(value);
            },
          },
        },
        y: {
          grid: { display: false },
          ticks: {
            font: {
              size: 10,
            },
          },
        },
      },
    },
  });

  const items = docs.slice(0, 60).map((d) => {
    const isRefund =
      (d.issue_status || d.sale_status || "").toString().toLowerCase() === "refunded";
    const typeLabel = isRefund ? "Refunded" : "Voided";
    const pillClass = isRefund ? "bg-info" : "bg-dark";
    const saleNumber = d.or_number || d.sale_id || "";
    const customer = (d.customer_name || "").toString().trim() || "—";
    const amount = Number(d.total_amount ?? d.amount_paid ?? 0);
    const reasonRaw = (d.reason || "").toString();
    let reason = reasonRaw;
    if (reasonRaw === "wrong_item") reason = "Wrong item";
    else if (reasonRaw === "pricing_error") reason = "Pricing error";
    else if (reasonRaw === "duplicate") reason = "Duplicate transaction";
    else if (reasonRaw === "payment_issue") reason = "Payment issue";
    else if (reasonRaw === "other") reason = "Other";
    const handledBy =
      d.resolved_by_admin_name ||
      d.cashier_name ||
      "—";
    const when = d.resolved_at || d.created_at || null;
    const whenLabel = when ? fmtFullDate(when) : "—";

    return `
      <div class="void-refunds-list-item d-flex justify-content-between align-items-start gap-2 border px-2 py-2">
        <div class="d-flex flex-column gap-1">
          <div class="d-flex align-items-center gap-2">
            <span class="badge ${pillClass}">${typeLabel}</span>
            <span class="fw-semibold">Sale #${saleNumber || "—"}</span>
          </div>
          <div class="text-muted">
            <span class="me-2">${truncateWithEllipsis(customer, 40)}</span>
            <span class="fw-semibold text-danger">${fmtPeso(amount)}</span>
          </div>
          <div class="text-muted small">
            Reason: ${truncateWithEllipsis(reason || "—", 60)}
          </div>
        </div>
        <div class="text-end small text-muted">
          <div>${whenLabel}</div>
          <div>Handled by ${truncateWithEllipsis(handledBy, 32)}</div>
        </div>
      </div>`;
  });

  list.innerHTML = items.join("");

  if (toggleBtn) {
    toggleBtn.classList.remove("d-none");
    toggleBtn.setAttribute("data-expanded", "false");
    list.classList.add("d-none");
  }
}

function setOfflineIndicator() {
  const el = document.getElementById("reports-offline-indicator");
  if (!el) return;
  const offline = typeof navigator !== "undefined" && navigator.onLine === false;
  el.classList.toggle("d-none", !offline);
}

function setKpis(summary) {
  const totals = summary?.totals || {};
  const prev = summary?.previous || {};

  const salesEl = document.getElementById("kpi-total-sales");
  const payEl = document.getElementById("kpi-total-payments");
  const outEl = document.getElementById("kpi-outstanding");
  const txEl = document.getElementById("kpi-total-tx");

  if (salesEl) salesEl.textContent = fmtPeso(totals.totalSales || 0);
  if (payEl) payEl.textContent = fmtPeso(totals.totalPayments || 0);
  if (outEl) outEl.textContent = fmtPeso(totals.outstandingBalance || 0);
  if (txEl) txEl.textContent = fmtCount(totals.totalTransactions || 0);

  const salesDeltaEl = document.getElementById("kpi-total-sales-delta");
  const payDeltaEl = document.getElementById("kpi-total-payments-delta");
  const txDeltaEl = document.getElementById("kpi-total-tx-delta");

  function pct(current, previous) {
    const c = Number(current || 0);
    const p = Number(previous || 0);
    if (p === 0) return c === 0 ? 0 : null;
    return ((c - p) / p) * 100;
  }

  const sPct = pct(totals.totalSales, prev.totalSales);
  const pPct = pct(totals.totalPayments, prev.totalPayments);
  const tPct = pct(totals.totalTransactions, prev.totalTransactions);

  if (salesDeltaEl) {
    if (sPct == null) salesDeltaEl.textContent = "No previous period";
    else salesDeltaEl.textContent = `${sPct >= 0 ? "▲" : "▼"} ${Math.abs(sPct).toFixed(1)}% vs previous`;
    salesDeltaEl.className = `stat-meta ${sPct == null ? "text-muted" : sPct >= 0 ? "text-success" : "text-danger"}`;
  }
  if (payDeltaEl) {
    if (pPct == null) payDeltaEl.textContent = "No previous period";
    else payDeltaEl.textContent = `${pPct >= 0 ? "▲" : "▼"} ${Math.abs(pPct).toFixed(1)}% vs previous`;
    payDeltaEl.className = `stat-meta ${pPct == null ? "text-muted" : pPct >= 0 ? "text-success" : "text-danger"}`;
  }
  if (txDeltaEl) {
    if (tPct == null) txDeltaEl.textContent = "No previous period";
    else txDeltaEl.textContent = `${tPct >= 0 ? "▲" : "▼"} ${Math.abs(tPct).toFixed(1)}% vs previous`;
    txDeltaEl.className = `stat-meta ${tPct == null ? "text-muted" : tPct >= 0 ? "text-success" : "text-danger"}`;
  }
}

function setRangeLabel(summary, collections) {
  const label = document.getElementById("label-daily-range");
  if (!label) return;

  const start = summary?.range?.start || reportState.start;
  const end = summary?.range?.end || reportState.end;
  if (start && end) {
    label.textContent = `${fmtFullDate(start)} → ${fmtFullDate(end)}`;
    return;
  }

  const docs = Array.isArray(collections?.daily_sales) ? collections.daily_sales : [];
  if (docs.length) {
    const first = (docs[0]?.date || "").toString().slice(0, 10);
    const last = (docs[docs.length - 1]?.date || "").toString().slice(0, 10);
    if (first && last) label.textContent = `${fmtFullDate(first)} → ${fmtFullDate(last)}`;
  }
}

async function loadReportsAndRender({ force = false } = {}) {
  try {
    setOfflineIndicator();
    setLoading(true);
    setStatus("Loading reports…", "info");
    const payload = await fetchAllReports({ start: reportState.start, end: reportState.end, force });
    const collections = payload.data || {};
    const summary = payload.summary || {};

    renderDailySales(collections);
    renderTopProducts(collections);
    renderCustomerBalances(collections);
    renderVoidedRefunded(collections);
    setKpis(summary);
    setRangeLabel(summary, collections);

    setStatus("Reports loaded.", "success");
    document.body.classList.remove("page-loading");
  } catch (err) {
    console.error("load reports error", err);
    setStatus(err.message || "Failed to load reports.", "danger");
  } finally {
    setLoading(false);
  }
}

function initDateRangeControls() {
  const startEl = document.getElementById("reports-start-date");
  const endEl = document.getElementById("reports-end-date");
  if (!startEl || !endEl) return;

  const today = new Date();
  const defaultEnd = toISODateOnly(today);
  const defaultStart = toISODateOnly(new Date(today.getTime() - 6 * 86400000));

  reportState.start = clampISODate(startEl.value) || defaultStart;
  reportState.end = clampISODate(endEl.value) || defaultEnd;
  startEl.value = reportState.start;
  endEl.value = reportState.end;

  function commitFromInputs() {
    reportState.start = clampISODate(startEl.value);
    reportState.end = clampISODate(endEl.value);
    if (reportState.start && reportState.end && reportState.start > reportState.end) {
      const tmp = reportState.start;
      reportState.start = reportState.end;
      reportState.end = tmp;
      startEl.value = reportState.start;
      endEl.value = reportState.end;
    }
    loadReportsAndRender();
  }

  startEl.addEventListener("change", commitFromInputs);
  endEl.addEventListener("change", commitFromInputs);

  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-range]");
    if (!btn) return;
    const range = btn.getAttribute("data-range");
    const now = new Date();
    let s = null;
    let en = null;
    if (range === "today") {
      s = toISODateOnly(now);
      en = toISODateOnly(now);
    } else if (range === "last7") {
      en = toISODateOnly(now);
      s = toISODateOnly(new Date(now.getTime() - 6 * 86400000));
    } else if (range === "month") {
      const first = new Date(now.getFullYear(), now.getMonth(), 1);
      s = toISODateOnly(first);
      en = toISODateOnly(now);
    }
    if (s && en) {
      startEl.value = s;
      endEl.value = en;
      reportState.start = s;
      reportState.end = en;
      loadReportsAndRender();
    }
  });
}

function initReportsPage() {
  if (document.body?.dataset.page !== "reports") return;

  initDateRangeControls();
  setOfflineIndicator();

  if (!globalOnlineListenersBound) {
    window.addEventListener("online", setOfflineIndicator);
    window.addEventListener("offline", setOfflineIndicator);
    globalOnlineListenersBound = true;
  }

  const refreshBtn = document.getElementById("btn-refresh-reports");
  if (refreshBtn && !refreshBtn.dataset.reportsBound) {
    refreshBtn.dataset.reportsBound = "1";
    refreshBtn.addEventListener("click", (e) => {
      e.preventDefault();
      if (reportState.loading) return;
      loadReportsAndRender({ force: true });
    });
  }

  if (!document.body.dataset.balancesToggleBound) {
    document.body.dataset.balancesToggleBound = "1";
    document.addEventListener("click", (e) => {
      const toggleBtn = e.target.closest("#toggle-balances-list");
      if (!toggleBtn) return;
      const expanded = toggleBtn.getAttribute("data-expanded") === "true";
      const container = document.getElementById("customer-balances-list");
      if (!container) return;
      const extras = container.querySelectorAll(".extra-balance");
      extras.forEach((el) => {
        el.classList.toggle("d-none", expanded);
      });
      toggleBtn.setAttribute("data-expanded", (!expanded).toString());
      toggleBtn.textContent = expanded ? "View more" : "View less";
    });
  }

  if (!document.body.dataset.voidRefundsToggleBound) {
    document.body.dataset.voidRefundsToggleBound = "1";
    document.addEventListener("click", (e) => {
      const btn = e.target.closest("#btn-toggle-void-refunds");
      if (!btn) return;
      const list = document.getElementById("void-refunds-list");
      if (!list) return;
      const expanded = btn.getAttribute("data-expanded") === "true";
      list.classList.toggle("d-none", expanded);
      btn.setAttribute("data-expanded", (!expanded).toString());
      btn.textContent = expanded ? "Show details" : "Hide details";
    });
  }

  loadReportsAndRender();
}

function onReportsDomReady() {
  initReportsPage();
}

if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", onReportsDomReady);
} else {
  // When this module is loaded after DOMContentLoaded (for example,
  // when navigating via the in-app PJAX router), run initialization
  // immediately so the Refresh button and date pickers are wired up.
  onReportsDomReady();
}

window.addEventListener("pjax:complete", (e) => {
  if (e.detail && e.detail.page === "reports") {
    initReportsPage();
  }
});

window.addEventListener("central:refresh", () => {
  if (document.body?.dataset.page === "reports") {
    loadReportsAndRender();
  }
});