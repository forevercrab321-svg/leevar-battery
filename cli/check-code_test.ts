// The code-check CLI. Offline: no model, no network, nothing executed.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { main } from "./check-code.ts";

const DATA = new URL(import.meta.resolve("../packages/code-check/testdata")).pathname;

async function run(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [], err: string[] = [];
  const log = console.log, error = console.error;
  console.log = (...a: unknown[]) => void out.push(a.join(" "));
  console.error = (...a: unknown[]) => void err.push(a.join(" "));
  try {
    const code = await main(argv);
    return { code, out: out.join("\n"), err: err.join("\n") };
  } finally {
    console.log = log;
    console.error = error;
  }
}

Deno.test("check-code: no arguments prints usage and exits 2", async () => {
  const r = await run([]);
  assertEquals(r.code, 2);
  assertStringIncludes(r.out, "check-code");
});

Deno.test("check-code: a path that does not exist exits 1 and says so", async () => {
  const r = await run([`${DATA}/does-not-exist`]);
  assertEquals(r.code, 1);
  assertStringIncludes(r.err, "does-not-exist");
});

Deno.test("check-code: findings are a result, exit 0, Markdown on stdout", async () => {
  const r = await run([DATA]);
  assertEquals(r.code, 0);
  for (
    const id of [
      "tool-call-after-truncation",
      "repaired-json-applied",
      "stream-error-ignored",
      "success-as-error",
      "retry-non-idempotent-write",
    ]
  ) assertStringIncludes(r.out, id);
});

Deno.test("check-code: --fail-on-findings exits 3 when something matched, 0 when nothing did", async () => {
  assertEquals((await run([DATA, "--fail-on-findings"])).code, 3);
  const clean = await run([`${DATA}/success-as-error/clean.py`, "--fail-on-findings"]);
  assertEquals(clean.code, 0);
  assertStringIncludes(clean.out, "No matches");
});

Deno.test("check-code: --json prints the machine result", async () => {
  const r = await run([`${DATA}/stream-error-ignored/hit.py`, "--json"]);
  assertEquals(r.code, 0);
  const parsed = JSON.parse(r.out);
  assertEquals(parsed.filesScanned, 1);
  assertStringIncludes(parsed.disclaimer, "confirm");
  assert(typeof parsed.rulesVersion === "string");
  assert(parsed.findings.some((f: { rule: string }) => f.rule === "stream-error-ignored"));
});
