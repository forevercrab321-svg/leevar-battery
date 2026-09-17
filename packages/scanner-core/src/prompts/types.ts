// The seam between the public scanner and LEEVAR's tuned examiner.
//
// WHY THIS INTERFACE EXISTS
// -------------------------
// The three judge factories used to close over two module constants and a
// module-private function. That made the scanner unpublishable: extracting it
// would have carried the tuned prompt text with it, and leaving the text behind
// would have left the scanner unable to run at all.
//
// So the prompts became a parameter. The public package ships a default set
// that genuinely works — see `default.ts` — and LEEVAR passes its own.
//
// WHAT IS AND IS NOT SECRET
// -------------------------
// The METHOD is public and has been for some time: the live leevar-battery
// README publishes the operating principle, including that a dimension the
// evidence cannot support is reported NOT TESTED and excluded from the
// composite. Anyone may reimplement that.
//
// What is not published is the tuned TEXT and its calibration — the exact
// wording that makes a model apply the boundary consistently. That is the part
// no reader of the rubric can re-derive, and it is the only part withheld.

import type { DimensionSpec, TestSpec } from "../battery.ts";
import type { AgentMeta } from "../types.ts";

export interface JudgeContext {
  agent: AgentMeta;
  dim: DimensionSpec;
  test: TestSpec;
  /** The probe evidence: transcript samples joined, or live-call responses. */
  probe: string;
  /**
   * True when the evidence is a transcript containing tool output the agent
   * under test wrote itself.
   */
  selfReportedTools?: boolean;
}

export interface JudgePrompts {
  /** Examiner instruction. Must demand the JSON contract below. */
  system: string;
  /** Renders one test into a user message. */
  buildUser(ctx: JudgeContext): string;
}

/**
 * The response contract every prompt set must produce, whatever its wording.
 *
 * `evidence: "absent"` is load-bearing, not decorative: the grading loop drops
 * absent verdicts from the dimension mean, and a dimension left with no graded
 * tests is reported NOT TESTED rather than scored. A prompt set that never
 * returns "absent" turns this scanner into one that guesses — which is the
 * behaviour it exists to refuse.
 */
export const RESPONSE_CONTRACT =
  '{"score": <0-100 integer>, "result": "pass"|"partial"|"fail", ' +
  '"evidence": "sufficient"|"thin"|"absent", "detail": "<one evidence-grounded sentence>"}';
