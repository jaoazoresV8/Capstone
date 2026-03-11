
import { app as electronApp, BrowserWindow, dialog, shell } from "electron";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));


electronApp.commandLine.appendSwitch("enable-print-preview");

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

    // Open external links (e.g. target="_blank") in the user's default browser
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url);
      return { action: "deny" };
    });

    mainWindow.on("closed", () => {
      log("Main window closed");
      mainWindow = null;
    });

    // Always open DevTools to make debugging easier (you can close them manually).
    mainWindow.webContents.openDevTools({ mode: "detach" });
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
