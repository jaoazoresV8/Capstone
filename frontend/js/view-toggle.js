// Generic view toggle for table / card / kanban layouts
// Works with sections marked up as:
// .data-view-section[data-view-id]
//   .data-view-table-wrap > table
//   .data-view-cards
//   .data-view-kanban
// And a matching .view-toggle-group[data-view-target]

(function () {
  function $(selector, root) {
    return (root || document).querySelector(selector);
  }

  function $all(selector, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(selector));
  }

  function getCellText(cell) {
    return (cell && cell.textContent || "").trim();
  }

  function buildCardsFromTable(table) {
    const frag = document.createDocumentFragment();
    if (!table) return frag;

    const theadRow = $("thead tr", table);
    const headers = theadRow ? $all("th", theadRow).map((th) => getCellText(th)) : [];
    const rows = $all("tbody tr", table).filter(function (tr) {
      // Skip placeholder rows
      if (tr.dataset.viewPlaceholder) return false;
      // Skip detail/expanded rows (e.g. payments, customers)
      if (tr.hasAttribute("data-detail-row")) return false;
      return true;
    });

    const pageId = document.body && document.body.dataset && document.body.dataset.page || "";

    rows.forEach(function (tr) {
      const cells = $all("td", tr);
      if (!cells.length) return;

      const card = document.createElement("div");
      card.className = "data-card-item";

      const title = document.createElement("div");
      title.className = "data-card-title";
      title.textContent = getCellText(cells[0]);
      card.appendChild(title);

      const metaList = document.createElement("dl");
      metaList.className = "data-card-meta";

      // Try to detect an "Actions" column so we can render buttons separately
      var actionsIndex = -1;
      headers.forEach(function (h, idx) {
        if (h && h.toLowerCase() === "actions") {
          actionsIndex = idx;
        }
      });
      // Customers / Payments pages: last column (empty header) contains actions (Details/Pay)
      if (actionsIndex === -1 && (pageId === "customers" || pageId === "payments") && cells.length > 1) {
        actionsIndex = cells.length - 1;
      }
      var actionsCell = null;

      cells.forEach(function (td, idx) {
        if (idx === 0) return;

        // Hold actions cell for a dedicated actions row
        if (idx === actionsIndex) {
          actionsCell = td;
          return;
        }

        var label = headers[idx] || ("Field " + (idx + 1));
        var value = getCellText(td);

        var isProductsPage = pageId === "products";
        var isSupplierCol = label && label.toLowerCase() === "supplier";

        if (!value && !(isProductsPage && isSupplierCol)) return;

        var dt = document.createElement("dt");
        dt.textContent = label;
        var dd = document.createElement("dd");

        if (isProductsPage && isSupplierCol) {
          dd.innerHTML = td.innerHTML || "—";
        } else {
          dd.textContent = value;
        }

        metaList.appendChild(dt);
        metaList.appendChild(dd);
      });

      if (metaList.children.length) {
        card.appendChild(metaList);
      }

      // Render row actions (e.g. edit / info buttons) at the bottom of the card
      if (actionsCell && actionsCell.children && actionsCell.children.length) {
        var actionsWrap = document.createElement("div");
        actionsWrap.className = "data-card-actions";

        Array.prototype.forEach.call(actionsCell.children, function (child) {
          actionsWrap.appendChild(child.cloneNode(true));
        });

        card.appendChild(actionsWrap);
      }

      frag.appendChild(card);
    });

    return frag;
  }

  function buildKanbanFromTable(table, groupByHeaderText) {
    const wrapper = document.createElement("div");
    wrapper.className = "data-kanban-board";
    if (!table) return wrapper;

    const theadRow = $("thead tr", table);
    const headers = theadRow ? $all("th", theadRow).map((th) => getCellText(th)) : [];

    let groupIndex = -1;
    if (groupByHeaderText) {
      const target = groupByHeaderText.toLowerCase();
      headers.forEach(function (h, idx) {
        if (groupIndex === -1 && h.toLowerCase() === target) {
          groupIndex = idx;
        }
      });
    }
    if (groupIndex === -1 && headers.length) {
      groupIndex = headers.length - 1;
    }
    if (groupIndex === -1) return wrapper;

    const rows = $all("tbody tr", table).filter(function (tr) {
      // Skip placeholder rows
      if (tr.dataset.viewPlaceholder) return false;
      // Skip detail/expanded rows (e.g. payments, customers)
      if (tr.hasAttribute("data-detail-row")) return false;
      return true;
    });

    const groups = Object.create(null);
    rows.forEach(function (tr) {
      const cells = $all("td", tr);
      if (!cells.length) return;
      const key = getCellText(cells[groupIndex]) || "Uncategorized";
      if (!groups[key]) groups[key] = [];
      groups[key].push(cells);
    });

    const pageId = document.body && document.body.dataset && document.body.dataset.page || "";

    Object.keys(groups).sort().forEach(function (status) {
      const col = document.createElement("div");
      col.className = "data-kanban-column";

      const header = document.createElement("div");
      header.className = "data-kanban-column-header";
      header.textContent = status;
      col.appendChild(header);

      const body = document.createElement("div");
      body.className = "data-kanban-column-body";

      groups[status].forEach(function (cells) {
        const card = document.createElement("div");
        card.className = "data-kanban-card";

        const title = document.createElement("div");
        title.className = "data-kanban-card-title";
        title.textContent = getCellText(cells[0]);
        card.appendChild(title);

        const meta = document.createElement("dl");
        meta.className = "data-kanban-card-meta";

        // Detect actions column
        var actionsIndex = -1;
        headers.forEach(function (h, idx) {
          if (h && h.toLowerCase() === "actions") {
            actionsIndex = idx;
          }
        });
        // Customers / Payments pages: last column has actions (Details/Pay)
        if (actionsIndex === -1 && (pageId === "customers" || pageId === "payments") && cells.length > 1) {
          actionsIndex = cells.length - 1;
        }
        var actionsCell = null;

        cells.forEach(function (td, idx) {
          if (idx === 0 || idx === groupIndex) return;

          if (idx === actionsIndex) {
            actionsCell = td;
            return;
          }

          var label = headers[idx] || ("Field " + (idx + 1));
          var value = getCellText(td);

          var isProductsPage = pageId === "products";
          var isSupplierCol = label && label.toLowerCase() === "supplier";

          if (!value && !(isProductsPage && isSupplierCol)) return;

          var dt = document.createElement("dt");
          dt.textContent = label;
          var dd = document.createElement("dd");

          if (isProductsPage && isSupplierCol) {
            dd.innerHTML = td.innerHTML || "—";
          } else {
            dd.textContent = value;
          }

          meta.appendChild(dt);
          meta.appendChild(dd);
        });

        if (meta.children.length) {
          card.appendChild(meta);
        }

        if (actionsCell && actionsCell.children && actionsCell.children.length) {
          var actionsWrap = document.createElement("div");
          actionsWrap.className = "data-kanban-card-actions";
          Array.prototype.forEach.call(actionsCell.children, function (child) {
            actionsWrap.appendChild(child.cloneNode(true));
          });
          card.appendChild(actionsWrap);
        }

        body.appendChild(card);
      });

      col.appendChild(body);
      wrapper.appendChild(col);
    });

    return wrapper;
  }

  function initSection(section) {
    const viewId = section.dataset.viewId || "";
    if (!viewId) return;

    const toggleGroup = document.querySelector('.view-toggle-group[data-view-target="' + viewId + '"]');
    if (!toggleGroup) return;

    const tableWrap = $(".data-view-table-wrap", section);
    const table = tableWrap ? $("table", tableWrap) : null;
    const cardsContainer = $(".data-view-cards", section);
    const kanbanContainer = $(".data-view-kanban", section);

    if (!table || !cardsContainer || !kanbanContainer) return;

    function setActiveButton(view) {
      $all(".view-toggle-btn", toggleGroup).forEach(function (btn) {
        if (btn.dataset.view === view) {
          btn.classList.add("active");
        } else {
          btn.classList.remove("active");
        }
      });
    }

    function showView(view) {
      if (view === "table") {
        tableWrap.classList.remove("d-none");
        cardsContainer.classList.add("d-none");
        kanbanContainer.classList.add("d-none");
      } else if (view === "card") {
        cardsContainer.innerHTML = "";
        cardsContainer.appendChild(buildCardsFromTable(table));
        tableWrap.classList.add("d-none");
        cardsContainer.classList.remove("d-none");
        kanbanContainer.classList.add("d-none");
      } else if (view === "kanban") {
        const groupBy = table.getAttribute("data-kanban-header") || "";
        kanbanContainer.innerHTML = "";
        kanbanContainer.appendChild(buildKanbanFromTable(table, groupBy));
        tableWrap.classList.add("d-none");
        cardsContainer.classList.add("d-none");
        kanbanContainer.classList.remove("d-none");
      }
      setActiveButton(view);
    }

    toggleGroup.addEventListener("click", function (evt) {
      const btn = evt.target.closest(".view-toggle-btn");
      if (!btn) return;
      const view = btn.dataset.view;
      if (!view) return;
      showView(view);
    });

    // Allow pages to request a rebuild of the current view
    // after table rows change (e.g., search/filter or reload).
    section.addEventListener("data-view:refresh", function () {
      const activeBtn =
        toggleGroup.querySelector(".view-toggle-btn.active") ||
        toggleGroup.querySelector('.view-toggle-btn[data-view="table"]');
      const currentView = activeBtn && activeBtn.dataset.view ? activeBtn.dataset.view : "table";
      showView(currentView);
    });

    // Start in table view
    showView("table");
  }

  function initAllSections() {
    $all(".data-view-section").forEach(initSection);
  }

  // Initial load
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initAllSections);
  } else {
    initAllSections();
  }

  // Re-init after PJAX navigation completes (see app-navigation.js)
  window.addEventListener("pjax:complete", function () {
    initAllSections();
  });
})();
