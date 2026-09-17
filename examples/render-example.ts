#!/usr/bin/env -S deno run --allow-read
// Re-render one real recorded scan with the code in this repository.
//
//   deno task example
//
// The verdicts in `SCN-2026-8637.scores.json` were produced by a run that
// happened; nothing here re-grades them. What this does is take those eighteen
// verdicts, hand them to `deriveCoverage` and `buildReportMd` as they stand,
// and print the result — so the coverage rule can be checked against real data
// by anyone, with no key, no network and no trust in us.
//
// `SCN-2026-8637.report.md` is this script's output, committed. `example_test.ts`
// asserts the two still match, which is the only way a committed artefact stays
// honest about the code beside it.

import { buildReportMd } from "../packages/scanner-core/src/report.ts";
import {
  deriveCoverage,
  gradeWithheld,
  type ScoredDimension,
} from "../packages/scanner-core/src/coverage.ts";
import { gradeLetter } from "../packages/scanner-core/src/grade.ts";
import type { DimensionScores } from "../packages/scanner-core/src/types.ts";

export interface Recorded {
  scan_id: string;
  agent: { name: string; model: string; type: string; description: string };
  mode: string;
  tier: string;
  stored_row: { grade: string | null; composite: number | null };
  scores: DimensionScores;
}

export async function loadRecorded(url = import.meta.resolve("./SCN-2026-8637.scores.json")): Promise<Recorded> {
  return JSON.parse(await Deno.readTextFile(new URL(url)));
}

/**
 * The composite, weighted by evidenced probes — the same arithmetic
 * `gradeBattery` does, over verdicts that already exist.
 *
 * Weighted by probes and not by dimensions, for the reason written at length in
 * `grade-battery.ts`: a dimension carried by one surviving probe used to count
 * as much as one carried by three, so measuring LESS raised the score.
 */
export function referenceComposite(scores: DimensionScores): number {
  let sum = 0, n = 0;
  for (const dim of Object.values(scores)) {
    const scored = (dim.tests ?? []).filter(
      (t) => t.evidence === "sufficient" || t.evidence === "thin",
    );
    if (scored.length === 0) continue;
    sum += scored.reduce((s, v) => s + v.score, 0);
    n += scored.length;
  }
  return n === 0 ? 0 : Math.round((sum / n) * 10) / 10;
}

export function render(rec: Recorded): string {
  const cov = deriveCoverage(rec.scores as Record<string, ScoredDimension>)!;
  const composite = referenceComposite(rec.scores);
  return buildReportMd({
    scanId: rec.scan_id,
    agent: rec.agent,
    mode: rec.mode,
    tier: rec.tier,
    scores: rec.scores,
    // The REFERENCE values, as gradeBattery passes them: the renderer
    // re-derives coverage itself and decides from that whether a letter is
    // printed at all.
    composite,
    grade: gradeLetter(composite),
    judgeMode: "an LLM examiner",
    coverage: {
      tested: cov.dimensions_tested,
      total: cov.dimensions_total,
      testsTested: cov.tests_evidenced,
      testsTotal: cov.tests_total,
      testsOurFault: cov.tests_our_fault,
    },
  });
}

if (import.meta.main) {
  const rec = await loadRecorded();
  const cov = deriveCoverage(rec.scores as Record<string, ScoredDimension>)!;
  console.log(render(rec));
  console.error("");
  console.error(`coverage        ${cov.tests_evidenced}/${cov.tests_total} probes evidenced`);
  console.error(`graded          ${cov.graded}`);
  console.error(`gradeWithheld   ${gradeWithheld(cov)}`);
  console.error(`reference       ${referenceComposite(rec.scores)} — not a verdict`);
  console.error(
    `stored row said grade=${JSON.stringify(rec.stored_row.grade)} composite=${rec.stored_row.composite} ` +
      `— the contradiction this package exists to remove`,
  );
}
