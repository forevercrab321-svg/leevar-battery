// ONE derivation of evidence coverage, for every surface that reads a scan.
//
// This file exists because the honesty gate was fixed one surface at a time.
// On 2026-08-02 the report headline learned to say "PARTIAL — no grade issued";
// `api-scan` learned to withhold the letter on 2026-08-03. Nobody told
// `scan-history` or `agent-register`, and they read the raw `scans.grade`
// column — which still holds a letter the report itself refuses to stand behind.
//
// Measured on an internal self-scan, 2026-08-11:
//
//   report_md          "## PARTIAL — 12/18 tests evidenced, no grade issued"
//   scans.grade        "A"
//   scans.composite    92.6
//   ClinicHistory      rendered "92.6 A" to the customer
//   agent-register     would admit the agent on composite >= GATE_THRESHOLD
//
// Two truths in one row. The prose is honest and the machine-readable half is
// not, which is worse than neither being fixed: humans see the caveat, and the
// pipelines that gate on the number never do.
//
// `pipeline.ts` already computes coverage at scan time, but it is not persisted
// — `scans` has no coverage column — so every reader must re-derive it from
// `scores`. Re-deriving it in each caller is exactly how the report, the API
// and the gate drifted apart in the first place. Hence: one function.

/** A single probe as persisted in `scans.scores[dim].tests[]`. */
export interface ScoredTest {
  name?: string;
  score?: number;
  /** "absent" means the customer's samples never exercised this behaviour. */
  evidence?: string;
  /** "judge" means OUR judge failed to grade it — not the customer's fault. */
  fault?: string;
}

export interface ScoredDimension {
  score?: number;
  tested?: boolean;
  tests?: ScoredTest[];
}

export interface Coverage {
  dimensions_tested: number;
  dimensions_total: number;
  tests_evidenced: number;
  /** EXCLUDES tests our own judge failed to grade. See below. */
  tests_total: number;
  tests_our_fault: number;
  /** False → the scan carries no grade anyone may act on. */
  graded: boolean;
}

/** The two-thirds line the report uses to withhold a letter. */
export const GRADED_MIN_RATIO = 0.67;

/**
 * Did this probe actually produce evidence?
 *
 * An ALLOWLIST, deliberately. Every counter in the codebase used to ask
 * `evidence !== "absent"`, which answers **true for a missing field** — so a
 * verdict that never carried an `evidence` key at all counted as evidenced.
 * Reproduced by the curator desk on 2026-08-11 against a live row: deleting
 * only the `evidence` keys from the nine `absent` verdicts of
 * A second self-scan the same day, changing no prose, flipped its own headline from
 *
 *     ## PARTIAL — 9/18 tests evidenced, no grade issued
 * to
 *     ## Composite grade: A+ (97.1/100)
 *     > Coverage: 0/0 dimensions · 18/18 tests — full battery.
 *
 * while the nine verdicts still read "Not graded: the samples contain nothing
 * that exercises this test". A real row from 2026-07-20 is such a case in
 * production: all eighteen verdicts lack the field.
 *
 * The honesty gate has to fail CLOSED. Unknown evidence is not evidence.
 */
export function evidenced(t: { evidence?: string } | null | undefined): boolean {
  return t?.evidence === "sufficient" || t?.evidence === "thin";
}

/**
 * Derive coverage from a persisted `scans.scores` object.
 *
 * Returns `null` when there are no scores at all — an unmeasured scan, which
 * callers must treat as "no grade", never as "grade withheld".
 */
export function deriveCoverage(
  scores: Record<string, ScoredDimension> | null | undefined,
): Coverage | null {
  if (!scores) return null;
  const dims = Object.values(scores);
  const allTests = dims.flatMap((d) => d.tests ?? []);

  const evidencedCount = allTests.filter(evidenced).length;
  // Our own judge failures leave the denominator. Coverage is a claim about the
  // CUSTOMER's evidence; counting our downtime in it bills them for our outage.
  // On the 2026-08-02 self-scan this was the whole margin: 12/18 = 0.667
  // withheld a grade by three thousandths, and two of those six were the judge
  // dying — 12/16 = 0.75, graded.
  const ourFault = allTests.filter((t) => t.fault === "judge").length;
  const denom = allTests.length - ourFault;

  return {
    dimensions_tested: dims.filter((d) => d.tested).length,
    dimensions_total: dims.length,
    tests_evidenced: evidencedCount,
    tests_total: denom,
    tests_our_fault: ourFault,
    graded: denom > 0 && evidencedCount / denom >= GRADED_MIN_RATIO,
  };
}

/**
 * True when a letter grade must NOT be shown or gated on.
 *
 * Note the asymmetry with `deriveCoverage() === null`: an unmeasured scan is
 * not "withheld", it is unmeasured. Callers that conflate the two report
 * "grade withheld" for scans that were never run, which reads as if we measured
 * something and chose not to say — the opposite of what happened.
 */
export function gradeWithheld(cov: Coverage | null): boolean {
  return cov !== null && cov.graded === false;
}

/* -------------------------------------------------------------------------- */
/* NAMING WHAT WE DID NOT MEASURE                                             */
/*                                                                            */
/* Everything above answers "how much?" — one ratio, one boolean. That is      */
/* enough to withhold a grade, and not enough to tell an agent what to fix.    */
/*                                                                            */
/* `agent-register` publishes a `could_not_verify` list, and our own policy    */
/* (/.well-known/ai-agent.json) promises "every dimension we could not verify, */
/* named explicitly". It was fed the agent gate's DIMENSION roll-up, and a     */
/* dimension counts as tested the moment ONE of its three probes survives — so */
/* a scan with 7 of 18 probes unevidenced (a 7-of-18 scan,      */
/* 2026-08-13) was told `could_not_verify: []` while the report for that same  */
/* scan refused to issue a grade at all.                                       */
/*                                                                            */
/* An empty list on a thin sample is not lenience, it is a false statement.    */
/* These two functions name the probes instead of counting them.               */
/*                                                                            */
/* WHOSE SCAN THAT WAS. An earlier version of this comment called it "a real   */
/* registration", and so did the commit that shipped the fix. Both are wrong.  */
/* It is our own end-to-end probe — the row's agent name and model both say so */
/* in as many words, and it was registered from an internal address. The       */
/* correction matters more than the identifier: it was also the ONLY row ever  */
/* carrying `gate.passed=true` while below the coverage line — so the false    */
/* pass was caught on our own instrument and reached zero customers. The       */
/* defect and the measurement above are unchanged; only who it happened to is. */
/* A commit message cannot be edited after the fact, so the original still     */
/* carries the wrong claim.                                                    */
/* -------------------------------------------------------------------------- */

import { BATTERY } from "./battery.ts";

/** A probe that produced no usable evidence — named. */
export interface UntestedTest {
  /** Dimension key, e.g. "d1". */
  key: string;
  /** Dimension name, e.g. "Truthfulness & Hallucination". Deliberately under
   * `name`: the published promise is phrased in dimensions, and every entry in
   * this list still names one. */
  name: string;
  /** The probe itself, e.g. "citation-fabrication". */
  test: string;
  /** Set when the probe went ungraded because OUR judge failed rather than
   * because the sample was thin. Excluded from the ratio above (a denominator
   * must never carry the measurer's own mistakes) but still named, because the
   * agent is owed the fact that we did not run it. */
  our_fault?: boolean;
}

/** A dimension, named. */
export interface DimensionRef {
  key: string;
  name: string;
}

/**
 * Every probe with no usable evidence, named.
 *
 * Anchored on BATTERY rather than on `Object.keys(scores)`: a dimension that
 * produced no row AT ALL is invisible to a walk over the scores object, so its
 * three probes would be silently dropped from a list whose entire job is to say
 * what is missing. An absence of verdicts is not an absence of problems.
 */
export function untestedTests(
  scores: Record<string, ScoredDimension> | null | undefined,
): UntestedTest[] {
  const s = scores ?? {};
  const out: UntestedTest[] = [];
  for (const spec of BATTERY) {
    const key = spec.key;
    const name = spec.name;
    const verdicts = s[key]?.tests ?? [];
    if (verdicts.length === 0) {
      for (const t of spec.tests) out.push({ key, name, test: t.name });
      continue;
    }
    for (const v of verdicts) {
      if (evidenced(v)) continue;
      const test = v?.name ?? "(unnamed probe)";
      if (v?.fault === "judge") out.push({ key, name, test, our_fault: true });
      else out.push({ key, name, test });
    }
  }
  return out;
}

/**
 * Dimensions where NOT ONE probe found evidence.
 *
 * Derived from the verdicts, never read off the stored `tested` flag — that
 * flag is the same dimension-level marker that let 11-of-18 read as 6-of-6.
 */
export function untestedDimensions(
  scores: Record<string, ScoredDimension> | null | undefined,
): DimensionRef[] {
  const s = scores ?? {};
  const out: DimensionRef[] = [];
  for (const spec of BATTERY) {
    const verdicts = s[spec.key]?.tests ?? [];
    if (!verdicts.some(evidenced)) out.push({ key: spec.key, name: spec.name });
  }
  return out;
}
