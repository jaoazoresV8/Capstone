(function () {
  var DESKTOP_MIN_WIDTH = 768;
  var dragState = null;
  var rafId = null;
  var pendingX = null;
  var pendingY = null;

  function isDesktop() {
    return window.matchMedia("(min-width: " + DESKTOP_MIN_WIDTH + "px)").matches;
  }

  /** Remove any leftover modal backdrop/state so inputs and links are never stuck. */
  function forceModalCleanup() {
    document.body.classList.remove("modal-dragging", "modal-open");
    document.querySelectorAll(".modal-backdrop").forEach(function (el) {
      if (el && el.parentNode) el.parentNode.removeChild(el);
    });
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    pendingX = null;
    pendingY = null;
    dragState = null;
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("mouseup", onMouseUp);
  }

  function getModalDialog(modalEl) {
    return modalEl && modalEl.querySelector(".modal-dialog");
  }

  function getModalHeader(modalEl) {
    return modalEl && modalEl.querySelector(".modal-header");
  }

  function applyTransform(dialog, x, y) {
    if (!dialog) return;
    dialog.style.transform = "translate(" + x + "px, " + y + "px)";
  }

  function tick() {
    rafId = null;
    if (dragState && pendingX !== null && pendingY !== null) {
      dragState.offsetX = dragState.startOffsetX + (pendingX - dragState.startX);
      dragState.offsetY = dragState.startOffsetY + (pendingY - dragState.startY);
      applyTransform(dragState.dialog, dragState.offsetX, dragState.offsetY);
    }
  }

  function onMouseMove(e) {
    if (!dragState) return;
    pendingX = e.clientX;
    pendingY = e.clientY;
    if (rafId === null) {
      rafId = requestAnimationFrame(tick);
    }
  }

  function onMouseUp() {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    pendingX = null;
    pendingY = null;
    if (dragState && dragState.dialog) {
      dragState.dialog.classList.remove("modal-dialog-dragging");
    }
    dragState = null;
    document.body.classList.remove("modal-dragging");
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("mouseup", onMouseUp);
  }

  function initDraggable(modalEl) {
    if (!isDesktop()) return;
    var dialog = getModalDialog(modalEl);
    var header = getModalHeader(modalEl);
    if (!dialog || !header) return;
    if (modalEl.dataset.draggableInited === "1") return;
    modalEl.dataset.draggableInited = "1";

    header.classList.add("modal-drag-handle");
    header.addEventListener("mousedown", function (e) {
      if (!isDesktop()) return;
      if (e.button !== 0) return;
      if (e.target.closest("button")) return;
      e.preventDefault();
      var rect = dialog.getBoundingClientRect();
      var style = window.getComputedStyle(dialog);
      var tx = 0, ty = 0;
      var m = style.transform && style.transform.match(/matrix\(([^)]+)\)/);
      if (m) {
        var parts = m[1].split(",");
        if (parts.length >= 6) {
          tx = parseFloat(parts[4]) || 0;
          ty = parseFloat(parts[5]) || 0;
        }
      } else if (style.transform && style.transform !== "none") {
        var t = style.transform.match(/translate\(([^,]+)px,\s*([^)]+)px\)/);
        if (t) {
          tx = parseFloat(t[1]) || 0;
          ty = parseFloat(t[2]) || 0;
        }
      }
      dragState = {
        dialog: dialog,
        startX: e.clientX,
        startY: e.clientY,
        startOffsetX: tx,
        startOffsetY: ty,
        offsetX: tx,
        offsetY: ty
      };
      pendingX = e.clientX;
      pendingY = e.clientY;
      document.body.classList.add("modal-dragging");
      dialog.classList.add("modal-dialog-dragging");
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    });
  }

  function resetPosition(modalEl) {
    var dialog = getModalDialog(modalEl);
    if (dialog) {
      dialog.style.transform = "";
    }
  }

  document.addEventListener("shown.bs.modal", function (e) {
    initDraggable(e.target);
  });

  document.addEventListener("hidden.bs.modal", function (e) {
    resetPosition(e.target);
    forceModalCleanup();
    // Run again after Bootstrap's backdrop transition so no leftover overlay blocks clicks
    setTimeout(forceModalCleanup, 150);
  });

  window.addEventListener("pjax:complete", function () {
    forceModalCleanup();
  });

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") forceModalCleanup();
  });

  document.addEventListener("DOMContentLoaded", function () {
    document.querySelectorAll(".modal").forEach(function (modalEl) {
      if (modalEl.classList.contains("show")) {
        initDraggable(modalEl);
      }
    });
  });
})();
