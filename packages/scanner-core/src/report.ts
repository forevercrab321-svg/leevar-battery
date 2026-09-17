// report_md generator — renders the graded battery as a Markdown diagnostic
// report, styled to match the S4 Sample Report: meta block, composite grade +
// verdict, six per-dimension score bars with the caught failure mode, the
// 18 test results, and the Top-3 prescriptions (lowest dimensions first).

import { BATTERY, BATTERY_ID, batteryLabel, type DimensionSpec, testCount } from "./battery.ts";
import {
  deriveCoverage,
  evidenced,
  GRADED_MIN_RATIO,
  type ScoredDimension,
} from "./coverage.ts";
import { gradeLetter, round1, verdictLine } from "./grade.ts";
import type { AgentMeta, DimensionScores, TestVerdict } from "./types.ts";

const RESULT_MARK: Record<string, string> = {
  pass: "PASS",
  partial: "PARTIAL",
  fail: "FAIL",
};

/** 10-cell text bar, e.g. score 76 → `███████░░░`. */
function bar(score: number): string {
  const filled = Math.round((score / 100) * 10);
  return "█".repeat(filled) + "░".repeat(10 - filled);
}

export interface Prescription {
  n: string;
  title: string;
  fixes: string; // dimension id
  est: string;
  delta: string;
}


/**
 * The two things in this renderer that are LEEVAR's rather than the battery's.
 *
 * They were string literals — a title and a re-open URL — and a literal is a
 * fine thing to be until the file has to render for someone else. The defaults
 * below are deliberately unbranded so the public build produces an honest
 * report with nobody's name on it; LEEVAR passes its own.
 */
export interface ReportBranding {
  /** H1 of the report. */
  title: string;
  /** Where a reader can re-open this report, or null when there is nowhere. */
  reopenUrl?: (scanId: string) => string | null;
  /**
   * One sentence appended to the method footer.
   *
   * For an operator who hosts the scan and therefore has something to say about
   * retention. The public default says nothing: a local BYOK run stores nothing
   * anywhere this code can see, and a promise to purge it would be made on
   * behalf of an operator that does not exist.
   */
  footerNote?: string;
}

export const DEFAULT_BRANDING: ReportBranding = {
  title: "Agent Reliability — Diagnostic Report",
  reopenUrl: () => null,
};

/**
 * Prescriptions rank the weakest dimensions and estimate the work to lift them.
 * That ranking, its effort model and its projected deltas are LEEVAR's paid
 * planning layer, so the renderer takes them rather than computing them: the
 * public build simply has none, and prints no prescription section.
 */
export interface ReportRenderOpts {
  branding?: ReportBranding;
  prescriptions?: (scores: DimensionScores) => Prescription[];
}


export interface ReportInput {
  scanId: string;
  agent: AgentMeta;
  mode: string;
  tier: string;
  scores: DimensionScores;
  composite: number;
  grade: string;
  turnaround?: string;
  /** Which judge produced the scores (for the provenance footer). */
  judgeMode?: string;
  /** How many of the 6 dimensions had usable evidence. */
  coverage?: { tested: number; total: number; testsTested?: number; testsTotal?: number; testsOurFault?: number };
}

export function buildReportMd(input: ReportInput, opts: ReportRenderOpts = {}): string {
  const branding = opts.branding ?? DEFAULT_BRANDING;
  const { agent, scores, composite, grade } = input;
  const L: string[] = [];

  L.push(`# ${branding.title}`);
  L.push("");
  L.push(`**Agent:** ${agent.name}`);
  L.push("");
  // The whole line, or none of it. `?? "(not hosted)"` printed a sentence that
  // invited the reader to re-open a report at nowhere and to enter an email
  // nobody would receive — a broken instruction rather than a missing one. An
  // open build hosts nothing, so it says nothing.
  const reopen = branding.reopenUrl?.(input.scanId);
  if (reopen) {
    L.push(`_Re-open this report anytime at ${reopen} — enter the email you used._`);
    L.push("");
  }
  L.push(`| | |`);
  L.push(`|---|---|`);
  L.push(`| SCAN | ${input.scanId} |`);
  L.push(`| MODEL | ${agent.model || "—"} |`);
  L.push(`| TYPE | ${agent.type || "—"} |`);
  L.push(`| BATTERY | ${batteryLabel()} |`);
  L.push(`| MODE | ${input.mode} |`);
  L.push(`| TIER | ${input.tier} |`);
  if (input.turnaround) L.push(`| TURNAROUND | ${input.turnaround} |`);
  L.push("");
  // HEADLINE, AND WHY IT IS GATED ON COVERAGE
  //
  // The honesty gate was correct in the data and thrown away in the headline.
  // Measured 2026-08-02: a two-sentence FAQ bot with ONE of eighteen tests
  // evidenced was published as "A (90/100) · production-ready · deploy with
  // monitoring". The NOT TESTED lines were all there, further down, under a
  // grade nobody reads past. A customer screenshots the A; CI reads the 90.
  //
  // A previous version of this comment claimed "the agent gate already had this
  // right". IT DID NOT, and saying so here sent the next reader looking in the
  // wrong direction for a year. `evaluateGate` was counting DIMENSIONS: one
  // surviving probe of three marked a dimension tested, so the gate published
  // {"passed":true,"grade":"A","could_not_verify":[]} on the very scan this
  // headline was refusing to grade (an 11-of-18 scan,
  // 2026-08-13). Both now count with `deriveCoverage` and compare against
  // `GRADED_MIN_RATIO`, from coverage.ts — one function, one constant, no second
  // expression left to drift. COVERAGE IS DERIVED, NEVER ASSUMED.
  //
  // This gate used to read `input.coverage` and quietly do nothing when it was
  // absent: `tn` became 0, `tooThin` became false, and a report with NO coverage
  // information printed a confident letter. A gate that fails OPEN.
  //
  // What that cost, measured 2026-08-05 against the live table: 21 of 27
  // delivered scans are stored with a `## Composite grade: X` headline and no
  // coverage object at all. The worst case on record is 18 test verdicts, 17 of
  // them `evidence: "absent"`, so ONE probe of eighteen — and its stored report
  // reads `## Composite grade: A (90/100)`. We published an article about that
  // exact scan as an example of the failure, and never fixed the artifact the
  // customer actually reads.
  //
  // `scores` already carries every verdict, so the count is computable right
  // here. A caller-supplied coverage still wins, because it knows about our own
  // judge faults and this does not. A missing one is now MEASURED.
  const derived = deriveCoverage(
    (input.scores ?? null) as Record<string, ScoredDimension> | null,
  );

  const cov = input.coverage ??
    (derived && derived.tests_total + derived.tests_our_fault > 0
      ? {
        tested: derived.dimensions_tested,
        total: derived.dimensions_total,
        testsTested: derived.tests_evidenced,
        testsTotal: derived.tests_total,
        testsOurFault: derived.tests_our_fault,
      }
      : undefined);
  const tt = cov?.testsTested ?? derived?.tests_evidenced ?? 0;
  const tn = cov?.testsTotal ?? derived?.tests_total ?? 0;
  // Two thirds of the battery is the line: below it, an average over what
  // survived is a sample too thin to carry a letter, however high it lands.
  // The constant lives in coverage.ts as `GRADED_MIN_RATIO` because the agent
  // gate has to apply the identical line, and an identical-LOOKING copy of
  // `tt / tn < 0.67` is not the identical line — that is precisely how the gate
  // and this headline ended up publishing opposite verdicts on one scan.
  //
  // `tn === 0` means we could not establish coverage AT ALL — no caller object
  // and no verdicts to count. The original condition read `tn > 0 && ...`, so
  // that case fell through to a confident headline: unknown coverage was treated
  // as good coverage. That is the same shape as a failed read returning an empty
  // array and being read as "nothing to report". Unknown is now withheld.
  const unknownCoverage = tn === 0;
  const tooThin = unknownCoverage || tt / tn < GRADED_MIN_RATIO;
  // If we dropped probes ourselves, say so in the report rather than letting a
  // smaller denominator quietly flatter the ratio.
  const ourFault = cov?.testsOurFault ?? derived?.tests_our_fault ?? 0;
  const faultNote = ourFault > 0
    ? ` (${ourFault} further test${ourFault === 1 ? "" : "s"} went ungraded because OUR judge failed, not your samples — excluded from this ratio, and we owe you those.)`
    : "";

  if (unknownCoverage) {
    // Distinct from "too thin": there we know the sample was small. Here we do
    // not know anything, and saying "0/0 tests evidenced" would read as a
    // measurement rather than the absence of one.
    L.push(`## NO GRADE — coverage could not be established`);
    L.push("");
    L.push(
      `> **We are not grading this agent, and the reason is on our side.** This report was produced ` +
        `without a record of how many probes actually found evidence, so there is no denominator to ` +
        `put a letter over. A grade computed on an unknown sample is not a cautious grade, it is a ` +
        `made-up one. Re-run the scan and we will publish the coverage with the result.`,
    );
    L.push("");
    L.push(`> _For reference only, over whatever was scored: ${round1(composite)}/100. Do not deploy on this number._`);
  } else if (tooThin) {
    L.push(`## PARTIAL — ${tt}/${tn} tests evidenced, no grade issued`);
    L.push("");
    L.push(
      `> **We are not grading this agent.** Only ${tt} of ${tn} probes found evidence in your samples, ` +
        `and an average over ${tt} test${tt === 1 ? "" : "s"} is not a reliability grade — it is a coin toss with a letter on it.${faultNote} ` +
        `The dimensions we could measure are below, scored honestly; the rest say NOT TESTED because they were not tested. ` +
        `Send samples that exercise the missing behaviours, or run a live scan, and we will grade the whole battery.`,
    );
    L.push("");
    L.push(`> _For reference only, over the ${tt} evidenced test${tt === 1 ? "" : "s"}: ${round1(composite)}/100. Do not deploy on this number._`);
  } else {
    L.push(`## Composite grade: ${grade} (${round1(composite)}/100)`);
    if (cov) {
      L.push("");
      // "full battery" requires that we actually ran the full battery. Excluding
      // our own failures from the denominator is right for the RATIO and wrong
      // for this claim: a scan where two probes died on our side reached
      // 16/16 = 100% and printed "full battery" for a battery that never ran.
      // Caught by pipeline_test 2026-08-02, in the fix for the same class of
      // lie it was written to prevent — a smaller denominator is still a
      // smaller measurement.
      const full = cov.tested >= cov.total && tt >= tn && ourFault === 0;
      L.push(
        full
          ? `> Coverage: ${cov.tested}/${cov.total} dimensions · ${tt}/${tn} tests — full battery.`
          : ourFault > 0 && tt >= tn
          ? `> **Coverage: ${tt}/${tn} tests of the ${tn + ourFault} in the battery.**${faultNote} Everything your samples evidenced was graded — the shortfall is ours, not yours.`
          : `> **Coverage: ${cov.tested}/${cov.total} dimensions · ${tt}/${tn} tests.**${faultNote} The composite reflects ONLY what your samples evidenced — the rest are marked "not tested" below, not scored 0. Send more representative samples (or a live endpoint) to grade the full battery.`,
      );
    }
    L.push("");
    L.push(`> ${verdictLine(composite)}`);
  }
  L.push("");

  // TOP RISK — only among dimensions we actually tested.
  const testedDims = BATTERY.filter((d) => scores[d.key]?.tested);
  if (testedDims.length > 0) {
    const worst = testedDims.reduce((acc, d) =>
      (scores[d.key]?.score ?? 0) < (scores[acc.key]?.score ?? 0) ? d : acc
    );
    L.push(`**Top risk:** ${worst.id} ${worst.name} — ${worst.tag}.`);
    L.push("");
  }

  L.push(`## Dimension breakdown`);
  L.push("");
  for (const d of BATTERY) {
    const ds = scores[d.key];
    if (!ds?.tested) {
      L.push(`### ${d.id} · ${d.name} — NOT TESTED`);
      L.push("");
      L.push(
        `_Insufficient evidence in the supplied samples to grade this dimension — excluded from the composite (not scored 0)._`,
      );
      L.push("");
      continue;
    }
    const score = ds.score;
    L.push(
      `### ${d.id} · ${d.name} — ${round1(score)} ${gradeLetter(score)}`,
    );
    L.push("");
    L.push("```");
    L.push(`${bar(score)}  ${round1(score)}/100`);
    L.push("```");
    for (const t of ds.tests) {
      const skipped = evidenced(t) ? "" : " · _(no evidence — excluded)_";
      L.push(`- **${RESULT_MARK[t.result] ?? t.result}** · \`${t.name}\`${skipped} — ${t.detail}`);
    }
    L.push("");
  }

  // Heading and body together. Ranking the weakest dimensions, costing the work
  // and projecting a delta is the paid planning layer, so an open build has no
  // prescriptions — and an empty "## Top-3 prescriptions" heading advertises a
  // section that was removed, which is worse than not having it.
  const rx = opts.prescriptions ? opts.prescriptions(scores) : [];
  if (rx.length > 0) {
    L.push(`## Top-3 prescriptions`);
    L.push("");
    for (const p of rx) {
      L.push(`- **${p.n} · ${p.title}** — fixes ${p.fixes} · est ${p.est} · projected ${p.delta}`);
    }
    L.push("");
  }
  L.push(`---`);
  // NO VERSION IS ASSERTED, because none is known here.
  //
  // This mapped a provider id to a hardcoded version string — "deepseek" to
  // "DeepSeek-V3", "real" to "Claude Opus 4.8". Two things were wrong with it.
  // Under BYOK the caller chooses the model, so any fixed version is a guess
  // about someone else's configuration. And it was already wrong for LEEVAR:
  // the private judge runs `deepseek-v4-flash` while the report said
  // "DeepSeek-V3". A report whose method section names the wrong examiner is
  // the failure this battery grades other agents on.
  //
  // The provider id is what is actually known, so that is what is printed.
  //
  // `judgeMode` is OPTIONAL on ReportInput, and the first version of this read
  // it straight through — so omitting it printed "graded by undefined", and an
  // empty or whitespace mode printed "graded by  " with nothing between. The
  // ternary this replaced had a fallback; dropping the version mapping dropped
  // the fallback with it. All three states are asserted below the fold now.
  const mode = (input.judgeMode ?? "").trim();
  const judgeLabel = mode === ""
    ? "an LLM examiner"
    : mode === "mock"
    ? "a deterministic mock judge"
    : mode;
  L.push(
    `_Battery ${BATTERY_ID} (${testCount()} tests) · graded by ${judgeLabel} at temperature 0 · scores reflect the examiner's read of the evidence you supplied.${
      // NO RETENTION PROMISE BY DEFAULT.
      //
      // This line used to end "Access data (transcripts/endpoints) is purged 30
      // days after the scan." That is a statement about a hosted service. Run
      // under BYOK against Ollama the transcript never leaves the machine, and
      // there is nothing here that could purge anything — the sentence would be
      // a promise made on behalf of an operator this code has never met.
      //
      // An operator who does retain and purge can say so through `footerNote`.
      branding.footerNote ? ` ${branding.footerNote}` : ""
    }_`,
  );

  return L.join("\n");
}

export interface PrevScanSummary {
  id: string;
  composite: number | null;
  grade: string | null;
  scores: DimensionScores | null;
  completed_at: string | null;
}

/** "PROGRESS" section comparing this grading against the agent's previous
 * delivered scan — the before/after every treatment promises, and free proof of
 * improvement (or regression) for every repeat customer. Pure formatting. */
export function buildProgressMd(
  prev: PrevScanSummary,
  now: { composite: number; grade: string; scores: DimensionScores },
): string {
  const L: string[] = [];
  const d = (a: number, b: number) => {
    const v = Math.round((b - a) * 10) / 10;
    return v > 0 ? `+${v}` : `${v}`;
  };
  const prevComposite = typeof prev.composite === "number" ? prev.composite : null;
  L.push(`## PROGRESS — vs previous scan ${prev.id}${prev.completed_at ? ` (${String(prev.completed_at).slice(0, 10)})` : ""}`);
  L.push("");
  // A SCORE MOVE IS ONLY A RESULT IF THE SAME THINGS WERE MEASURED.
  //
  // This block used to print "**Improved by N points.**" on any positive delta.
  // Fed two real production rows — a rescan of the same input, byte-identical
  // `access.transcript` (same sha256), minutes apart, zero treatment in between —
  // it printed "Improved by 35.8 points. Composite 44.2 -> 80 · Grade D -> B".
  // Coverage had gone 14/18 -> 10/18. It measured LESS and reported BETTER, and
  // 13.3 of those points came from one dimension losing its last probe and
  // falling out of the mean entirely.
  const prevProbes = countEvidenced(prev.scores);
  const nowProbes = countEvidenced(now.scores) ?? 0;
  const coverageFell = prevProbes != null && nowProbes < prevProbes;

  if (prevComposite != null) {
    const delta = Math.round((now.composite - prevComposite) * 10) / 10;
    if (coverageFell && delta > 0) {
      // Not "improved". We cannot tell an improvement from a smaller exam.
      L.push(
        `**Not comparable — this run measured less.** Composite ${prevComposite} → ` +
          `**${now.composite}**, but evidenced probes fell ${prevProbes} → ${nowProbes}. ` +
          `A higher score over fewer probes is not an improvement; it is a shorter test. ` +
          `Re-run with samples that exercise the missing behaviours before reading this as progress.`,
      );
    } else {
      const line = delta > 0
        ? `**Improved by ${delta} points.**`
        : delta < 0
        ? `**Regressed by ${Math.abs(delta)} points** — see the dimensions below.`
        : `**Unchanged overall** — see per-dimension movement below.`;
      L.push(`${line} Composite ${prevComposite} → **${now.composite}** · Grade ${prev.grade ?? "?"} → **${now.grade}**`);
      if (prevProbes != null && nowProbes !== prevProbes) {
        L.push("");
        L.push(`> Evidenced probes: ${prevProbes} → ${nowProbes}.`);
      }
    }
    L.push("");
  }
  L.push(`| Dimension | Before | Now | Δ |`);
  L.push(`|---|---|---|---|`);
  for (const dim of BATTERY) {
    const p = prev.scores?.[dim.key];
    const n = now.scores[dim.key];
    const pTested = p && p.tested !== false;
    const nTested = n && n.tested !== false;
    const before = pTested ? `${p!.score}` : "not tested";
    const nowV = nTested ? `${n!.score}` : "not tested";
    const delta = pTested && nTested ? d(p!.score, n!.score) : "—";
    L.push(`| ${dim.name} | ${before} | ${nowV} | ${delta} |`);
  }
  L.push("");
  // This line used to be unconditional. "Apples to apples" is a claim about the
  // exam, not about the battery version — printing it under a run that graded
  // four fewer probes told the customer the comparison was sound when it was not.
  L.push(
    coverageFell || (prevProbes != null && nowProbes !== prevProbes)
      ? `*Same battery and same judge, but not the same exam: ${prevProbes} probes found evidence last time, ${nowProbes} this time. Per-dimension deltas below are only comparable where both runs had evidence.*`
      : `*Same battery, same judge, temperature 0, and the same ${nowProbes} probes found evidence both times — the comparison is apples to apples.*`,
  );
  return L.join("\n");
}

/**
 * Evidenced probes across every dimension.
 *
 * `null` when there are no scores at all — the previous scan is unknown, which
 * is not the same as "the previous scan measured nothing". Returning 0 there
 * would make the very first comparison print "0 probes found evidence last
 * time", inventing a regression out of a missing record.
 */
function countEvidenced(
  scores: DimensionScores | null | undefined,
): number | null {
  if (!scores) return null;
  return Object.values(scores).reduce(
    (n, d) => n + (d?.tests ?? []).filter(evidenced).length,
    0,
  );
}
