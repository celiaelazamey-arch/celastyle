/**
 * Behaviour fixtures for the executor tests.
 *
 * These are separate worker scripts rather than a mode flag inside the real
 * worker, because a test hook in the production binary is a way to reach the
 * isolated path from the agent, which is precisely the thing the isolation
 * exists to prevent. The executor takes a worker path; the tests point it at
 * something that misbehaves, and the production path never can.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
mkdirSync(dir, { recursive: true });

const fixtures = {
  // Completes normally.
  "ok-worker.mjs": `
    process.stdin.on("data", () => {});
    process.stdin.on("end", () => {
      process.stdout.write(JSON.stringify({ ok: true, result: "done" }) + "\\n");
    });
  `,

  // Never returns. Only a hard kill ends this.
  "hang-worker.mjs": `
    setInterval(() => {}, 1000);
    process.stdin.resume();
  `,

  // Ignores SIGTERM — the case that separates SIGTERM from SIGKILL.
  "stubborn-worker.mjs": `
    process.on("SIGTERM", () => {});
    setInterval(() => {}, 1000);
    process.stdin.resume();
  `,

  // Dies without writing anything.
  "crash-worker.mjs": `
    process.stdin.resume();
    process.stdin.on("end", () => { process.abort(); });
  `,

  // Exits cleanly but says nothing.
  "silent-worker.mjs": `
    process.stdin.resume();
    process.stdin.on("end", () => process.exit(0));
  `,

  // Emits far past any sane cap, in a loop and without ending.
  "flood-worker.mjs": `
    process.stdin.resume();
    process.stdin.on("end", () => {
      const block = "x".repeat(64 * 1024);
      const pump = () => { for (let i = 0; i < 16; i++) process.stdout.write(block); };
      pump();
      setInterval(pump, 10);
    });
  `,

  // Emits just under the cap — the boundary, to prove the limit is not
  // merely "anything at all gets killed".
  // Logs first, answers last. A tool that narrates is not a tool that is
  // broken, and the supervisor has to be able to tell the two apart.
  "chatty-worker.mjs": `
    process.stdin.resume();
    process.stdin.on("end", () => {
      process.stdout.write("thinking about it\\n");
      process.stdout.write("y".repeat(8 * 1024));
      process.stdout.write("\\n" + JSON.stringify({ ok: true, result: "verbose" }) + "\\n");
    });
  `,

  // A result cut off mid-write. Scanning backwards for the last *parseable*
  // line would find the complete object before it and accept it; the answer
  // is that a truncated answer is a protocol failure, not a lucky read.
  "truncated-worker.mjs": `
    process.stdin.resume();
    process.stdin.on("end", () => {
      process.stdout.write(JSON.stringify({ ok: true, result: "complete" }) + "\\n");
      process.stdout.write('{"ok":true,"result":"cut off half');
    });
  `,

  // Reports its own environment. Used to prove the child is given a
  // constructed environment rather than an inherited one — the only way to
  // observe the boundary is from inside the process that lives behind it.
  "env-dump-worker.mjs": `
    process.stdin.resume();
    process.stdin.on("end", () => {
      process.stdout.write(JSON.stringify({
        ok: true,
        keys: Object.keys(process.env).sort(),
        values: process.env,
      }) + "\\n");
    });
  `,

  // Returns something that is not JSON.
  "garbage-worker.mjs": `
    process.stdin.resume();
    process.stdin.on("end", () => process.stdout.write("this is not json at all\\n"));
  `,

  // Reports failure in its own terms, which is a refusal, not a crash.
  "refusing-worker.mjs": `
    process.stdin.resume();
    process.stdin.on("end", () => {
      process.stdout.write(JSON.stringify({ ok: false, error: "disk is full" }) + "\\n");
    });
  `,
};

for (const [name, source] of Object.entries(fixtures)) {
  writeFileSync(join(dir, name), source.trim() + "\n", "utf8");
}

process.stdout.write(JSON.stringify(Object.keys(fixtures)) + "\n");
