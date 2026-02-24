/**
 * Force-clean dist: on Windows, kill processes that usually lock app.asar
 * (Electron dev run or the built app), then remove dist.
 */
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const distPath = path.join(__dirname, "..", "dist");

if (process.platform === "win32") {
  console.log("Stopping Electron / D&M Sales Management processes...");
  const toKill = ["electron.exe", "D&M Sales Management.exe"];
  for (const name of toKill) {
    try {
      execSync(`taskkill /F /IM "${name}"`, { stdio: "ignore", windowsHide: true });
      console.log("  Stopped: " + name);
    } catch (e) {
      // Process not running
    }
  }
  // Brief wait so handles are released
  if (process.platform === "win32") {
    try {
      execSync("ping -n 3 127.0.0.1 >nul", { stdio: "ignore", windowsHide: true });
    } catch (e) {}
  }
}

if (!fs.existsSync(distPath)) {
  console.log("dist folder does not exist.");
  process.exit(0);
  return;
}

function tryRemoveDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 2 });
    return true;
  } catch (e) {
    return false;
  }
}

if (tryRemoveDir(distPath)) {
  console.log("dist folder removed.");
  process.exit(0);
  return;
}

// Fallback: rename dist out of the way so builder can use a fresh "dist"
const parent = path.join(__dirname, "..");
const timestamp = Date.now();
const distOld = path.join(parent, "dist.old." + timestamp);
try {
  fs.renameSync(distPath, distOld);
  console.log("dist is locked — renamed to dist.old." + timestamp + " so build can continue.");
  console.log("You can delete dist.old.* manually later (e.g. after a restart).");
  process.exit(0);
} catch (renameErr) {
  console.error("\n\u274c Cannot remove or rename dist: " + (renameErr.message || renameErr.code || renameErr));
  console.error("\n  Try: close all apps, Task Manager — end 'electron.exe' / 'D&M Sales Management',");
  console.error("  or restart the PC and run: npm run clean:dist\n");
  process.exit(1);
}
