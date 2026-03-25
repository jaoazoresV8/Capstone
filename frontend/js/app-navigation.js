
(function () {
  var PREF_ALLOW_HOTKEYS_KEY = "sm_pref_allow_hotkeys";
  var PAGES = {
    "dashboard.html": "overview",
    "products.html": "products",
    "customers.html": "customers",
    "sales.html": "sales",
    "payments.html": "payments",
    "reports.html": "reports",
    "users.html": "users",
  };

 
  var PAGE_SCRIPTS = {
    "sales": ["/js/sales.js"],
    "products": ["/js/products.js"],
    "customers": ["/js/customers.js"],
    "payments": ["/js/payments.js"],
    "reports": ["/js/reports.js"],
    "users": ["/js/users.js"],
  };

  function getPageFromHref(href) {
    try {
      var path = new URL(href, window.location.origin).pathname;
      var name = path.split("/").pop() || "";
      return PAGES[name] ? name : null;
    } catch {
      return null;
    }
  }

  function isSameOrigin(href) {
    try {
      return new URL(href, window.location.origin).origin === window.location.origin;
    } catch {
      return false;
    }
  }

  function setActivePage(page) {
    document.body.dataset.page = page;
    document.querySelectorAll("[data-page-link]").forEach(function (link) {
      link.classList.remove("active");
      if (link.dataset.pageLink === page) link.classList.add("active");
    });
  }

 
  function ensureModalDraggable() {
    if (document.querySelector('script[src*="modal-draggable"]')) return;
    var script = document.createElement("script");
    script.src = "/js/modal-draggable.js";
    script.async = false;
    document.body.appendChild(script);
  }

  function ensureViewToggle() {
    if (document.querySelector('script[src*="view-toggle.js"]')) return;
    var script = document.createElement("script");
    script.src = "/js/view-toggle.js";
    script.async = false;
    document.body.appendChild(script);
  }

 
  function loadPageScripts(page) {
    ensureModalDraggable();
    ensureViewToggle();
    var scripts = PAGE_SCRIPTS[page];
    if (!scripts || !scripts.length) return;
    scripts.forEach(function (src) {
      var name = src.split("/").pop();
      if (document.querySelector('script[src*="' + name + '"]')) return;
      var script = document.createElement("script");
      script.src = src;
      script.type = "module";
      document.body.appendChild(script);
    });
  }

  function loadPage(url, push) {
    var pageFile = getPageFromHref(url);
    if (!pageFile) return;

    fetch(url, { headers: { "X-Requested-With": "XMLHttpRequest" } })
      .then(function (r) { return r.text(); })
      .then(function (html) {
        var parser = new DOMParser();
        var doc = parser.parseFromString(html, "text/html");
        var newMain = doc.querySelector("main");
        var newTitle = doc.querySelector("title");
        var main = document.querySelector("main");
        if (newMain && main) {
          main.innerHTML = newMain.innerHTML;
          syncNavHeightVar();
          if (newTitle) document.title = newTitle.textContent;
          var page = PAGES[pageFile];
          if (page) {
            setActivePage(page);
            loadPageScripts(page);
            
            setTimeout(function() {
              window.dispatchEvent(new CustomEvent("pjax:complete", { 
                detail: { page: page, url: url },
                bubbles: true
              }));
            }, 50);
          }
          if (push !== false) history.pushState({ pjax: true, url: url, page: page }, "", url);
          restorePageUiAfterRefresh();
        }
      })
      .catch(function () { window.location.href = url; });
  }

  document.addEventListener("click", function (e) {
    var a = e.target.closest("a[href]");
    if (!a || a.target === "_blank" || a.hasAttribute("download")) return;
    var href = a.getAttribute("href");
    if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:")) return;
    if (!isSameOrigin(href)) return;
    var pageFile = getPageFromHref(href);
    if (!pageFile) return;
    e.preventDefault();
    loadPage(href, true);
  }, false);

  window.addEventListener("popstate", function (e) {
    if (e.state && e.state.pjax && e.state.url) {
      loadPage(e.state.url, false);
    }
  });

  window.addEventListener("app:refresh", function () {
    try {
      var url = window.location.href;
      var pageFile = getPageFromHref(url);
      if (!pageFile) {
        window.location.reload();
        return;
      }
      loadPage(url, false);
    } catch {
      window.location.reload();
    }
  });

  function syncNavHeightVar() {
    try {
      var nav = document.querySelector(".app-navbar");
      if (!nav || !document.documentElement || !document.documentElement.style) return;
      var h = Math.ceil(nav.getBoundingClientRect().height || nav.offsetHeight || 60);
      if (h > 0) {
        document.documentElement.style.setProperty("--dm-nav-height", h + "px");
        var main = document.querySelector(".app-main");
        if (main && main.style) {
          main.style.paddingTop = (h + 24) + "px";
        }
      }
    } catch (_) {}
  }

  function restorePageUiAfterRefresh() {
    try {
      if (document.body) {
        document.body.classList.remove("page-loading");
      }
      syncNavHeightVar();
      if (typeof history !== "undefined" && history.scrollRestoration) {
        history.scrollRestoration = "manual";
      }
      window.scrollTo(0, 0);
      if (document.documentElement) document.documentElement.scrollTop = 0;
      if (document.body) document.body.scrollTop = 0;
      var m = document.querySelector(".app-main");
      if (m) m.scrollTop = 0;
    } catch (_) {}
  }

  function ensureGlobalScripts() {
    ensureModalDraggable();
    ensureViewToggle();
    syncNavHeightVar();
  }

  // Treat browser refresh same as nav refresh: reset scroll to top (window + fixed .app-main).
  function applyRefreshScrollBehavior() {
    try {
      if (typeof history !== "undefined" && history.scrollRestoration) {
        history.scrollRestoration = "manual";
      }
      window.scrollTo(0, 0);
      if (document.documentElement) document.documentElement.scrollTop = 0;
      if (document.body) document.body.scrollTop = 0;
      var main = document.querySelector(".app-main");
      if (main) main.scrollTop = 0;
    } catch (_) {}
  }

  window.addEventListener("pageshow", function (e) {
    if (e.persisted) applyRefreshScrollBehavior();
    syncNavHeightVar();
    requestAnimationFrame(restorePageUiAfterRefresh);
  });

  // Disable browser refresh via keyboard (F5, Ctrl+R, Cmd+R)
  window.addEventListener("keydown", function (e) {
    if (e.key === "F5" || ((e.ctrlKey || e.metaKey) && e.key === "r")) {
      e.preventDefault();
    }
  });

  function isEditableTarget(target) {
    if (!target) return false;
    try {
      var tag = (target.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return true;
      if (target.isContentEditable) return true;
      return false;
    } catch {
      return false;
    }
  }

  function goToPage(pageId) {
    if (!pageId || !document.body) return;
    if (document.body.dataset.page === pageId) return;
    var link = document.querySelector('[data-page-link="' + pageId + '"]');
    if (!link) return;
    var href = link.getAttribute("href");
    if (!href) return;
    loadPage(href, true);
  }

  function focusAndSelectIfInput(el) {
    if (!el) return;
    try {
      el.focus();
      if (el.select && el.type === "text") {
        el.select();
      }
    } catch {
      // ignore
    }
  }

  function handleGlobalShortcut(e) {
    try {
      var hotkeysRaw = localStorage.getItem(PREF_ALLOW_HOTKEYS_KEY);
      var allowHotkeys = hotkeysRaw == null ? true : hotkeysRaw === "1";
      if (!allowHotkeys) return false;
    } catch (_) {
      // If localStorage fails, keep hotkeys enabled.
    }

    var isElectron =
      document && document.documentElement && document.documentElement.classList
        ? document.documentElement.classList.contains("is-electron")
        : false;
    if (!isElectron) {
      try {
        isElectron = /electron/i.test((navigator && navigator.userAgent) || "");
      } catch (_) {
        isElectron = false;
      }
    }

    // In normal browsers, Alt+1..7 is commonly intercepted by the browser UI (tab shortcuts, etc.)
    // so we switch to Ctrl+Alt+1..7 to avoid double-actions in web mode.
    if (isElectron ? (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) : (e.altKey && e.ctrlKey && !e.metaKey && !e.shiftKey)) {
      if (isEditableTarget(e.target)) return false;
      var key = e.key;
      switch (key) {
        case "1":
          goToPage("overview");
          break;
        case "2":
          goToPage("products");
          break;
        case "3":
          goToPage("customers");
          break;
        case "4":
          goToPage("sales");
          break;
        case "5":
          goToPage("payments");
          break;
        case "6":
          goToPage("reports");
          break;
        case "7":
          goToPage("users");
          break;
        case "r":
        case "R":
          var refreshBtn = document.getElementById("nav-refresh-btn");
          if (refreshBtn) refreshBtn.click();
          break;
        default:
          return false;
      }
      e.preventDefault();
      return true;
    }

    if (e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey) {
      if (isEditableTarget(e.target)) return false;
      var page = (document.body && document.body.dataset && document.body.dataset.page) || "";
      var k = (e.key || "").toLowerCase();

      if (k === "n") {
        if (page === "products") {
          var addProductBtn = document.getElementById("btn-add-product");
          if (addProductBtn) addProductBtn.click();
        } else if (page === "sales") {
          var newSaleBtn = document.getElementById("btn-new-sale");
          if (newSaleBtn) newSaleBtn.click();
        } else if (page === "users") {
          var addUserBtn = document.getElementById("add-user-btn");
          if (addUserBtn) addUserBtn.click();
        }
        e.preventDefault();
        return true;
      }

      if (k === "f") {
        if (page === "products") {
          focusAndSelectIfInput(document.getElementById("product-search-filter"));
        } else if (page === "customers") {
          focusAndSelectIfInput(document.getElementById("customer-search"));
        } else if (page === "sales") {
          focusAndSelectIfInput(document.getElementById("sales-search"));
        } else if (page === "payments") {
          focusAndSelectIfInput(document.getElementById("payments-search"));
        }
        e.preventDefault();
        return true;
      }

      if (k === "r" && page === "reports") {
        var reportsRefreshBtn = document.getElementById("btn-refresh-reports");
        if (reportsRefreshBtn) reportsRefreshBtn.click();
        e.preventDefault();
        return true;
      }
    }

    return false;
  }

  document.addEventListener(
    "keydown",
    function (e) {
      try {
        handleGlobalShortcut(e);
      } catch {
        // ignore
      }
    },
    false
  );

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      ensureGlobalScripts();
      restorePageUiAfterRefresh();
      requestAnimationFrame(restorePageUiAfterRefresh);
      requestAnimationFrame(syncNavHeightVar);
    });
  } else {
    ensureGlobalScripts();
    restorePageUiAfterRefresh();
    requestAnimationFrame(restorePageUiAfterRefresh);
    requestAnimationFrame(syncNavHeightVar);
  }

  window.addEventListener("resize", syncNavHeightVar);
})();
