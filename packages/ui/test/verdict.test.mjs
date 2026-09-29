/**
 * Verdict derivation.
 *
 * `deriveVerdict` is the part of the verifier that decides whether a change is
 * accepted, and it is where a wrong answer does real damage: a green run for a
 * broken build, or a red run for a change that was never the problem.
 *
 * These cases are the ones that actually matter:
 *  - an environmental failure (dev server holding .next) must NOT reject,
 *  - a failing test must reject, and
 *  - a token change must never be silently verified.
 *
 * Run: node test/verdict.test.mjs  (after `npm run test -w @celastyle/ui`)
 */
import { deriveVerdict, gateEnv, readTestOutput } from "../.test-build-workspace/lib/verify.js";

let pass = 0;
let fail = 0;
const check = (name, condition, detail = "") => {
  if (condition) {
    pass += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    fail += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${name} ${detail}`);
  }
};

const gate = (id, outcome, extra = {}) => ({
  id,
  label: id,
  outcome,
  ms: 0,
  ...extra,
});

const allPass = [
  gate("scope", "pass"),
  gate("tests", "pass"),
  gate("type", "pass"),
  gate("build", "pass"),
  gate("security", "pass"),
  gate("compat", "pass"),
];

console.log("\n\x1b[1mderiveVerdict\x1b[0m");

check("a fully green run is verified", deriveVerdict(allPass) === "VERIFIED");

{
  const gates = allPass.map((g) =>
    g.id === "build" ? gate("build", "fail") : g,
  );
  check("a failing build rejects", deriveVerdict(gates) === "REJECTED");
}

{
  const gates = allPass.map((g) =>
    g.id === "tests" ? gate("tests", "fail") : g,
  );
  check("failing tests reject", deriveVerdict(gates) === "REJECTED");
}

{
  const gates = allPass.map((g) =>
    g.id === "security" ? gate("security", "fail") : g,
  );
  check("a vulnerability rejects", deriveVerdict(gates) === "REJECTED");
}

{
  // The rule that motivated the flag: a gate that failed because of the
  // environment says nothing about the change under test.
  const gates = allPass.map((g) =>
    g.id === "build"
      ? gate("build", "fail", { environmental: true, detail: "dev server running" })
      : g,
  );
  check(
    "an environmental failure does NOT reject",
    deriveVerdict(gates) === "IN_REVIEW",
    `got ${deriveVerdict(gates)}`,
  );
}

{
  // Order matters: a real test failure must still reject even if something
  // else failed environmentally, because the tests really did fail.
  const gates = [
    gate("build", "fail", { environmental: true }),
    gate("tests", "fail"),
    ...allPass.filter((g) => g.id !== "build" && g.id !== "tests"),
  ];
  check(
    "a real failure still rejects alongside an environmental one",
    deriveVerdict(gates) === "REJECTED",
    `got ${deriveVerdict(gates)}`,
  );
}

{
  // A broken token contract is a real failure, not an inconclusive one: the
  // change is wrong, so it rejects. What must never happen is it being
  // reported as verified.
  const gates = allPass.map((g) =>
    g.id === "compat" ? gate("compat", "fail") : g,
  );
  const verdict = deriveVerdict(gates);
  check(
    "a token contract change is never silently verified",
    verdict !== "VERIFIED",
    `got ${verdict}`,
  );
  check("a broken token contract rejects", verdict === "REJECTED", `got ${verdict}`);
}

console.log("\n\x1b[1mgateEnv\x1b[0m");

{
  // The bug this exists to prevent: the gate is served by a dev server, and a
  // `next build` refuses to run under NODE_ENV=development. Inheriting the
  // host's environment made the build gate fail on every page load, with an
  // error that named nothing about the change.
  const env = gateEnv({}, { NODE_ENV: "development", PATH: "/usr/bin" });
  check(
    "a gate never inherits the host's development NODE_ENV",
    env.NODE_ENV === "production",
    `got ${env.NODE_ENV}`,
  );
  check("the rest of the host environment is preserved", env.PATH === "/usr/bin");
}

{
  // The build needs its own output directory for the same reason.
  const env = gateEnv({ env: { NEXT_DIST_DIR: ".next-verify" } }, {});
  check("a gate can require its own output directory", env.NEXT_DIST_DIR === ".next-verify");
}

{
  // Per-gate values must win over the defaults, or a gate could never
  // override the shared environment.
  const env = gateEnv({ env: { NODE_ENV: "test" } }, { NODE_ENV: "development" });
  check("a gate's own value overrides the shared default", env.NODE_ENV === "test");
}

console.log("\n\x1b[1mreadTestOutput\x1b[0m");

{
  /* The defect this guards: the suite prints one summary line per file, and a
     non-global regex read only the first. The panel then showed 56/56 for a
     run that executed 88 — an undercount indistinguishable from a smaller,
     cleaner run, and the exact number a reader trusts. */
  const output = `
\x1b[32m✅ 56 passed, 0 failed\x1b[0m
\x1b[32m✅ 20 passed, 0 failed\x1b[0m
\x1b[32m✅ 12 passed, 0 failed\x1b[0m
`;
  const parsed = readTestOutput(output);
  check("every suite's count is summed, not just the first", parsed.value === "88/88", `got ${parsed.value}`);
}

{
  const parsed = readTestOutput("56 passed, 2 failed\n");
  check("failures are counted into the total", parsed.value === "56/58", `got ${parsed.value}`);
  check("failures are surfaced in the detail", /2 failing/.test(parsed.detail), `got ${parsed.detail}`);
}

{
  // A suite that died before printing a summary must not be reported as a
  // clean run of zero. "0/0" is a claim, and this run has not earned it.
  const parsed = readTestOutput("Error: command failed with exit 1\n");
  check("a run with no summary is not counted as zero", parsed.value !== "0/0", `got ${parsed.value}`);
  check("a run with no summary says so", parsed.value === "no summary", `got ${parsed.value}`);
}

console.log(`\n${fail === 0 ? "\x1b[32m✅" : "\x1b[31m❌"} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
