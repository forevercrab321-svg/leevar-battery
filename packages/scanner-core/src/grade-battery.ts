// The pure grading path: 18 tests, 6 dimensions, one honest letter — or none.
//
// This is the half of the old pipeline.ts that can be public. The other half,
// executeScan, reaches a database, a mailer, the paid Hire Check and the
// delivery path, and stays private. Mistaking the two is the mistake this file
// exists to make impossible: pipeline.ts imported jobfit.ts directly, so the
// file as a unit could never have been published, and an earlier plan said it
// could.
//
// Nothing here performs I/O except through `deps.judge`, and nothing here knows
// who is running it.

import { BATTERY, type DimensionSpec, type TestSpec } from "./battery.ts";
import { deriveCoverage, evidenced, type ScoredDimension } from "./coverage.ts";
import { gradeLetter, round1 } from "./grade.ts";
import {
  hasSelfReportedToolOutput,
  liveProbe,
  ProbeError,
  transcriptEvidence,
} from "./probe.ts";
import { JUDGE_POOL, pooled } from "./pool.ts";
import { buildReportMd, type ReportRenderOpts } from "./report.ts";
import type { Judge } from "./judge-types.ts";
import type {
  AgentMeta,
  DimensionScores,
  GradedResult,
  ScanAccess,
  ScanMode,
  TestVerdict,
} from "./types.ts";

export interface GradeDeps {
  judge: Judge;
  onProgress?: (msg: string) => void;
  /**
   * Branding and prescriptions for the rendered report.
   *
   * Omitted, the report renders unbranded and without a prescription section —
   * which is the correct public default. LEEVAR passes its own, which is why
   * extracting this function changed no byte of a real report.
   */
  report?: ReportRenderOpts;
}

/** Run all 6 dimensions × 3 tests and assemble scores + composite + report_md. */
export async function gradeBattery(
  opts: {
    scanId: string;
    agent: AgentMeta;
    mode: ScanMode;
    tier: string;
    access: ScanAccess;
    turnaround?: string;
  },
  deps: GradeDeps,
): Promise<GradedResult> {
  const { agent, mode, access } = opts;
  const scores: DimensionScores = {};

  // transcript mode shares one evidence blob across tests; live mode probes per test.
  const sharedEvidence = mode === "transcript"
    ? transcriptEvidence(access)
    : null;

  // The 18 tests run through the shared concurrency pool. Sequential execution
  // blows the Edge Function wall-clock limit with a real LLM judge
  // (18 × ~30–60s thinking calls ≈ 10+ min — verified in production
  // 2026-07-21, zombie `running` scan). 9-way ≈ 2 judge round-trips.
  // Job-Fit uses the SAME pool (see pool.ts) — it did not until 2026-08-03,
  // and that asymmetry is what killed every job-spec scan at ~24 minutes.
  const tasks: { dim: DimensionSpec; test: TestSpec }[] = [];
  for (const dim of BATTERY) {
    for (const test of dim.tests) tasks.push({ dim, test });
  }

  // Trust boundary. When the evidence is a transcript the agent itself wrote,
  // any tool output inside it is a CLAIM, not an observation — so the tests that
  // grade whether a cited source or result is REAL cannot be graded at all. We
  // refuse them up front rather than asking the judge nicely: the judge already
  // had "Never invent evidence" in its prompt when it scored a fabricated $150
  // refund 100/100 on truthfulness. A prompt is not an enforcement mechanism.
  const selfReportedTools = mode === "transcript" &&
    sharedEvidence !== null &&
    hasSelfReportedToolOutput(sharedEvidence);

  const graded = await pooled(tasks, JUDGE_POOL, async ({ dim, test }) => {
    if (selfReportedTools && test.needsVerifiedSource) {
      const verdict: TestVerdict = {
        name: test.name,
        score: 0,
        result: "fail",
        evidence: "absent", // excluded from the dimension mean below
        detail:
          "Not graded: the transcript's tool output was written by the agent under test, " +
          "so it cannot establish whether the cited source or result is real. " +
          "Run this agent in live mode, or supply verified tool results, to grade it.",
      };
      deps.onProgress?.(`${dim.id}/${test.name}: not graded (unverifiable source)`);
      return { dim, verdict };
    }
    const probe = sharedEvidence ??
      (await liveProbe(access, agent, dim, test));
    const verdict = await deps.judge.score({
      agent,
      dim,
      test,
      probe,
      selfReportedTools,
    });
    deps.onProgress?.(
      `${dim.id}/${test.name}: ${verdict.score} ${verdict.result}`,
    );
    return { dim, verdict };
  });

  const dimWeights: { mean: number; n: number }[] = [];
  for (const dim of BATTERY) {
    const verdicts: TestVerdict[] = graded
      .filter((g) => g.dim.key === dim.key)
      .map((g) => g.verdict);
    // Honesty gate: only tests the evidence actually supported count toward the
    // score. A dimension with no usable evidence is "not tested", not a low score.
    const scored = verdicts.filter(evidenced);
    const tested = scored.length > 0;
    const mean = tested
      ? scored.reduce((s, v) => s + v.score, 0) / scored.length
      : 0;
    scores[dim.key] = { score: round1(mean), tests: verdicts, tested };
    // Carry the probe count with the mean so the composite can weight by it.
    if (tested) dimWeights.push({ mean, n: scored.length });
  }

  // ONE COUNT, READ BY BOTH THE COMPOSITE AND THE COVERAGE OBJECT.
  //
  // This used to be two: `testedTests`, accumulated by hand in the loop above to
  // normalise the composite, and a separate hand-rolled coverage object below.
  // Both counted evidenced probes, and nothing made them agree — which is the
  // same shape as the defect this PR exists to fix, one scope smaller. The
  // derivation now happens once, in coverage.ts, and the composite divides by
  // the very number the report and the gate are shown.
  //
  // Tests, not just dimensions. A dimension counts as "tested" the moment ONE
  // of its three probes survives, so dimension-level coverage printed
  // "6/6 — full battery" on a scan with 6 of 18 tests excluded, whose D1
  // Truthfulness scored a clean 100 precisely BECAUSE citation-fabrication and
  // grounded-qa were both excluded. The dimension number cannot see that.
  //
  // The denominator excludes tests OUR judge failed to grade, and reports them
  // separately so a smaller denominator can never quietly flatter the ratio.
  // Measured on a self-scan 2026-08-02: 12/18 = 0.667 withheld a grade by three
  // thousandths, and two of those six were the judge dying twice — 12/16 = 0.75,
  // graded.
  const cov = deriveCoverage(scores as Record<string, ScoredDimension>);
  const coverage = {
    tested: cov?.dimensions_tested ?? 0,
    total: BATTERY.length,
    testsTested: cov?.tests_evidenced ?? 0,
    testsTotal: cov?.tests_total ?? 0,
    testsOurFault: cov?.tests_our_fault ?? 0,
  };

  // COMPOSITE IS WEIGHTED BY PROBES, NOT BY DIMENSIONS.
  //
  // The old line took the mean over dimensions that had any evidence at all, so
  // a dimension carried by ONE surviving probe counted exactly as much as one
  // with all three — and a dimension that lost every probe left the denominator
  // entirely, which RAISES the average whenever the dropped dimension was weak.
  // Measured across the four 2026-08-11 self-scans, grouped by how many probes a
  // dimension had left:
  //
  //     3 probes left -> mean 88.4      2 left -> 90.4      1 left -> 97.9
  //
  // Less measurement, higher score, monotonically. The highest grade in the
  // whole database (A+ 97.1) sits on the thinnest coverage (9/18). On one real
  // pair of same-input, zero-treatment rescans the report printed "Improved by
  // 35.8 points" when coverage had in fact fallen 14/18 -> 10/18; 13.3 of those
  // points came from D6 losing its last probe and dropping out of the mean.
  //
  // Weighting by evidenced probes removes the reward for measuring less: a
  // dimension resting on one probe now contributes one probe's worth. It does
  // not, on its own, stop a dropped dimension from leaving the pool — the
  // coverage withhold above is what handles that — but it stops the silent
  // upward drift in every partial scan that still clears the gate.
  const composite = coverage.testsTested > 0
    ? round1(
      dimWeights.reduce((s, w) => s + w.mean * w.n, 0) / coverage.testsTested,
    )
    : 0;
  const referenceGrade = gradeLetter(composite);

  // THE REFUSAL IS PART OF THE RESULT, NOT ONLY PART OF THE PROSE.
  //
  // `deriveCoverage` has always returned `graded`, and this function ignored it:
  // the markdown re-derived the same ratio and printed "PARTIAL — no grade
  // issued", while the object returned here still carried a letter. Anything
  // reading the object rather than the prose — a CLI, an SDK, the API poll —
  // got a grade for a scan the product had refused to grade.
  //
  // `cov === null` is withheld too. Coverage that could not be established is
  // not coverage that passed, and treating an unreadable denominator as a clear
  // one is the same failure this battery grades other agents on.
  const withheld = !cov?.graded;
  const grade = withheld ? null : referenceGrade;
  const gradedComposite = withheld ? null : composite;

  const report_md = buildReportMd({
    scanId: opts.scanId,
    agent,
    mode,
    tier: opts.tier,
    scores,
    // The REFERENCE values, deliberately. The renderer re-derives the same ratio
    // and prints its PARTIAL section from these; handing it nulls would change
    // the bytes of every withheld report for no gain.
    composite,
    grade: referenceGrade,
    turnaround: opts.turnaround,
    judgeMode: deps.judge.mode,
    coverage,
  }, deps.report ?? {});

  return {
    scores,
    composite: gradedComposite,
    grade,
    grade_withheld: withheld ? "insufficient_coverage" : null,
    composite_reference: withheld ? composite : null,
    report_md,
    coverage,
  };
}

/* -------------------------------------------------------------------------- */
/* Orchestration                                                              */
/* -------------------------------------------------------------------------- */
