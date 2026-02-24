const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const pngSync = require("pngjs").PNG.sync;

const root = path.join(__dirname, "..");
const buildDir = path.join(root, "build");
const iconsDir = path.join(buildDir, "icons");
const pngPath = path.join(iconsDir, "icon.png");
const icoPath = path.join(buildDir, "icon.ico");

// Create 256x256 PNG (required for electron-builder)
const size = 256;
const data = Buffer.alloc(size * size * 4);
for (let i = 0; i < size * size; i++) {
  data[i * 4] = 0x88;
  data[i * 4 + 1] = 0x88;
  data[i * 4 + 2] = 0x88;
  data[i * 4 + 3] = 0xff;
}
const png = pngSync.write({ width: size, height: size, data });
fs.mkdirSync(iconsDir, { recursive: true });
fs.writeFileSync(pngPath, png);

// Create ICO at default path build/icon.ico (avoids app-builder path issues)
const pngToIco = path.join(root, "node_modules", "png-to-ico", "bin", "cli.js");
const icoBuf = execSync(`node "${pngToIco}" "${pngPath}"`, { encoding: "buffer", cwd: root });
fs.mkdirSync(buildDir, { recursive: true });
fs.writeFileSync(icoPath, icoBuf);
console.log("Created", pngPath, "and", icoPath);
