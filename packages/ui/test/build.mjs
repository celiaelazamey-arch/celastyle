#!/usr/bin/env node
/**
 * Build step for the render tests.
 *
 *   1. Compile the package's TypeScript to plain ESM in .test-build/.
 *   2. Strip `import "./x.css"` — meaningless outside a bundler.
 *   3. Add `.js` to relative specifiers — tsc preserves extensionless imports
 *      that Node's ESM resolver rejects.
 *
 * Kept as a script rather than inline in package.json so `npm test` behaves
 * identically everywhere without pulling a bundler into devDependencies.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const pkgRoot = resolve(here, "..");

execFileSync(
  process.platform === "win32" ? "npx.cmd" : "npx",
  ["tsc", "-p", join(here, "tsconfig.json")],
  { cwd: pkgRoot, stdio: "inherit" },
);

const outDir = join(pkgRoot, ".test-build");
let stripped = 0;
let fixed = 0;

const CSS_IMPORT = /^import\s+["'][^"']+\.css["'];?$/gm;
const STATIC_FROM = /(from\s+["']\.{1,2}\/[^"']*?)(?<!\.js)(["'])/g;
const DYNAMIC = /import\(\s*["'](\.{1,2}\/[^"']*?)(?<!\.js)(["'])\s*\)/g;

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full);
      continue;
    }
    if (!entry.endsWith(".js")) continue;

    const src = readFileSync(full, "utf8");
    let next = src.replace(CSS_IMPORT, "");
    if (next !== src) stripped += 1;

    next = next.replace(STATIC_FROM, (_m, spec, quote) => {
      fixed += 1;
      return `${spec}.js${quote}`;
    });
    next = next.replace(DYNAMIC, (_m, spec, quote) => {
      fixed += 1;
      return `import("${spec}.js"${quote ? "" : ""})`;
    });

    if (next !== src) writeFileSync(full, next);
  }
}

walk(outDir);
console.log(
  `[test] compiled @celastyle/ui → .test-build ` +
    `(${stripped} CSS imports stripped, ${fixed} specifiers resolved)`,
);
