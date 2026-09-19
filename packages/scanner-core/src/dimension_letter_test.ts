// A dimension may not wear a letter its probes did not evidence, and a probe we
// did not run is not a failure.
//
// Both were delivered on 2026-09-17. SCN-2026-5499 was a two-line greeting —
// nothing in it exercises the battery — and its report carried:
//
//   ### D5 · Context Window Management — 74.3 C+        (one evidenced probe of three)
//   - **FAIL** · `citation-fabrication` · _(no evidence — excluded)_
//
// inside a report whose headline said "PARTIAL — 2/18 tests evidenced, no grade
// issued". `tested` goes true on one surviving probe; the letter was computed
// off the mean of whatever survived.
//
// Ported from leevar-home supabase/functions/_shared/dimension_letter_test.ts
// (PR #236), so the open renderer and the hosted one are held to the same rule.
//
// Run: deno test --allow-read packages/scanner-core/src/dimension_letter_test.ts

import { assert, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

import { buildReportMd } from "./report.ts";
import { BATTERY } from "./battery.ts";
import type { AgentMeta, DimensionScores } from "./types.ts";

const agent = { name: "LetterBot", model: "test", type: "support", description: "test" } as AgentMeta;

/** `ev` is how many of the dimension's three probes carry evidence. */
function dimension(key: string, ev: number, score: number) {
  const spec = BATTERY.find((d) => d.key === key)!;
  return {
    score,
    tested: ev > 0,
    tests: spec.tests.map((t, i) => ({
      name: t.name,
      score,
      result: i < ev ? "pass" : "fail",
      evidence: i < ev ? "sufficient" : "absent",
      detail: i < ev ? "Evidenced in the samples." : "Not graded: the samples do not exercise this test.",
    })),
  };
}

function report(evPerDim: number[]): string {
  const scores = Object.fromEntries(
    BATTERY.map((d, i) => [d.key, dimension(d.key, evPerDim[i], 74.3)]),
  ) as unknown as DimensionScores;
  return buildReportMd({
    scanId: "SCN-TEST-LETTER",
    agent,
    tier: "scan",
    mode: "transcript",
    judgeMode: "deepseek",
    scores,
    composite: 74.3,
    grade: "C+",
  } as never);
}

Deno.test("one evidenced probe of three earns a number, not a letter", () => {
  const md = report([1, 1, 1, 1, 1, 1]);
  assert(!/— 74\.3 C\+/.test(md), md.split("\n").filter((l) => l.startsWith("### ")).join("\n"));
  assertStringIncludes(md, "74.3 on 1 of 3 probes · no letter");
  assertStringIncludes(md, "a reading, not a grade");
});

Deno.test("two of three is NOT enough — the composite's line, applied here too", () => {
  // Owner decision 2026-09-17: GRADED_MIN_RATIO (0.67) everywhere rather than
  // an exact two thirds, because making the constant exact would flip the real
  // 12/18 scan to graded. Over three probes 0.67 means all three.
  const md = report([2, 2, 2, 2, 2, 2]);
  assert(!/— 74\.3 C\+/.test(md), md.split("\n").filter((l) => l.startsWith("### ")).join("\n"));
  assertStringIncludes(md, "74.3 on 2 of 3 probes · no letter");
});

Deno.test("three of three earns the letter", () => {
  const md = report([3, 3, 3, 3, 3, 3]);
  assertStringIncludes(md, "74.3 C+");
  assert(!md.includes("no letter"), md.split("\n").filter((l) => l.startsWith("### ")).join("\n"));
});

Deno.test("a probe with no evidence is NOT TESTED, never FAIL", () => {
  const md = report([1, 1, 1, 1, 1, 1]);
  const lines = md.split("\n").filter((l) => l.startsWith("- **"));
  const unevidenced = lines.filter((l) => l.includes("no evidence"));
  assert(unevidenced.length === 12, `expected 12 unevidenced probes, got ${unevidenced.length}`);
  for (const l of unevidenced) {
    assertStringIncludes(l, "**NOT TESTED**");
    assert(!l.startsWith("- **FAIL**"), l);
  }
  // Control: an evidenced probe keeps the judge's own verdict.
  assert(lines.some((l) => l.startsWith("- **PASS**") && !l.includes("no evidence")), lines[0]);
});

Deno.test("a dimension with no evidence at all is still NOT TESTED", () => {
  const md = report([0, 2, 2, 2, 2, 2]);
  assertStringIncludes(md, "NOT TESTED");
  assertStringIncludes(md, "excluded from the composite (not scored 0)");
});
