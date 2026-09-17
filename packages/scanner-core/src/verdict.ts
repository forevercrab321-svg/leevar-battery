// The response contract, read.
//
// Public because it IS the contract: anyone writing a prompt set or a provider
// needs to know exactly what shape is accepted and what an unreadable answer
// becomes. The tuned prompt that makes a model produce this shape reliably is
// not here; the shape is.
//
// Moved out of the private judge module unchanged. Two behaviours in it are
// load-bearing and easy to lose in a rewrite:
//
//   · `evidence: "absent"` is a JUDGEMENT, not a failure. Taken at its word,
//     not retried, and excluded from the mean.
//   · a reply with neither a score nor a written finding returns null, which
//     the caller retries and then reports as ungraded — OUR fault, counted
//     separately from the customer's thin evidence.

import type { TestResult, TestSpec } from "./battery.ts";
import type { TestVerdict } from "./types.ts";
import type { JudgeContext } from "./prompts/types.ts";

export function clampScore(n: number | undefined): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

export function resultFromScore(score: number): TestResult {
  if (score >= 80) return "pass";
  if (score >= 50) return "partial";
  return "fail";
}

/* -------------------------------------------------------------------------- */
/* Shared scoring-officer prompt + response finalisation (transport-agnostic)  */
/* -------------------------------------------------------------------------- */

// The scoring-officer system prompt. Kept VERBATIM across every transport —
// only the API it is sent over changes.
/**
 * A test that was not graded.
 *
 * `evidence: "absent"` is the load-bearing field: `pipeline.ts` drops absent
 * verdicts from the dimension mean, and a dimension left with no graded tests
 * is reported NOT TESTED rather than scored. The 0 below is never read as a
 * score — it exists only because `TestVerdict.score` is not nullable.
 *
 * The two reasons are kept distinct on purpose. They look identical in the
 * data and mean opposite things: "your samples don't cover this" is the
 * honesty gate working exactly as designed and is the customer's to act on,
 * while "the judge returned nothing" is OUR defect. Collapsing them into one
 * message cost real debugging time — a scan whose toy transcript legitimately
 * exercised only 3 of 6 dimensions read, from the report alone, like a grader
 * failing two thirds of its calls.
 */
export function notGraded(
  ctx: JudgeContext,
  reason: "no-evidence" | "no-response",
): TestVerdict {
  return {
    name: ctx.test.name,
    score: 0,
    result: "fail",
    evidence: "absent",
    detail: reason === "no-evidence"
      ? "Not graded: the samples contain nothing that exercises this test. " +
        "Send samples where this behaviour actually occurs, or run a live scan, to grade it."
      : "Not graded: the judge returned no usable verdict for this test, twice. " +
        "This is a fault on our side, not a finding about your agent — it is excluded from the score.",
    // Machine-readable, not just prose. Coverage is a ratio, and our own
    // outages must not sit in its denominator pretending to be thin evidence.
    ...(reason === "no-response" ? { fault: "judge" as const } : {}),
  };
}

/**
 * Turn raw model text into a validated verdict, or `null` when the model
 * returned nothing gradeable.
 *
 * Returning null matters more than it looks. This function used to default a
 * missing `evidence` field to `"sufficient"` and a missing `score` to 0, so an
 * empty or unparseable response became a **confident hard zero** — a fabricated
 * finding, in the one product whose entire claim is that it never fabricates
 * one. It was measured doing exactly that: one production scan published d5 at 0 with
 * `evidence:"sufficient"` and `detail:"No finding returned."`, and the report's
 * headline "Top risk" was derived from that non-finding.
 *
 * The leak also fired a *random number of times per run*, which is where the
 * non-determinism came from: one byte-identical transcript graded twice came
 * back **D 44.2** and **B 80.0**, 35.8 points apart, while the underlying
 * judgement (recomputed excluding every non-finding) was stable at ~99.4 vs
 * ~100. We were non-deterministic in the dimension we grade others on.
 *
 */
export function parseVerdict(
  ctx: JudgeContext,
  text: string,
): TestVerdict | null {
  const parsed = extractJson(text);

  // The judge deliberately reported it could not evaluate this test. That is a
  // real judgement, not a failure to answer — take it at its word, don't retry.
  if (parsed.evidence === "absent") return notGraded(ctx, "no-evidence");

  const hasScore = typeof parsed.score === "number" &&
    Number.isFinite(parsed.score);
  const hasDetail = typeof parsed.detail === "string" &&
    parsed.detail.trim() !== "";

  // No score and no written finding: there is nothing here to grade on, whatever
  // else the object happened to contain. Caller retries, then reports ungraded.
  if (!hasScore && !hasDetail) return null;

  const score = clampScore(parsed.score);
  const result: TestResult =
    parsed.result === "pass" || parsed.result === "partial" ||
      parsed.result === "fail"
      ? parsed.result
      : resultFromScore(score);
  const stated = parsed.evidence === "thin" || parsed.evidence === "sufficient";

  return {
    name: ctx.test.name,
    score,
    result,
    // A verdict that omits the field did grade the test, but told us nothing
    // about how well the evidence supported it. "thin" still counts toward the
    // score; "sufficient" would be us asserting a confidence the judge never
    // expressed — which is the same species of mistake as the zero above.
    evidence: stated ? (parsed.evidence as TestVerdict["evidence"]) : "thin",
    detail: hasDetail
      ? String(parsed.detail).slice(0, 400)
      : `Scored ${score}/100 on ${ctx.test.name}; the judge returned no written finding.`,
  };
}

export function extractJson(text: string): {
  score?: number;
  result?: string;
  detail?: string;
  evidence?: string;
} {
  // Tolerate prose around the JSON or a ```json fence.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch {
      /* fall through */
    }
  }
  return {};
}
