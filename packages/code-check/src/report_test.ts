import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { renderMarkdown } from "./report.ts";
import { CATALOG_BASE_URL, RULES } from "./rules.ts";
import type { ScanResult } from "./check.ts";
import type { RuleId } from "./types.ts";

function resultWith(rules: RuleId[]): ScanResult {
  return {
    root: "my-agent",
    filesScanned: 3,
    findings: rules.map((rule, i) => ({
      rule,
      file: "agent.py",
      line: 10 + i,
      snippet: "for call in tool_calls:",
      detail: "specific detail",
    })),
  };
}

Deno.test("there are exactly five rules, each with a why and a fix", () => {
  assertEquals(RULES.map((r) => r.id), [
    "tool-call-after-truncation",
    "repaired-json-applied",
    "stream-error-ignored",
    "success-as-error",
    "retry-non-idempotent-write",
  ]);
  for (const r of RULES) assert(r.why && r.fix && r.title);
});

Deno.test("every catalog link points at a file that exists in docs/catalog", async () => {
  for (const r of RULES) {
    for (const c of r.catalog) {
      const url = new URL(import.meta.resolve(`../../../docs/catalog/${c.file}`));
      const text = await Deno.readTextFile(url);
      assert(text.startsWith(`# ${c.id} - `), `${c.file} is entry ${c.id}`);
    }
  }
});

Deno.test("each finding is rendered with file:line and its rule's catalog links", () => {
  const md = renderMarkdown(resultWith(RULES.map((r) => r.id)));
  for (const r of RULES) {
    assertStringIncludes(md, r.id);
    for (const c of r.catalog) assertStringIncludes(md, `${CATALOG_BASE_URL}${c.file}`);
  }
  assertStringIncludes(md, "agent.py:10");
  assertStringIncludes(md, "pattern, not yet in catalog");
});

Deno.test("the report says these are possible issues to confirm, not bugs", () => {
  const md = renderMarkdown(resultWith(["success-as-error"]));
  assertStringIncludes(md, "Possible issues");
  assertStringIncludes(md, "confirm");
  assert(!/your code has (a )?bugs?/i.test(md));
});

Deno.test("no findings is said plainly, without claiming the code is fine", () => {
  const md = renderMarkdown(resultWith([]));
  assertStringIncludes(md, "No matches");
  assertStringIncludes(md, "not proof");
  assertStringIncludes(md, "3 files");
});
