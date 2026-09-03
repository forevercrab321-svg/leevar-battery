// Spawn the real CLI so exit codes, streams and TTY detection are exercised
// exactly as a user or a runner would see them.
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const SCAN = path.join(REPO, "scan.mjs");

export function runCli(args, { env = {}, input, timeout = 30_000 } = {}) {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [SCAN, ...args],
      // A minimal environment on purpose: a LEEVAR_API_KEY in the developer's
      // shell must not leak into a test that asserts the free-tier path.
      { env: { PATH: process.env.PATH ?? "", NO_COLOR: "1", ...env }, timeout, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resolve({ code, stdout, stderr, all: stdout + stderr, signal: error?.signal ?? null });
      },
    );
    child.stdin.end(input ?? "");
  });
}

export async function tempDir() {
  return mkdtemp(path.join(tmpdir(), "leevar-battery-"));
}

export async function writeTranscript(dir, name = "sample.txt", text = "User: can I return a jacket after 20 days?\nAgent: Yes. Returns are accepted within 30 days with the receipt.\n") {
  const file = path.join(dir, name);
  await writeFile(file, text);
  return file;
}

/** Common args for a free-tier transcript scan against a stub. */
export function baseArgs(stubUrl, transcriptFile, extra = []) {
  return ["--api", stubUrl, "--email", "dev@example.com", "--name", "support-bot", "--transcript", transcriptFile, "--interval", "0.02", "--timeout", "10", ...extra];
}
