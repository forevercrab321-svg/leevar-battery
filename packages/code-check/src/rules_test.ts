// Each rule: the shape from its catalog case must match, and the fixed shape
// (the false-positive control) must not. Fixtures live in ../testdata/ and are
// minimal rewrites, not copies of anyone's code.

import { assert, assertEquals } from "@std/assert";
import { checkText } from "./check.ts";
import type { Finding, RuleId } from "./types.ts";

async function check(rel: string): Promise<Finding[]> {
  const url = new URL(import.meta.resolve(`../testdata/${rel}`));
  return checkText(rel, await Deno.readTextFile(url));
}

function linesOf(findings: Finding[], rule: RuleId): number[] {
  return findings.filter((f) => f.rule === rule).map((f) => f.line).sort((a, b) => a - b);
}

async function assertHits(rel: string, rule: RuleId, lines: number[]) {
  const findings = await check(rel);
  assertEquals(linesOf(findings, rule), lines, `${rel}: ${JSON.stringify(findings, null, 2)}`);
  for (const f of findings) {
    assert(f.detail.length > 0, "every finding explains itself");
    assertEquals(f.file, rel);
  }
}

async function assertClean(rel: string) {
  const findings = await check(rel);
  assertEquals(findings, [], `${rel} should have no findings`);
}

// 1. tool-call-after-truncation (catalog 01, 03, 04)
Deno.test("tool-call-after-truncation: reason read only for content_filter, tools still run (py)", () =>
  assertHits("tool-call-after-truncation/hit.py", "tool-call-after-truncation", [8]));
Deno.test("tool-call-after-truncation: length branch only logs, tools still run (ts)", () =>
  assertHits("tool-call-after-truncation/hit.ts", "tool-call-after-truncation", [10]));
Deno.test("tool-call-after-truncation: a length stop that returns first is not flagged (py)", () =>
  assertClean("tool-call-after-truncation/clean.py"));
Deno.test("tool-call-after-truncation: an allow-list on the stop reason is not flagged (ts)", () =>
  assertClean("tool-call-after-truncation/clean.ts"));

// 2. repaired-json-applied (catalog 02, 03)
Deno.test("repaired-json-applied: repaired answer written to the store (py)", () =>
  assertHits("repaired-json-applied/hit.py", "repaired-json-applied", [9]));
Deno.test("repaired-json-applied: jsonrepair and partial-json results returned as data (ts)", () =>
  assertHits("repaired-json-applied/hit.ts", "repaired-json-applied", [10, 15]));
Deno.test("repaired-json-applied: repair after a finish_reason check is not flagged (py)", () =>
  assertClean("repaired-json-applied/clean.py"));
Deno.test("repaired-json-applied: repair used only for logging, or named in a string, is not flagged (ts)", () =>
  assertClean("repaired-json-applied/clean.ts"));

// 3. stream-error-ignored (catalog 05)
Deno.test("stream-error-ignored: NDJSON parser with item/end but no error chunk (py)", () =>
  assertHits("stream-error-ignored/hit.py", "stream-error-ignored", [12]));
Deno.test("stream-error-ignored: SSE switch with no error case and no default (ts)", () =>
  assertHits("stream-error-ignored/hit.ts", "stream-error-ignored", [12]));
Deno.test("stream-error-ignored: an error chunk that raises is not flagged (py)", () =>
  assertClean("stream-error-ignored/clean.py"));
Deno.test("stream-error-ignored: a throwing default, or a typed SDK stream, is not flagged (ts)", () =>
  assertClean("stream-error-ignored/clean.ts"));

// 4. success-as-error (catalog 06, 10)
Deno.test("success-as-error: strict json.dumps shares the try with the tool call (py)", () =>
  assertHits("success-as-error/hit.py", "success-as-error", [13]));
Deno.test("success-as-error: success read from body keys instead of the HTTP status (ts)", () =>
  assertHits("success-as-error/hit.ts", "success-as-error", [7]));
Deno.test("success-as-error: tool call and logging in separate trys is not flagged (py)", () =>
  assertClean("success-as-error/clean.py"));
Deno.test("success-as-error: success from response.ok is not flagged (ts)", () =>
  assertClean("success-as-error/clean.ts"));

// 5. retry-non-idempotent-write (pattern, not yet in catalog)
Deno.test("retry-non-idempotent-write: @retry around a POST, and urllib3 Retry on all methods (py)", () =>
  assertHits("retry-non-idempotent-write/hit.py", "retry-non-idempotent-write", [11, 17]));
Deno.test("retry-non-idempotent-write: retry loop around a POST fetch (ts)", () =>
  assertHits("retry-non-idempotent-write/hit.ts", "retry-non-idempotent-write", [5]));
Deno.test("retry-non-idempotent-write: an idempotency key is not flagged (py)", () =>
  assertClean("retry-non-idempotent-write/clean.py"));
Deno.test("retry-non-idempotent-write: retrying a model call or a GET is not flagged (ts)", () =>
  assertClean("retry-non-idempotent-write/clean.ts"));

Deno.test("files in other languages are skipped, not guessed at", () => {
  assertEquals(checkText("notes.txt", 'for call in tool_calls: run_tool(call)'), []);
});

// Variants that are easy to get wrong.
Deno.test("tool-call-after-truncation: a length flag checked before the loop guards it", () => {
  const text = [
    "def handle(resp, tools):",
    '    truncated = resp.finish_reason == "length"',
    "    if truncated:",
    "        return None",
    "    for call in resp.tool_calls:",
    "        run_tool(call)",
  ].join("\n");
  assertEquals(checkText("flag.py", text), []);
});

Deno.test("stream-error-ignored: an else branch that silently continues is still flagged", () => {
  const text = [
    "import json",
    "def read(resp):",
    "    for line in resp.iter_lines():",
    "        ev = json.loads(line)",
    '        if ev["type"] == "a":',
    "            pass",
    '        elif ev["type"] == "b":',
    "            pass",
    "        else:",
    "            continue",
  ].join("\n");
  assertEquals(linesOf(checkText("s.py", text), "stream-error-ignored"), [5]);
});

Deno.test("retry-non-idempotent-write: retrying a GET is not flagged", () => {
  const text = [
    "@retry(stop=stop_after_attempt(3))",
    "def get_order(session):",
    '    return session.get("https://shop.example.invalid/orders/1")',
  ].join("\n");
  assertEquals(checkText("g.py", text), []);
});
