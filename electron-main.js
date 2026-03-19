
import { app as electronApp, BrowserWindow, dialog, shell, ipcMain } from "electron";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const preloadPath = path.join(__dirname, "preload.js");


// Do not enable Chromium print preview; it shows "This app doesn't support print preview" on Windows.
// The receipt is already shown in the app's own print preview window before Print is clicked.
const PORT = process.env.PORT || 5000;
const APP_PROTOCOL = "dmsales";
const DASHBOARD_PATH = "/pages/dashboard.html";

// Log file path for debugging
const logPath = path.join(electronApp.getPath("userData"), "app.log");

function log(message) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}\n`;
  console.log(logMessage.trim());
  try {
    fs.appendFileSync(logPath, logMessage);
  } catch (err) {
    console.error("Failed to write to log file:", err);
  }
}

function showError(title, message) {
  log(`ERROR: ${title} - ${message}`);
  dialog.showErrorBox(title, message);
}


function setElectronEnv() {
  try {
    const userData = electronApp.getPath("userData");
    const dataDir = path.join(userData, "data");
    
    // Ensure data directory exists
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
      log(`Created data directory: ${dataDir}`);
    }
    
    process.env.SQLITE_DB_PATH = path.join(dataDir, "sales_management.db");
    if (!process.env.PORT) process.env.PORT = String(PORT);
    
    log(`Environment set - SQLITE_DB_PATH: ${process.env.SQLITE_DB_PATH}`);
  } catch (err) {
    showError("Environment Setup Error", `Failed to set up environment: ${err.message}`);
    throw err;
  }
}

let mainWindow = null;
let pendingDeepLinkUrl = null;

function extractDeepLinkFromArgv(argv) {
  if (!Array.isArray(argv)) return null;
  return (
    argv.find(
      (arg) => typeof arg === "string" && arg.startsWith(`${APP_PROTOCOL}://`)
    ) || null
  );
}

function handleDeepLink(url) {
  if (!url) return;
  pendingDeepLinkUrl = url;
  log(`Received deep link: ${url}`);
  if (!mainWindow) return;
  try {
    const target = `http://localhost:${PORT}${DASHBOARD_PATH}`;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    mainWindow.loadURL(target);
  } catch (err) {
    log(`Failed to handle deep link: ${err.message}`);
  }
}

const gotTheLock = electronApp.requestSingleInstanceLock();

if (!gotTheLock) {
  electronApp.quit();
  process.exit(0);
}

const initialDeepLinkUrl = extractDeepLinkFromArgv(process.argv);
if (initialDeepLinkUrl) {
  pendingDeepLinkUrl = initialDeepLinkUrl;
}

function registerDeepLinkProtocol() {
  try {
    // In development (run with `electron .`), we must tell Electron what "app" path to use.
    if (process.defaultApp) {
      const appRoot = __dirname;
      if (!electronApp.isDefaultProtocolClient(APP_PROTOCOL, process.execPath, [appRoot])) {
        electronApp.setAsDefaultProtocolClient(APP_PROTOCOL, process.execPath, [appRoot]);
        log(`Registered protocol handler for ${APP_PROTOCOL}:// (dev, root: ${appRoot})`);
      }
      return;
    }

    // In packaged / production builds, the executable path is enough.
    if (!electronApp.isDefaultProtocolClient(APP_PROTOCOL)) {
      electronApp.setAsDefaultProtocolClient(APP_PROTOCOL);
      log(`Registered protocol handler for ${APP_PROTOCOL}:// (packaged)`);
    }
  } catch (err) {
    log(`Failed to register protocol ${APP_PROTOCOL}: ${err.message}`);
  }
}

/** Generate a PDF from receipt HTML and open it in the default viewer (avoids broken native print preview in Electron). */
async function printReceiptToPdf(fullPrintDocHtml) {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  try {
    await win.loadURL("about:blank");
    await win.webContents.executeJavaScript(
      `document.open();document.write(${JSON.stringify(fullPrintDocHtml)});document.close();`
    );
    await new Promise((r) => setTimeout(r, 150));
    const pdfBuffer = await win.webContents.printToPDF({
      printBackground: true,
      margins: { marginType: "default" },
    });
    const tempDir = electronApp.getPath("temp");
    const pdfPath = path.join(tempDir, `receipt-${Date.now()}.pdf`);
    fs.writeFileSync(pdfPath, pdfBuffer);
    shell.openPath(pdfPath);
    return { success: true, path: pdfPath };
  } finally {
    win.destroy();
  }
}

ipcMain.handle("print-receipt-to-pdf", async (_event, fullPrintDocHtml) => {
  if (typeof fullPrintDocHtml !== "string") {
    throw new Error("Invalid receipt HTML");
  }
  return printReceiptToPdf(fullPrintDocHtml);
});

ipcMain.handle("open-external", (_event, url) => {
  if (typeof url !== "string") return;
  const u = url.trim();
  if (!u) return;
  // Allow common external schemes used by the UI (WhatsApp deep link + web URLs).
  if (
    u.startsWith("http://") ||
    u.startsWith("https://") ||
    u.startsWith("whatsapp://") ||
    u.startsWith("mailto:") ||
    u.startsWith("tel:")
  ) {
    shell.openExternal(u);
  }
});

function createWindow() {
  try {
    log("Creating main window...");
    mainWindow = new BrowserWindow({
      width: 1200,
      height: 800,
      minWidth: 800,
      minHeight: 600,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: preloadPath,
      },
      show: false,
    });

    
    mainWindow.once("ready-to-show", () => {
      log("Window ready to show");
      mainWindow.show();
    });

    
    mainWindow.webContents.on("did-fail-load", (event, errorCode, errorDescription, validatedURL) => {
      log(`Failed to load: ${validatedURL} - ${errorCode}: ${errorDescription}`);
      if (errorCode === -105 || errorCode === -106) {
        
        showError(
          "Connection Error",
          `Cannot connect to server at http://localhost:${PORT}.\n\n` +
          `Error: ${errorDescription}\n\n` +
          `Please check the log file at:\n${logPath}`
        );
      }
    });

    mainWindow.loadURL(`http://localhost:${PORT}`);

    // Open external links in the default browser; allow blank/same-origin windows (e.g. print preview)
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      const isBlankOrSameOrigin =
        !url ||
        url === "about:blank" ||
        url.startsWith("http://localhost:") ||
        url.startsWith("https://localhost:");
      if (isBlankOrSameOrigin) {
        return { action: "allow" };
      }
      shell.openExternal(url);
      return { action: "deny" };
    });

    mainWindow.on("closed", () => {
      log("Main window closed");
      mainWindow = null;
    });

    // Don't open DevTools by default (even in dev).
    // Enable only when explicitly requested.
    const shouldOpenDevTools = process.env.ELECTRON_OPEN_DEVTOOLS === "1";
    if (shouldOpenDevTools) {
      mainWindow.webContents.openDevTools({ mode: "detach" });
    }
  } catch (err) {
    showError("Window Creation Error", `Failed to create window: ${err.message}`);
    throw err;
  }
}

electronApp.whenReady().then(async () => {
  log("Electron app ready");
  
  try {
    // Register custom protocol for deep links (e.g., dmsales://dashboard)
    registerDeepLinkProtocol();

    setElectronEnv();

    log("Importing backend server...");
    const { startServer } = await import("./backend/server.js");
    
    log(`Starting server on port ${PORT}...`);
    await startServer(PORT);
    log("Server started successfully");

    await new Promise((resolve) => setTimeout(resolve, 500));

    createWindow();

    if (pendingDeepLinkUrl) {
      handleDeepLink(pendingDeepLinkUrl);
    }
  } catch (err) {
    const errorMessage = err?.message || String(err);
    const errorStack = err?.stack || "";
    log(`Startup error: ${errorMessage}\n${errorStack}`);
    showError(
      "Startup Error",
      `Failed to start the application:\n\n${errorMessage}\n\n` +
      `Check the log file for details:\n${logPath}`
    );
    electronApp.quit();
  }
});

electronApp.on("window-all-closed", () => {
  log("All windows closed, quitting app");
  electronApp.quit();
});

electronApp.on("activate", () => {
  if (mainWindow === null) {
    log("App activated, creating window");
    createWindow();
  }
});

electronApp.on("second-instance", (event, argv) => {
  const url = extractDeepLinkFromArgv(argv);
  if (url) handleDeepLink(url);
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

electronApp.on("open-url", (event, url) => {
  event.preventDefault();
  handleDeepLink(url);
});

// Handle uncaught errors
process.on("uncaughtException", (err) => {
  log(`Uncaught exception: ${err.message}\n${err.stack}`);
  showError("Application Error", `An unexpected error occurred:\n\n${err.message}`);
});

process.on("unhandledRejection", (reason, promise) => {
  log(`Unhandled rejection: ${reason}`);
  showError("Promise Rejection", `An unhandled promise rejection occurred:\n\n${reason}`);
});
