/* Single navbar template – runs synchronously so nav is in DOM before main content parses (no flicker). */
(function () {
  try {
    var ua = (typeof navigator !== "undefined" && navigator.userAgent) ? String(navigator.userAgent) : "";
    var isElectron =
      /electron/i.test(ua) ||
      (typeof window !== "undefined" &&
        window.process &&
        window.process.versions &&
        window.process.versions.electron);
    if (isElectron && document && document.documentElement) {
      document.documentElement.classList.add("is-electron");
    }
  } catch {
    // ignore
  }

  var activePage = (document.body && document.body.dataset.page) ? document.body.dataset.page : "overview";
  var active = function (page) { return page === activePage ? " active" : ""; };
  var html =
    '<nav class="navbar navbar-expand-lg navbar-dark app-navbar fixed-top">' +
    '  <div class="container-fluid">' +
    '    <a class="navbar-brand" href="./dashboard.html">' +
    '      <i class="bi bi-shop"></i> D&amp;M Sales' +
    '    </a>' +
    '    <button class="navbar-toggler" type="button" data-bs-toggle="collapse" data-bs-target="#navbarMain" aria-controls="navbarMain" aria-expanded="false" aria-label="Toggle navigation">' +
    '      <span class="navbar-toggler-icon"></span>' +
    '    </button>' +
    '    <div class="collapse navbar-collapse" id="navbarMain">' +
    '      <ul class="navbar-nav me-auto mb-2 mb-lg-0">' +
    '        <li class="nav-item"><a class="nav-link' + active("overview") + '" data-page-link="overview" href="./dashboard.html"><i class="bi bi-grid-1x2-fill"></i> Overview</a></li>' +
    '        <li class="nav-item"><a class="nav-link' + active("products") + '" data-page-link="products" href="./products.html"><i class="bi bi-box-seam"></i> Products</a></li>' +
    '        <li class="nav-item"><a class="nav-link' + active("customers") + '" data-page-link="customers" href="./customers.html"><i class="bi bi-people"></i> Customers</a></li>' +
    '        <li class="nav-item"><a class="nav-link' + active("sales") + '" data-page-link="sales" href="./sales.html"><i class="bi bi-receipt"></i> Sales</a></li>' +
    '        <li class="nav-item"><a class="nav-link' + active("payments") + '" data-page-link="payments" href="./payments.html"><i class="bi bi-cash-coin"></i> Payments</a></li>' +
    '        <li class="nav-item"><a class="nav-link' + active("reports") + '" data-page-link="reports" href="./reports.html"><i class="bi bi-graph-up"></i> Reports</a></li>' +
    '        <li class="nav-item" data-admin-only="true"><a class="nav-link' + active("users") + '" data-page-link="users" href="./users.html"><i class="bi bi-person-gear"></i> Users</a></li>' +
    '      </ul>' +
    '      <div class="d-flex align-items-center gap-3">' +
    '        <div id="nav-sync-indicator" class="nav-sync-indicator small text-muted d-flex align-items-center">' +
    '          <span class="spinner-border spinner-border-sm me-1 d-none" id="nav-sync-spinner" role="status" aria-hidden="true"></span>' +
    '          <i class="bi bi-cloud-slash me-1" id="nav-sync-icon" aria-hidden="true"></i>' +
    '          <span id="nav-sync-text">Checking sync…</span>' +
    '        </div>' +
    '        <button type="button" class="btn btn-outline-light btn-sm" id="nav-refresh-btn" title="Refresh this page">' +
    '          <i class="bi bi-arrow-clockwise"></i>' +
    '        </button>' +
    '        <div class="dropdown nav-user-dropdown">' +
    '          <button class="btn btn-link dropdown-toggle text-decoration-none d-flex align-items-center" type="button" id="navUserDropdown" data-bs-toggle="dropdown" aria-expanded="false">' +
    '            <i class="bi bi-person-circle"></i> <span id="nav-user-name">User</span><span id="nav-sale-issues-dot" class="nav-admin-dot d-none" aria-label="Open sale issues"></span><span id="nav-admin-reset-dot" class="nav-admin-dot d-none" aria-label="Pending password reset requests"></span>' +
    '          </button>' +
    '          <ul class="dropdown-menu dropdown-menu-end" aria-labelledby="navUserDropdown">' +
    '            <li data-admin-only="true"><button type="button" id="btn-open-sale-issues" class="dropdown-item"><i class="bi bi-flag-fill me-2"></i> Sale issues <span id="nav-sale-issues-count" class="badge bg-danger ms-2 d-none">0</span></button></li>' +
    '            <li data-admin-only="true"><button type="button" id="btn-open-password-requests" class="dropdown-item"><i class="bi bi-exclamation-circle me-2"></i> Password requests <span id="nav-admin-reset-count" class="badge bg-danger ms-2 d-none">0</span></button></li>' +
    '            <li data-app-settings="true"><button type="button" id="btn-open-app-settings" class="dropdown-item"><i class="bi bi-sliders me-2"></i> App settings</button></li>' +
    '            <li data-admin-only="true"><hr class="dropdown-divider"></li>' +
    '            <li><button type="button" id="logout-btn" class="dropdown-item danger"><i class="bi bi-box-arrow-right me-2"></i> Logout</button></li>' +
    '          </ul>' +
    '        </div>' +
    '      </div>' +
    '    </div>' +
    '  </div>' +
    '</nav>' +
    // Admin modal for password reset requests
    '<div class="modal fade" id="passwordRequestsModal" tabindex="-1" aria-labelledby="passwordRequestsModalLabel" aria-hidden="true">' +
    '  <div class="modal-dialog modal-lg">' +
    '    <div class="modal-content">' +
    '      <div class="modal-header py-2">' +
    '        <h6 class="modal-title mb-0" id="passwordRequestsModalLabel">Password reset requests</h6>' +
    '        <button type="button" class="btn-close btn-close-sm" data-bs-dismiss="modal" aria-label="Close"></button>' +
    '      </div>' +
    '      <div class="modal-body py-2 small">' +
    '        <div id="password-requests-alert" class="alert alert-info py-1 small d-none"></div>' +
    '        <div class="table-responsive">' +
    '          <table class="table table-sm align-middle mb-0 small">' +
    '            <thead><tr><th>Username</th><th>Email</th><th>Requested</th><th>Status</th><th>New password</th><th class="text-end">Action</th></tr></thead>' +
    '            <tbody id="password-requests-tbody">' +
    '              <tr><td colspan="6" class="text-muted small">Loading…</td></tr>' +
    '            </tbody>' +
    '          </table>' +
    '        </div>' +
    '      </div>' +
    '      <div class="modal-footer py-2">' +
    '        <button type="button" class="btn btn-outline-secondary btn-sm" data-bs-dismiss="modal">Close</button>' +
    '      </div>' +
    '    </div>' +
    '  </div>' +
    '</div>' +
    // Admin modal for sale issues
    '<div class="modal fade" id="saleIssuesModal" tabindex="-1" aria-labelledby="saleIssuesModalLabel" aria-hidden="true">' +
    '  <div class="modal-dialog modal-lg">' +
    '    <div class="modal-content">' +
    '      <div class="modal-header py-2">' +
    '        <h6 class="modal-title mb-0" id="saleIssuesModalLabel">Flagged sale issues</h6>' +
    '        <button type="button" class="btn-close btn-close-sm" data-bs-dismiss="modal" aria-label="Close"></button>' +
    '      </div>' +
    '      <div class="modal-body py-2 small">' +
    '        <div id="sale-issues-alert" class="alert alert-info py-1 small d-none"></div>' +
    '        <div class="table-responsive">' +
    '          <table class="table table-sm align-middle mb-0 small">' +
    '            <thead><tr><th>Sale #</th><th>Customer</th><th>Reason</th><th>Flagged by</th><th>Flagged at</th><th>Status</th><th class="text-end">Action</th></tr></thead>' +
    '            <tbody id="sale-issues-tbody">' +
    '              <tr><td colspan="7" class="text-muted small">Loading…</td></tr>' +
    '            </tbody>' +
    '          </table>' +
    '        </div>' +
    '      </div>' +
    '      <div class="modal-footer py-2">' +
    '        <button type="button" class="btn btn-outline-secondary btn-sm" data-bs-dismiss="modal">Close</button>' +
    '      </div>' +
    '    </div>' +
    '  </div>' +
    '</div>';

  html +=
    // Admin modal for app settings (Client ID + central server)
    '<div class="modal fade" id="appSettingsModal" tabindex="-1" aria-labelledby="appSettingsModalLabel" aria-hidden="true">' +
    '  <div class="modal-dialog modal-md">' +
    '    <div class="modal-content">' +
    '      <div class="modal-header py-2">' +
    '        <h6 class="modal-title mb-0" id="appSettingsModalLabel">App settings</h6>' +
    '        <button type="button" class="btn-close btn-close-sm" data-bs-dismiss="modal" aria-label="Close"></button>' +
    '      </div>' +
    '      <div class="modal-body small">' +
    '        <div class="mb-2 text-muted">Central sync configuration for this device.</div>' +
    '        <div class="mb-3">' +
    '          <label for="settings-client-id" class="form-label small mb-1 text-muted">Client ID</label>' +
    '          <input type="text" id="settings-client-id" class="form-control form-control-sm" placeholder="e.g. branch-01" maxlength="64" tabindex="1" />' +
    '          <div class="form-text">Used to identify this device when syncing with central.</div>' +
    '          <div id="client-id-feedback" class="small mt-1"></div>' +
    '        </div>' +
    '        <div class="nav-settings-sep my-2" aria-hidden="true"><span class="nav-settings-sep-dot"></span><span class="nav-settings-sep-dot"></span><span class="nav-settings-sep-dot"></span></div>' +
    '        <div class="mb-2">' +
    '          <label for="settings-central-octet-0" class="form-label small mb-1 text-muted">Central server address</label>' +
    '          <div class="sm-central-addr" role="group" aria-label="Central server IPv4 address and port">' +
    '            <select id="settings-central-scheme" class="form-select form-select-sm sm-central-scheme" aria-label="Scheme" tabindex="2">' +
    '              <option value="http">http</option>' +
    '              <option value="https">https</option>' +
    '            </select>' +
    '            <span class="sm-central-scheme-sep" aria-hidden="true">://</span>' +
    '            <div class="sm-ipv4-input" id="settings-central-ipv4" aria-label="IPv4 address">' +
    '              <input type="text" inputmode="numeric" pattern="[0-9]*" id="settings-central-octet-0" class="sm-ipv4-octet" maxlength="3" aria-label="Octet 1" />' +
    '              <span class="sm-ipv4-dot" aria-hidden="true">.</span>' +
    '              <input type="text" inputmode="numeric" pattern="[0-9]*" id="settings-central-octet-1" class="sm-ipv4-octet" maxlength="3" aria-label="Octet 2" />' +
    '              <span class="sm-ipv4-dot" aria-hidden="true">.</span>' +
    '              <input type="text" inputmode="numeric" pattern="[0-9]*" id="settings-central-octet-2" class="sm-ipv4-octet" maxlength="3" aria-label="Octet 3" />' +
    '              <span class="sm-ipv4-dot" aria-hidden="true">.</span>' +
    '              <input type="text" inputmode="numeric" pattern="[0-9]*" id="settings-central-octet-3" class="sm-ipv4-octet" maxlength="3" aria-label="Octet 4" />' +
    '            </div>' +
    '            <span class="sm-central-port-sep" aria-hidden="true">:</span>' +
    '            <input type="text" inputmode="numeric" pattern="[0-9]*" id="settings-central-port" class="sm-ipv4-port" maxlength="5" placeholder="5000" aria-label="Port" />' +
    '          </div>' +
    '          <div class="form-text">Leave empty to run in local-only mode.</div>' +
    '          <div id="central-url-feedback" class="small mt-1"></div>' +
    '        </div>' +
    '      </div>' +
    '      <div class="modal-footer py-2">' +
    '        <button type="button" class="btn btn-outline-primary btn-sm" id="btn-test-central-connection" tabindex="3"><i class="bi bi-activity me-1"></i> Test connection</button>' +
    '        <button type="button" class="btn btn-primary btn-sm" id="btn-save-client-id" tabindex="4"><i class="bi bi-save me-1"></i> Save</button>' +
    '        <button type="button" class="btn btn-outline-secondary btn-sm" data-bs-dismiss="modal" tabindex="5">Close</button>' +
    '      </div>' +
    '    </div>' +
    '  </div>' +
    '</div>';

  var el = document.getElementById("app-nav");
  if (el) el.innerHTML = html;
})();
