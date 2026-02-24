/**
 * Remove the dist folder so electron-builder can write a fresh build.
 * If delete fails (e.g. locked), renames dist to dist.old.<timestamp> so build can continue.
 */
const fs = require("fs");
const path = require("path");

const distPath = path.join(__dirname, "..", "dist");

if (!fs.existsSync(distPath)) {
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
  process.exit(0);
  return;
}

// Fallback: rename dist out of the way so builder can use a fresh "dist"
const parent = path.join(__dirname, "..");
const timestamp = Date.now();
const distOld = path.join(parent, "dist.old." + timestamp);
try {
  fs.renameSync(distPath, distOld);
  console.log("dist was locked — renamed to dist.old." + timestamp + ". Build can continue.");
  process.exit(0);
} catch (renameErr) {
  console.error("\n\u274c Cannot remove or rename dist: " + (renameErr.message || renameErr.code || renameErr));
  console.error("\n  Run: npm run clean:dist:force — or close the app and try again.\n");
  process.exit(1);
}
