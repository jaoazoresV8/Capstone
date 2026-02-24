
const API_ORIGIN =
  !window.location.port || window.location.port === "5500" || window.location.port === "3000"
    ? "http://localhost:5000"
    : window.location.origin;

const API_BASE = `${API_ORIGIN}/api/auth`;

const loginForm = document.getElementById("login-form");
const feedbackEl = document.getElementById("auth-feedback");
const passwordToggles = document.querySelectorAll(".password-toggle");
const forgotForm = document.getElementById("forgot-password-form");
const forgotFeedbackEl = document.getElementById("forgot-feedback");

const setFeedback = (message, type = "neutral") => {
  if (!feedbackEl) return;
  feedbackEl.textContent = message;
  feedbackEl.className = "auth-feedback visible";
  if (type === "success") feedbackEl.classList.add("success");
  if (type === "error") feedbackEl.classList.add("error");
};

const clearFeedback = () => {
  if (!feedbackEl) return;
  feedbackEl.textContent = "";
  feedbackEl.className = "auth-feedback";
};

passwordToggles.forEach((btn) => {
  btn.addEventListener("click", () => {
    const targetId = btn.dataset.target;
    const input = document.getElementById(targetId);
    if (!input) return;
    const isPassword = input.type === "password";
    input.type = isPassword ? "text" : "password";
    btn.textContent = isPassword ? "Hide" : "Show";
  });
});

const saveSession = (token, user) => {
  try {
    localStorage.setItem("sm_token", token);
    localStorage.setItem("sm_user", JSON.stringify(user));
  } catch {
    
  }
};

const handleAuthSuccess = (message, user) => {
  setFeedback(message, "success");

  setTimeout(() => {
    setFeedback(`Welcome, ${user.name}! Redirecting to dashboard...`, "success");
  }, 500);

  setTimeout(() => {
    window.location.href = "pages/dashboard.html";
  }, 1500);
};

if (loginForm) {
  loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    clearFeedback();

    const username = (document.getElementById("login-username")?.value ?? "").trim();
    const password = document.getElementById("login-password")?.value ?? "";

    if (!username || !password) {
      setFeedback("Please enter both username and password.", "error");
      return;
    }

    try {
      const res = await fetch(`${API_BASE}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });

      const text = await res.text();
      let data = {};
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        data = {};
      }

      if (!res.ok) {
        const msg = data.message || `Login failed (${res.status}).`;
        throw new Error(msg);
      }

      if (data.token && data.user) {
        saveSession(data.token, data.user);
      }

      handleAuthSuccess("Login successful.", data.user || { name: username });
    } catch (err) {
      setFeedback(err.message || "Something went wrong while logging in.", "error");
    }
  });
}
window.addEventListener("DOMContentLoaded", () => {
 
  const token = localStorage.getItem("sm_token");
  if (token) {
    window.location.href = "pages/dashboard.html";
  }
});

if (forgotForm) {
  forgotForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const username = document.getElementById("forgot-username")?.value?.trim();
    if (!username) return;

    if (forgotFeedbackEl) {
      forgotFeedbackEl.textContent = "Sending request…";
      forgotFeedbackEl.className = "small mt-3 text-muted";
    }

    try {
      const res = await fetch(`${API_BASE}/forgot-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || "Failed to send request.");

      if (forgotFeedbackEl) {
        forgotFeedbackEl.textContent = data.message || "Request sent to admin.";
        forgotFeedbackEl.className = "small mt-3 text-success";
      }
    } catch (err) {
      if (forgotFeedbackEl) {
        forgotFeedbackEl.textContent = err.message || "Failed to send request.";
        forgotFeedbackEl.className = "small mt-3 text-danger";
      }
    }
  });
}
