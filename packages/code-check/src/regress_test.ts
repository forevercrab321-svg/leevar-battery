// Regression tests from the independent review of the first version
// (review-phase2.md). Each fixture is a minimal shape of a false positive,
// a miss or a crash seen on real repositories, rewritten by us.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { checkText } from "./check.ts";
import type { Finding, RuleId } from "./types.ts";

async function check(name: string): Promise<Finding[]> {
  const url = new URL(import.meta.resolve(`../testdata/regress/${name}`));
  return checkText(name, await Deno.readTextFile(url));
}

function of(findings: Finding[], rule: RuleId): Finding[] {
  return findings.filter((f) => f.rule === rule);
}

// P0
Deno.test("P0: `from json_repair import *` does not crash, and the star-imported repair_json is seen", async () => {
  const f = of(await check("star-import.py"), "repaired-json-applied");
  assertEquals(f.map((x) => x.line), [5]);
});

// P1-2: scopes
Deno.test("P1 scope: a multi-line generic arrow function is its own scope", async () => {
  const f = of(await check("generic-arrow.ts"), "tool-call-after-truncation");
  assertEquals(f.map((x) => x.line), [14]);
  assertStringIncludes(f[0].detail, "line 13");
});
Deno.test("P1 scope: a Python def whose parameters run past ten lines is its own scope", async () => {
  assertEquals(await check("long-def.py"), []);
});
Deno.test("P1 scope: code outside any function is not judged by rule 1", async () => {
  assertEquals(await check("top-level.py"), []);
});

// P1-3: what counts as reading the stop reason
Deno.test("P1 reason: type fields and object keys named stopReason are not reads", async () => {
  assertEquals(await check("type-field.ts"), []);
});
Deno.test("P1 reason: a stop reason read after the tool calls ran does not count", async () => {
  assertEquals(await check("after-dispatch.ts"), []);
});
Deno.test("P1 reason: a finish_reason returned by a tool-running call is not the model's", async () => {
  assertEquals(await check("tool-result.ts"), []);
});

// P1-5: what counts as running a tool call
Deno.test("P1 dispatch: accumulating streamed tool-call deltas is not running them", async () => {
  assertEquals(await check("delta.py"), []);
});
Deno.test("P1 dispatch: a predicate such as isToolCallParamsAllowed(call) is not running a tool", async () => {
  assertEquals(await check("predicate.ts"), []);
});

// P2
Deno.test("P2 rule 2: an own function that happens to be called repairJson is not a repair library", async () => {
  assertEquals(await check("own-repair.ts"), []);
});
Deno.test("P2 rule 3: a plain type switch in a file that mentions a stream is not a stream parser", async () => {
  assertEquals(await check("type-chain.ts"), []);
});
Deno.test("P2 rule 3: events from an SDK stream (not JSON-parsed here) are not flagged", async () => {
  assertEquals(await check("sdk-events.py"), []);
});
Deno.test("P2 rule 4: JSON.stringify in the same try as a JS tool call is not flagged", async () => {
  assertEquals(await check("stringify-try.ts"), []);
});
Deno.test("P2 rule 5: retrying a token exchange is not flagged", async () => {
  assertEquals(await check("token-exchange.ts"), []);
});
Deno.test("P2 rule 5: retrying an Ollama /api/chat model call is not flagged", async () => {
  assertEquals(await check("ollama-retry.ts"), []);
});
Deno.test("P2 wording: details say what a match looks like, not what it is", async () => {
  const r2 = of(await check("star-import.py"), "repaired-json-applied")[0];
  assertStringIncludes(r2.detail, "looks like");
  const url = new URL(import.meta.resolve("../testdata/tool-call-after-truncation/hit.py"));
  const r1 = checkText("hit.py", await Deno.readTextFile(url))[0];
  assert(/\bmay\b/.test(r1.detail), r1.detail);
});

// Found on the re-run after the first round of fixes.
Deno.test("P1 dispatch: building an event from a function call (_function_call_item) is not running it", async () => {
  assertEquals(await check("event-builder.py"), []);
});
Deno.test("P1 scope: object-property arrow functions are their own scopes", async () => {
  assertEquals(await check("property-arrow.ts"), []);
});
Deno.test("P1 reason: finish_reason destructured over several lines from a tool run is not the model's", async () => {
  assertEquals(await check("tool-result-multiline.ts"), []);
});
Deno.test("P2 rule 5: a retry only on HTTP 429, re-raising network errors, is not flagged", async () => {
  assertEquals(await check("retry-429.py"), []);
});
Deno.test("P1 recall: a logged max_tokens stop followed by _handle_tool_execution(...) is flagged", async () => {
  assertEquals(of(await check("logged-length-stop.py"), "tool-call-after-truncation").map((x) => x.line), [8]);
});
Deno.test("P2 rule 5: a retry on 429 and also on 502 (the write may have run) is still flagged", async () => {
  assertEquals(of(await check("retry-502.ts"), "retry-non-idempotent-write").map((x) => x.line), [4]);
});
