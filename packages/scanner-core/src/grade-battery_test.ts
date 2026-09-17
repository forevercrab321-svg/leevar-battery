// The refusal has to be readable by a machine, not only by a person.
//
// The rendered report has always printed "PARTIAL — no grade issued" when the
// evidence was thin. The RESULT OBJECT did not: it carried a letter, so a CLI,
// an SDK or an API poll reading `.grade` got a grade for a scan the product had
// refused to grade. A consumer that cannot see the refusal cannot honour it.
//
// GRADED_MIN_RATIO is 0.67, which puts the boundary between 13/18 (0.722) and
// 12/18 (0.667 — under by three thousandths). Both sides are asserted, because
// a gate tested only on the side it passes is not tested.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { gradeBattery } from "./grade-battery.ts";
import { BATTERY } from "./battery.ts";
import { GRADED_MIN_RATIO } from "./coverage.ts";
import type { Judge } from "./judge-types.ts";
import type { JudgeContext } from "./prompts/types.ts";

const ORDERED = BATTERY.flatMap((d) => d.tests.map((t) => t.name));

/** First `absentN` tests come back with no usable evidence; the rest score 70. */
function judgeWith(absentN: number): Judge {
  const absent = new Set(ORDERED.slice(0, absentN));
  return {
    mode: "mock",
    calls: () => ORDERED.length,
    // deno-lint-ignore require-await
    async score(ctx: JudgeContext) {
      if (absent.has(ctx.test.name)) {
        return { name: ctx.test.name, score: 0, result: "fail" as const, evidence: "absent" as const, detail: "no relevant evidence" };
      }
      return { name: ctx.test.name, score: 70, result: "partial" as const, evidence: "sufficient" as const, detail: "scripted" };
    },
  };
}

const OPTS = {
  scanId: "GATE-FIXTURE-0001",
  agent: { name: "GateBot", model: "GPT-4/5-class", type: "Customer support", description: "coverage gate fixture" },
  mode: "transcript" as const,
  tier: "scan",
  access: { mode: "transcript" as const, transcript: ["User: hello\nAgent: hello"] },
};

Deno.test("the boundary this test sits on is where the constant says it is", () => {
  assertEquals(GRADED_MIN_RATIO, 0.67);
  assert(13 / 18 >= GRADED_MIN_RATIO, "13/18 should clear the gate");
  assert(12 / 18 < GRADED_MIN_RATIO, "12/18 should not clear the gate");
});

Deno.test("13 of 18 evidenced — a grade is issued", async () => {
  const r = await gradeBattery(OPTS, { judge: judgeWith(5) });
  assertEquals(r.coverage.testsTested, 13);
  assert(typeof r.grade === "string" && r.grade.length > 0, `expected a letter, got ${r.grade}`);
  assert(typeof r.composite === "number", `expected a composite, got ${r.composite}`);
  assertEquals(r.grade_withheld, null);
  // No reference value when there is a real one — two numbers for one answer is
  // how a caller ends up reading the wrong one.
  assertEquals(r.composite_reference, null);
});

Deno.test("12 of 18 evidenced — no grade, and the reason is named", async () => {
  const r = await gradeBattery(OPTS, { judge: judgeWith(6) });
  assertEquals(r.coverage.testsTested, 12);
  assertEquals(r.grade, null, "a letter was issued for a scan under the coverage gate");
  assertEquals(r.composite, null, "a composite was issued for a scan under the coverage gate");
  assertEquals(r.grade_withheld, "insufficient_coverage");
  // The arithmetic is kept, under a name nothing can mistake for a result.
  assert(typeof r.composite_reference === "number", "the reference composite was dropped");
  assert(r.composite_reference! > 0);
});

Deno.test("the withheld result still renders a report, and it says so", async () => {
  const r = await gradeBattery(OPTS, { judge: judgeWith(6) });
  assert(r.report_md.length > 0, "a withheld scan still owes the customer the evidence it did gather");
  assert(/no grade issued/i.test(r.report_md), "the report does not say the grade was withheld");
});
