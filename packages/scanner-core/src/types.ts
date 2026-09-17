// Shared types for the clinic scan engine.

import type { TestResult } from "./battery.ts";

export type ScanTier = "scan" | "full" | "treatment";
export type ScanMode = "live" | "transcript";
export type ScanStatus =
  | "queued"
  | "running"
  | "graded"
  | "delivered"
  | "failed";

/** The agent under test, from the clinic-scan submission meta. */
export interface AgentMeta {
  name: string;
  model: string; // model class, e.g. 'GPT-4-CLASS'
  type: string; // agent type, e.g. 'Customer support'
  description: string;
}

/**
 * Probe input the engine feeds the judge.
 * - transcript mode: `transcript` = customer-supplied conversation samples.
 * - live mode: `endpoint` (+ optional headers) is called to obtain responses.
 */
export interface ScanAccess {
  mode?: ScanMode;
  transcript?: string[]; // conversation samples (default mode)
  endpoint?: string; // live-mode callable endpoint
  headers?: Record<string, string>; // live-mode auth headers
}

/** A single row of public.scans as read via the service role. */
export interface ScanRow {
  id: string;
  submission_id: string | null;
  agent_name: string;
  mode: ScanMode;
  tier: ScanTier | string;
  status: ScanStatus;
  access: ScanAccess | null;
  scores: DimensionScores | null;
  composite: number | null;
  grade: string | null;
  report_md: string | null;
  error: string | null;
  created_at?: string;
  completed_at?: string | null;
}

export interface TestVerdict {
  name: string;
  score: number; // 0..100
  result: TestResult;
  detail: string; // one-sentence evidence-grounded finding
  /** Whether the supplied evidence actually supported grading THIS test.
   * "absent" verdicts are excluded from the dimension mean + composite so a
   * thin transcript can't produce a confident, fabricated score. */
  evidence: "sufficient" | "thin" | "absent";
  /**
   * Set ONLY when the test went ungraded because WE failed — the judge returned
   * nothing usable twice — rather than because the customer's samples did not
   * exercise the behaviour. Both look like `evidence: "absent"` in the data,
   * and until 2026-08-02 nothing downstream could tell them apart.
   *
   * That mattered in a way nobody predicted. Coverage is a ratio, so our own
   * outages were quietly counted as the customer failing to provide evidence:
   * a self-scan came back 12/18 = 0.667, three thousandths under the line that
   * withholds a grade — and two of those six were our judge dying twice.
   * Excluding our own faults it was 12/16 = 0.75, comfortably graded. We
   * withheld a grade from a customer to cover for our own failure.
   *
   * A denominator must never include the measurer's own mistakes.
   */
  fault?: "judge";
}

export interface DimensionScore {
  score: number; // dimension mean over tested tests, 0..100
  tests: TestVerdict[];
  /** false when NO test in this dimension had usable evidence — the dimension
   * is reported "not tested" and excluded from the composite. */
  tested: boolean;
}

/** scores jsonb — keyed d1..d6. */
export type DimensionScores = Record<string, DimensionScore>;

export interface GradedResult {
  scores: DimensionScores;
  /**
   * The composite, or NULL when coverage did not clear GRADED_MIN_RATIO.
   *
   * Nullable rather than 0, and nullable rather than "the number is there but
   * the markdown says PARTIAL". The rendered report has always said "no grade
   * issued" when the evidence was thin; the machine result did not, so a CLI or
   * an SDK reading `.grade` off this object got a letter for a scan the product
   * had refused to grade. A caller that cannot see the refusal cannot honour it.
   */
  composite: number | null;
  /** The letter, or NULL under the same condition as `composite`. */
  grade: string | null;
  /**
   * Why there is no grade. Exactly one reason exists today, and it is named
   * rather than implied by two nulls, so a consumer can branch on it and a new
   * reason later is an added variant instead of a silent change of meaning.
   */
  grade_withheld: "insufficient_coverage" | null;
  /**
   * What the composite WOULD have been, when it is withheld.
   *
   * Present so the number is not lost — the private layer stores it, and the
   * report prints the PARTIAL section from it — but under a name no caller can
   * mistake for a result. `composite` is the answer; this is the arithmetic.
   */
  composite_reference: number | null;
  report_md: string;
  /**
   * What the battery actually managed to measure. Present on the result rather
   * than only inside the rendered markdown, because every caller that decides
   * something — the report headline, the API poll, the agent gate — needs the
   * ratio, and re-deriving it three times is how the three of them drifted
   * apart in the first place.
   *
   * `testsTotal` EXCLUDES `testsOurFault`: coverage is a claim about the
   * customer's evidence, so tests our own judge failed to grade do not belong
   * in its denominator. They are reported separately so a smaller denominator
   * can never quietly flatter the ratio.
   */
  coverage: {
    tested: number;
    total: number;
    testsTested: number;
    testsTotal: number;
    testsOurFault: number;
  };
}
