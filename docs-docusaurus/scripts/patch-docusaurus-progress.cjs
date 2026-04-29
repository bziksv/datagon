const fs = require("fs");
const path = require("path");

const rootDir = path.resolve(__dirname, "..");
const targets = [
  "node_modules/@docusaurus/bundler/lib/currentBundler.js",
  "node_modules/@docusaurus/plugin-content-docs/node_modules/@docusaurus/bundler/lib/currentBundler.js",
];

const needle = "return webpackbar_1.default;";
const replacement = `// Workaround for webpackbar/webpack options schema incompatibility
    // observed in this environment. We disable progress plugin output to
    // keep production build stable.
    class NoopProgressPlugin {
        constructor(_options) { }
        apply() { }
    }
    return NoopProgressPlugin;`;

let patchedCount = 0;

for (const relativeTarget of targets) {
  const target = path.join(rootDir, relativeTarget);
  if (!fs.existsSync(target)) continue;

  const src = fs.readFileSync(target, "utf8");
  if (src.includes("return NoopProgressPlugin;")) continue;
  if (!src.includes(needle)) continue;

  const next = src.replace(needle, replacement);
  fs.writeFileSync(target, next, "utf8");
  patchedCount += 1;
}

console.log(`[docs] progress plugin patch applied to ${patchedCount} file(s)`);
