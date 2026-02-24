import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

import authRouter from "./routes/authRoutes.js";
import userRouter from "./routes/userRoutes.js";
import customerRouter from "./routes/customerRoutes.js";
import productRouter from "./routes/productRoutes.js";
import supplierRouter from "./routes/supplierRoutes.js";
import saleRouter from "./routes/saleRoutes.js";
import dashboardRouter from "./routes/dashboardRoutes.js";
import passwordResetRouter from "./routes/passwordResetRoutes.js";
import settingsRouter from "./routes/settingsRoutes.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Get app path - works in both dev and packaged Electron
function getFrontendDir() {
  const appPath = path.join(__dirname, "..");
  
  // Check if running in Electron packaged app
  if (typeof process !== 'undefined' && process.versions && process.versions.electron) {
    // In packaged Electron, files are in app.asar
    // Path resolution works automatically with ASAR
    const asarFrontend = path.join(appPath, "frontend");
    if (fs.existsSync(asarFrontend)) {
      return asarFrontend;
    }
    // Fallback: check unpacked location
    const unpackedFrontend = path.join(appPath, "..", "app.asar.unpacked", "frontend");
    if (fs.existsSync(unpackedFrontend)) {
      return unpackedFrontend;
    }
  }
  
  // Development mode or files in asar
  return path.join(appPath, "frontend");
}

const frontendDir = getFrontendDir();

// Log paths for debugging (only in Electron)
if (typeof process !== 'undefined' && process.versions && process.versions.electron) {
  console.log("Frontend dir:", frontendDir);
  console.log("__dirname:", __dirname);
}

app.use(cors());
app.use(express.json());

// API routes
app.use("/api/auth", authRouter);
app.use("/api/users", userRouter);
app.use("/api/customers", customerRouter);
app.use("/api/products", productRouter);
app.use("/api/suppliers", supplierRouter);
app.use("/api/sales", saleRouter);
app.use("/api/password-resets", passwordResetRouter);
app.use("/api/settings", settingsRouter);
app.use("/api/dashboard", dashboardRouter);


app.get("/.well-known/appspecific/com.chrome.devtools.json", (req, res) => {
  res.status(200).json({});
});

// Serve static files
app.use("/js", express.static(path.join(frontendDir, "js")));
app.use("/css", express.static(path.join(frontendDir, "css")));
app.use(express.static(frontendDir));


app.get("/", (req, res) => {
  const indexPath = path.join(frontendDir, "index.html");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.sendFile(indexPath);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
});

app.use((err, req, res, next) => {
  const msg = err?.message ?? err?.toString?.() ?? String(err);
  const detail = err?.stack ?? (err?.code ? `code: ${err.code}` : "");
  console.error("Error:", req.method, req.originalUrl, msg);
  if (res.headersSent) return;
  let sendMsg = msg || "Server error.";
  if (sendMsg === "Internal server error.") {
    sendMsg = "Request error. Ensure body is valid JSON and Content-Type is application/json.";
  }
  const body = { message: sendMsg };
  if (detail && process.env.NODE_ENV !== "production") body.detail = String(detail).slice(0, 400);
  res.status(500).setHeader("Content-Type", "application/json").send(JSON.stringify(body));
});

/**
 * Start the HTTP server. Returns a Promise that resolves when the server is listening.
 * Used by both standalone Node (npm run dev) and Electron (electron-main.js).
 */
export function startServer(port = PORT) {
  return new Promise((resolve) => {
    app.listen(port, () => {
      console.log(`Server running on http://localhost:${port}`);
      resolve();
    });
  });
}

// When run directly (node backend/server.js or nodemon), start the server.
// Not when imported by Electron (which calls startServer itself).
const isElectron = typeof process !== "undefined" && process.versions?.electron;
const runAsMain = !isElectron;
if (runAsMain) {
  startServer().catch((err) => {
    console.error("Failed to start server:", err);
    process.exit(1);
  });
}

