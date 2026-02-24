
(function () {
  var PAGES = {
    "dashboard.html": "overview",
    "products.html": "products",
    "customers.html": "customers",
    "sales.html": "sales",
    "payments.html": "payments",
    "reports.html": "reports",
  };

 
  var PAGE_SCRIPTS = {
    "sales": ["/js/sales.js"],
    "products": ["/js/products.js"],
    "customers": ["/js/customers.js"],
    "payments": ["/js/payments.js"],
    "reports": ["/js/reports.js"],
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

 
  function loadPageScripts(page) {
    ensureModalDraggable();
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
          // Hard reset scroll so navbar is fully visible (avoid sticky jump)
          if (document.documentElement) document.documentElement.scrollTop = 0;
          if (document.body) document.body.scrollTop = 0;
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
    if (!pageFile || pageFile === "users.html") return;
    e.preventDefault();
    loadPage(href, true);
  }, false);

  window.addEventListener("popstate", function (e) {
    if (e.state && e.state.pjax && e.state.url) {
      loadPage(e.state.url, false);
    }
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", ensureModalDraggable);
  } else {
    ensureModalDraggable();
  }
})();
