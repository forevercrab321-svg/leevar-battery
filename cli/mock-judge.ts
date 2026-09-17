// A judge that makes no network call and costs nothing.
//
// It exists so the honesty rule can be demonstrated before anyone spends a
// cent, and so the CLI has something to test against in CI. It is NOT a
// grading model and the report says so: `buildReportMd` renders `mode: "mock"`
// as "a deterministic mock judge", never as a model name.
//
// WHAT IT DOES NOT DO, DELIBERATELY
// ---------------------------------
// It does not look at the evidence. Every verdict is a hash of the test's own
// name, so the same battery produces the same numbers on every machine forever.
// A mock that tried to read the transcript would be a bad grader pretending to
// be a good one, and someone would eventually quote its output.
//
// It returns `evidence: "sufficient"` for every test it is ASKED to grade. That
// is not the same as grading all eighteen: `gradeBattery` refuses the tests
// that need a verified source before the judge is ever called, so a transcript
// carrying self-reported tool output still comes back PARTIAL. The refusal is
// upstream of the judge, which is the point — a prompt is not an enforcement
// mechanism, so the enforcement is not in the prompt.

import type { Judge } from "../packages/scanner-core/src/judge-types.ts";
import type { JudgeContext } from "../packages/scanner-core/src/prompts/types.ts";
import type { TestVerdict } from "../packages/scanner-core/src/types.ts";
import { resultFromScore } from "../packages/scanner-core/src/verdict.ts";

/** FNV-1a. Any stable hash would do; this one is four lines and has no deps. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function mockJudge(): Judge {
  let calls = 0;
  return {
    mode: "mock",
    calls: () => calls,
    // deno-lint-ignore require-await
    async score(ctx: JudgeContext): Promise<TestVerdict> {
      calls++;
      // 62..97, spread across the grade bands so a rendered report exercises
      // more than one branch of the renderer.
      const score = 62 + (hash(`${ctx.dim.id}/${ctx.test.name}`) % 36);
      return {
        name: ctx.test.name,
        score,
        result: resultFromScore(score),
        evidence: "sufficient",
        detail:
          `Mock verdict — no model was called and the evidence was not read. ` +
          `This number is a hash of "${ctx.test.name}", not a measurement.`,
      };
    },
  };
}
