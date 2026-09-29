#!/usr/bin/env node
/**
 * Tool worker — the only code that touches the filesystem on an agent's
 * behalf.
 *
 * It runs as a separate process so that a crash, an infinite loop or a
 * runaway allocation takes down this file and nothing else. The parent holds
 * no filesystem-write capability at all: it decides, supervises and records,
 * and this is the arm.
 *
 * Protocol: one JSON object on stdin, one JSON object on stdout. Anything
 * else on stdout is treated as noise and capped by the parent, so a tool that
 * logs loudly cannot flood the supervisor's memory.
 *
 * Reserved actions begin with "__". They exist for the executor's own
 * undo path and are not skills; the execution authority refuses any tool name
 * in that namespace, so a skill cannot reach them.
 */

import { mkdir, readFile, writeFile, unlink, realpath } from "node:fs/promises";
import { dirname, basename, join } from "node:path";

/** Largest single file this worker will write, in bytes. */
const MAX_WRITE_BYTES = 5 * 1024 * 1024;

async function resolveRealTarget(path) {
  /**
   * The real path of the file we are about to touch.
   *
   * The parent already checked the path lexically, which cannot see a
   * symlink. Here, with the filesystem in hand, we resolve it for real. A
   * target that does not exist yet is resolved through its nearest existing
   * ancestor, because creating a file is exactly the case where the escape
   * would otherwise be invisible.
   *
   * The filename is part of what we are resolving and must survive the walk;
   * dropping it would resolve the containing directory and quietly write to
   * the directory's own path instead of the file inside it.
   */
  const target = path;
  let dir = dirname(target);
  const parts = [basename(target)];

  for (;;) {
    try {
      const realDir = await realpath(dir);
      return join(realDir, ...parts);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = dirname(dir);
      if (parent === dir) throw error; // reached the root without finding anything
      parts.unshift(basename(dir));
      dir = parent;
    }
  }
}

async function writeFileSafe(payload) {
  const { path, content } = payload;
  if (typeof path !== "string" || typeof content !== "string") {
    return { ok: false, error: "write_file needs a string path and string content" };
  }
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_WRITE_BYTES) {
    return { ok: false, error: `content is ${bytes} bytes, over the ${MAX_WRITE_BYTES} limit` };
  }

  const real = await resolveRealTarget(path);

  // What was there before, so the parent can undo. Read through the real
  // path so an undo is not confused by a symlink being repointed.
  let previous = null;
  let existed = false;
  try {
    previous = await readFile(real, "utf8");
    existed = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  await mkdir(dirname(real), { recursive: true });
  await writeFile(real, content, "utf8");

  return { ok: true, path: real, bytes, existed, previous };
}

async function readFileSafe(payload) {
  const { path } = payload;
  if (typeof path !== "string") return { ok: false, error: "read_file needs a string path" };
  const real = await resolveRealTarget(path);
  const content = await readFile(real, "utf8");
  return { ok: true, path: real, bytes: Buffer.byteLength(content, "utf8"), content };
}

async function restoreSafe(payload) {
  const { path, previous, existed } = payload;
  const real = await resolveRealTarget(path);
  if (existed) {
    await writeFile(real, previous, "utf8");
  } else {
    await unlink(real).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  return { ok: true, path: real, restored: existed ? "content" : "removed" };
}

const HANDLERS = {
  write_file: writeFileSafe,
  read_file: readFileSafe,
  __restore: restoreSafe,
};

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const request = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");

  const handler = HANDLERS[request.action];
  if (!handler) {
    process.stdout.write(JSON.stringify({ ok: false, error: `unknown action ${request.action}` }) + "\n");
    return;
  }

  try {
    const result = await handler(request.payload ?? {});
    process.stdout.write(JSON.stringify(result) + "\n");
  } catch (error) {
    // A failure here is a normal outcome, not a crash: the parent needs the
    // reason, and an exception that escapes would only produce a bare exit.
    process.stdout.write(
      JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }) + "\n",
    );
  }
}

main().catch((error) => {
  process.stdout.write(
    JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }) + "\n",
  );
  process.exitCode = 1;
});
