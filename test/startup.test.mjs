// Startup time is a feature. This is a regression guard with a generous bound
// for shared CI runners, not a benchmark: the CLI must not grow a dependency
// or an eager import that pushes a `--version` past a second.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { VERSION } from "../scan.mjs";
import { REPO, runCli } from "./helpers/cli.mjs";

test("VERSION in scan.mjs matches package.json", async () => {
  const pkg = JSON.parse(await readFile(path.join(REPO, "package.json"), "utf8"));
  assert.equal(pkg.version, VERSION);
  assert.equal(pkg.bin["leevar-battery"], "./scan.mjs");
  assert.deepEqual(pkg.dependencies ?? {}, {}, "zero runtime dependencies");
});

test("startup budget: `--version` completes well under a second (best of 3)", async () => {
  let best = Infinity;
  for (let i = 0; i < 3; i++) {
    const t0 = process.hrtime.bigint();
    const r = await runCli(["--version"]);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.equal(r.code, 0);
    assert.equal(r.stdout.trim(), VERSION);
    best = Math.min(best, ms);
  }
  assert.ok(best < 1000, `--version took ${best.toFixed(0)}ms (budget 1000ms)`);
});

test("no-args run is a usage error, not a stack trace", async () => {
  const r = await runCli([]);
  assert.equal(r.code, 4);
  assert.equal(r.stderr.includes("    at "), false, "no stack trace at a human");
  assert.match(r.stderr, /Run --help for examples/);
});
