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
const appWorkspace = resolve(pkgRoot, "../../apps/command-center/app/workspace");
const appLib = resolve(pkgRoot, "../../apps/command-center/app/lib");

// 1 — Compile the component package, and the app's pure modules the telemetry
//     and verdict tests drive (they import the same functions the app does, so
//     they have to be compiled rather than reimplemented in the test).
execFileSync(
  process.platform === "win32" ? "npx.cmd" : "npx",
  ["tsc", "-p", join(here, "tsconfig.json")],
  { cwd: pkgRoot, stdio: "inherit" },
);

execFileSync(
  process.platform === "win32" ? "npx.cmd" : "npx",
  [
    "tsc",
    join(appWorkspace, "projectRun.ts"),
    "--outDir",
    join(pkgRoot, ".test-build-workspace"),
    // projectRun and verify import types from @celastyle/ui, which resolves
    // to the package's .tsx source, so JSX must be enabled or tsc refuses the
    // transitive .tsx modules.
    "--jsx",
    "react-jsx",
    "--module",
    "ESNext",
    "--target",
    "ES2022",
    "--moduleResolution",
    "bundler",
    "--skipLibCheck",
  ],
  { cwd: appWorkspace, stdio: "inherit" },
);

// The app's server-side modules pull in node builtins, so they are compiled
// on their own rather than through the package's tsconfig.
for (const entry of [
  "verify.ts",
  "execution-authority.ts",
  "event-ledger.ts",
  "cognitive-pipeline.ts",
  "policy-engine.ts",
  "planner.ts",
  "isolated-executor.ts",
]) {
  execFileSync(
    process.platform === "win32" ? "npx.cmd" : "npx",
    [
      "tsc",
      join(appLib, entry),
      "--outDir",
      join(pkgRoot, ".test-build-workspace"),
      "--module",
      "ESNext",
      "--target",
      "ES2022",
      "--moduleResolution",
      "bundler",
      "--skipLibCheck",
    ],
    { cwd: appLib, stdio: "inherit" },
  );
}

const targets = [
  { dir: join(pkgRoot, ".test-build"), label: ".test-build" },
  { dir: join(pkgRoot, ".test-build-workspace"), label: ".test-build-workspace" },
];

/* verify.ts is compiled separately, so it lands under lib/. The verdict test
   imports it from there directly. */

let stripped = 0;
let fixed = 0;

const CSS_IMPORT = /^import\s+["'][^"']+\.css["'];?$/gm;
const STATIC_FROM = /(from\s+["']\.{1,2}\/[^"']*?)(?<!\.js)(["'])/g;
const DYNAMIC = /import\(\s*["'](\.{1,2}\/[^"']*?)(?<!\.js)(["'])\s*\)/g;
const TYPE_IMPORT = /^import\s+type\s.*$/gm;
const BARE_TYPE = /^export\s+type\s.*$/gm;

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full);
      continue;
    }
    if (!entry.endsWith(".js")) continue;

    const src = readFileSync(full, "utf8");
    // Two things must not survive into plain Node: CSS imports (no bundler to
    // resolve them) and type-only imports (erased at runtime, but a surviving
    // `import { type X }` would still be parsed as a value import).
    let next = src.replace(CSS_IMPORT, "").replace(TYPE_IMPORT, "").replace(BARE_TYPE, "");
    if (next !== src) stripped += 1;

    next = next.replace(STATIC_FROM, (_m, spec, quote) => {
      fixed += 1;
      return `${spec}.js${quote}`;
    });
    next = next.replace(DYNAMIC, (_m, spec) => `import("${spec}.js")`);

    if (next !== src) writeFileSync(full, next);
  }
}

for (const { dir, label } of targets) {
  walk(dir);
  console.log(`[test] compiled ${label}`);
}
console.log(`[test] ${stripped} type/CSS statements stripped, ${fixed} specifiers resolved`);
