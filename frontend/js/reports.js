const REPORTS_API = "/api/reports";

let dailySalesChart = null;
let topProductsChart = null;
let customerBalancesChart = null;

function getAuthHeaders() {
  const token = localStorage.getItem("sm_token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function fetchAllReports() {
  const res = await fetch(`${REPORTS_API}/all`, {
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

function renderJson(targetId, value) {
  const el = document.getElementById(targetId);
  if (!el) return;
  el.textContent = JSON.stringify(value, null, 2);
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

function renderDailySales(collections) {
  const docs = Array.isArray(collections.daily_sales) ? collections.daily_sales.slice() : [];
  if (!docs.length) {
    destroyChart(dailySalesChart);
    dailySalesChart = null;
    return;
  }

  docs.sort((a, b) => new Date(a.date || a._id || 0) - new Date(b.date || b._id || 0));

  const labels = docs.map((d) => (d.date || d._id || "").toString().slice(0, 10));
  const sales = docs.map((d) => toNumber(d.totalSales ?? d.total_sales ?? d.sales));
  const payments = docs.map((d) => toNumber(d.totalPayments ?? d.total_payments ?? d.payments));

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
          backgroundColor: "rgba(13, 110, 253, 0.1)",
          tension: 0.3,
          fill: true,
        },
        {
          label: "Payments",
          data: payments,
          borderColor: "#20c997",
          backgroundColor: "rgba(32, 201, 151, 0.1)",
          tension: 0.3,
          fill: true,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: true,
        },
        tooltip: {
          mode: "index",
          intersect: false,
        },
      },
      scales: {
        x: {
          ticks: { maxRotation: 0 },
          grid: { display: false },
        },
        y: {
          beginAtZero: true,
        },
      },
    },
  });

  const label = document.getElementById("label-daily-range");
  if (label && labels.length) {
    label.textContent = `${labels[0]} → ${labels[labels.length - 1]}`;
  }
}

function renderTopProducts(collections) {
  const docs = Array.isArray(collections.top_products) ? collections.top_products.slice() : [];
  if (!docs.length) {
    destroyChart(topProductsChart);
    topProductsChart = null;
    return;
  }

  docs.sort((a, b) => toNumber(b.totalQty ?? b.total_qty ?? b.qty ?? b.count) - toNumber(a.totalQty ?? a.total_qty ?? a.qty ?? a.count));

  const top = docs.slice(0, 10);
  const labels = top.map((d) => (d.productName ?? d.product_name ?? d.name ?? "Product").toString());
  const values = top.map((d) => toNumber(d.totalQty ?? d.total_qty ?? d.qty ?? d.count));

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
      },
      scales: {
        x: {
          beginAtZero: true,
        },
      },
    },
  });
}

function renderCustomerBalances(collections) {
  const docs = Array.isArray(collections.customer_balances) ? collections.customer_balances.slice() : [];
  if (!docs.length) {
    destroyChart(customerBalancesChart);
    customerBalancesChart = null;
    return;
  }

  docs.sort((a, b) => toNumber(b.balance ?? b.totalBalance ?? b.total_balance) - toNumber(a.balance ?? a.totalBalance ?? a.total_balance));

  const top = docs.slice(0, 10);
  const labels = top.map((d) => (d.customerName ?? d.customer_name ?? d.name ?? "Customer").toString());
  const values = top.map((d) => toNumber(d.balance ?? d.totalBalance ?? d.total_balance));

  const ctx = document.getElementById("chart-customer-balances");
  if (!ctx) return;

  destroyChart(customerBalancesChart);
  customerBalancesChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
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
      },
      scales: {
        x: {
          beginAtZero: true,
        },
      },
    },
  });
}

async function loadReportsAndRender() {
  try {
    setStatus("Loading reports from MongoDB…", "info");
    const payload = await fetchAllReports();
    const collections = payload.data || {};

    renderJson("reports-raw-json", collections);
    renderDailySales(collections);
    renderTopProducts(collections);
    renderCustomerBalances(collections);

    setStatus("Reports loaded from MongoDB.", "success");
    document.body.classList.remove("page-loading");
  } catch (err) {
    console.error("load reports error", err);
    setStatus(err.message || "Failed to load reports.", "danger");
  }
}

window.addEventListener("DOMContentLoaded", () => {
  const refreshBtn = document.getElementById("btn-refresh-reports");
  if (refreshBtn) {
    refreshBtn.addEventListener("click", (e) => {
      e.preventDefault();
      loadReportsAndRender();
    });
  }

  loadReportsAndRender();
});

