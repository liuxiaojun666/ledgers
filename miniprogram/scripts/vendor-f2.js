/**
 * 将 @antv/f2-canvas 与兼容的 wx-f2 1.x 同步到 miniprogram_npm/（供统计页引用，无需微信开发者工具「构建 npm」）。
 * 用法：在 miniprogram 目录执行 `node scripts/vendor-f2.js`
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const nm = path.join(root, "node_modules");
const outBase = path.join(root, "miniprogram_npm", "@antv");

const f2CanvasSrc = path.join(nm, "@antv", "f2-canvas", "miniprogram_dist");
const wxF2Min = path.join(
  nm,
  "@antv",
  "f2-canvas",
  "node_modules",
  "@antv",
  "wx-f2",
  "dist",
  "wx-f2.min.js"
);
const outCanvas = path.join(outBase, "f2-canvas");
const outWx = path.join(outBase, "wx-f2", "dist");

function cp(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

if (!fs.existsSync(f2CanvasSrc)) {
  console.error("缺少依赖，请在 miniprogram 目录执行: npm install");
  process.exit(1);
}
if (!fs.existsSync(wxF2Min)) {
  console.error("未找到 f2-canvas 自带的 wx-f2 1.x，请重新 npm install @antv/f2-canvas");
  process.exit(1);
}

fs.mkdirSync(outCanvas, { recursive: true });
for (const name of ["index.js", "index.json", "index.wxml", "index.wxss"]) {
  cp(path.join(f2CanvasSrc, name), path.join(outCanvas, name));
}

fs.mkdirSync(outWx, { recursive: true });
cp(wxF2Min, path.join(outWx, "wx-f2.min.js"));

fs.writeFileSync(
  path.join(outBase, "wx-f2", "package.json"),
  JSON.stringify(
    { name: "@antv/wx-f2", version: "1.1.4", main: "dist/wx-f2.min.js" },
    null,
    2
  ) + "\n"
);

const idxPath = path.join(outCanvas, "index.js");
let js = fs.readFileSync(idxPath, "utf8");
js = js.replace(
  /module\.exports\s*=\s*require\(["']@antv\/wx-f2["']\)\s*;/,
  'module.exports = require("../wx-f2/dist/wx-f2.min.js");'
);
fs.writeFileSync(idxPath, js);
console.log("已写入", path.relative(root, outCanvas), "与", path.relative(root, outWx));
