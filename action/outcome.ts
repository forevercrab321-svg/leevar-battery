// What a run produced, read the same way whether LEEVAR graded it or this
// runner did — and the job summary and the gate that come out of it.
//
// One rule runs through every function here, and it is the repository's rule:
// a probe with no evidence is NOT TESTED. Not a pass, not a zero, and never a
// number in a table. A letter exists only when the coverage line was cleared,
// and when it is unclear whether it was, there is no letter.

import {
  BATTERY,
  batteryLabel,
  TEST_COUNT,
} from "../packages/scanner-core/src/battery.ts";
import {
  type Coverage,
  deriveCoverage,
  evidenced,
  GRADED_MIN_RATIO,
  type ScoredDimension,
  untestedTests,
} from "../packages/scanner-core/src/coverage.ts";
import { gradeLetter, round1 } from "../packages/scanner-core/src/grade.ts";
import type { GradedResult } from "../packages/scanner-core/src/types.ts";

/**
 * - complete: a result came back — graded, or PARTIAL.
 * - failed:   LEEVAR ran the scan and reported that it failed.
 * - error:    no scan result: bad inputs, a refusal, an outage.
 * - timeout:  the scan did not finish before this step's deadline.
 */
export type RunStatus = "complete" | "failed" | "error" | "timeout";
export type Engine = "hosted" | "local" | "mock";

export interface Failure {
  reason?: string;
  fault?: string;
  retryable?: boolean;
  detail?: string;
}

export interface Outcome {
  status: RunStatus;
  engine: Engine;
  scanId: string | null;
  /** The letter, and only when one was issued. */
  grade: string | null;
  composite: number | null;
  /** The average over evidenced probes when no letter was issued. Not a verdict. */
  compositeReference: number | null;
  coverage: Coverage | null;
  scores: Record<string, ScoredDimension> | null;
  reportMd: string | null;
  /** What went wrong, in plain words, when status is not "complete". */
  message: string | null;
  failure?: Failure | null;
}

/** A setting the user got wrong. Always fails the step, whatever `fail-on` says. */
export class InputError extends Error {}

export function noResult(
  status: Exclude<RunStatus, "complete">,
  engine: Engine,
  scanId: string | null,
  message: string,
  failure: Failure | null = null,
): Outcome {
  return {
    status,
    engine,
    scanId,
    grade: null,
    composite: null,
    compositeReference: null,
    coverage: null,
    scores: null,
    reportMd: null,
    message,
    failure,
  };
}

const num = (
  v: unknown,
): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v)
    ? v as Record<string, unknown>
    : null;

/**
 * The `scores` object of a poll answer, or null when there is none. Throws on
 * one this file cannot read safely — a dimension or a verdict that is not an
 * object, or `tests` that is not a list — rather than let deriveCoverage or
 * the summary table throw halfway through.
 */
function readScores(v: unknown): Record<string, ScoredDimension> | null {
  if (v === null || v === undefined) return null;
  const scores = obj(v);
  if (!scores) throw new Error("scores is not an object");
  for (const dim of Object.values(scores)) {
    const d = obj(dim);
    if (!d) throw new Error("a dimension in scores is not an object");
    if (d.tests === undefined) continue;
    if (!Array.isArray(d.tests)) {
      throw new Error("a dimension's tests is not a list");
    }
    if (!d.tests.every((t) => obj(t) !== null)) {
      throw new Error("a verdict in tests is not an object");
    }
  }
  return scores as Record<string, ScoredDimension>;
}

/** Every probe of the battery came back with a verdict, our own failures included. */
const wholeBattery = (c: Coverage) =>
  c.tests_total + c.tests_our_fault === TEST_COUNT;

function serverCoverage(v: unknown): Coverage | null {
  const c = obj(v);
  if (!c || typeof c.graded !== "boolean") return null;
  const n = (k: string) => num(c[k]) ?? 0;
  return {
    dimensions_tested: n("dimensions_tested"),
    dimensions_total: n("dimensions_total"),
    tests_evidenced: n("tests_evidenced"),
    tests_total: n("tests_total"),
    tests_our_fault: n("tests_our_fault"),
    graded: c.graded,
  };
}

/**
 * A finished poll answer (`graded` or `delivered`).
 *
 * Coverage is re-derived from the verdicts with the code in this repository
 * whenever the verdicts are there, and the server's own coverage object is used
 * only when they are not. A letter survives only if that coverage covers the
 * whole battery, cleared the line, AND the server did not withhold it — closed
 * in every direction, because a stored row once carried `grade: "A"` beside
 * `graded: false`, and 15 of 15 clears the ratio while a whole dimension is
 * missing. Probes our own judge failed count toward the whole battery.
 *
 * Throws when `scores` has a shape this file cannot read; the caller turns
 * that into "no result", never into a guess.
 */
export function outcomeFromPoll(
  body: Record<string, unknown>,
  polledId: string | null = null,
): Outcome {
  const scores = readScores(body.scores);
  const coverage = deriveCoverage(scores) ?? serverCoverage(body.coverage);
  const letterAllowed = coverage !== null &&
    wholeBattery(coverage) &&
    coverage.graded &&
    !body.grade_withheld;
  const grade = letterAllowed && typeof body.grade === "string" && body.grade
    ? body.grade
    : null;
  return {
    status: "complete",
    engine: "hosted",
    // The id this step queued and polled is the one it reports; the body's echo
    // is only a fallback for callers that have no id of their own.
    scanId: polledId ??
      (typeof body.scan_id === "string" ? body.scan_id : null),
    grade,
    composite: grade ? num(body.composite) : null,
    compositeReference: grade
      ? null
      : num(body.composite_reference) ?? num(body.composite),
    coverage,
    scores,
    reportMd: typeof body.report_md === "string" ? body.report_md : null,
    message: null,
  };
}

/** A local run's result. `gradeBattery` already withholds; this only reshapes. */
export function outcomeFromLocal(
  r: GradedResult,
  scanId: string,
  engine: "local" | "mock",
): Outcome {
  const scores = r.scores as Record<string, ScoredDimension>;
  return {
    status: "complete",
    engine,
    scanId,
    grade: r.grade,
    composite: r.composite,
    compositeReference: r.composite_reference,
    coverage: deriveCoverage(scores),
    scores,
    reportMd: r.report_md,
    message: null,
  };
}

/** The `grade` output: the letter (ASCII), `PARTIAL` when none was issued, empty with no result. */
export function gradeOutput(o: Outcome): string {
  if (o.status !== "complete") return "";
  return o.grade ? o.grade.replace("−", "-") : "PARTIAL";
}

/** The `tested` output, e.g. `12/18`. Empty when coverage is unknown. */
export function testedOutput(o: Outcome): string {
  return o.status === "complete" && o.coverage
    ? `${o.coverage.tests_evidenced}/${o.coverage.tests_total}`
    : "";
}

/* -------------------------------------------------------------------------- */
/* fail-on                                                                    */
/* -------------------------------------------------------------------------- */

export type FailOn =
  | { kind: "never" }
  | { kind: "not-tested" }
  | { kind: "grade-below"; letter: string };

/** Worst to best, as `gradeLetter` hands them out (with ASCII minus). */
const SCALE = ["F", "D", "D+", "C", "C+", "B", "B+", "A-", "A", "A+"];
const ascii = (letter: string) => letter.trim().toUpperCase().replace("−", "-");

export function parseFailOn(raw: string): FailOn {
  const v = raw.trim();
  if (v === "" || v === "never") return { kind: "never" };
  if (v === "not-tested") return { kind: "not-tested" };
  const m = /^grade-below:(.*)$/.exec(v);
  if (m && SCALE.includes(ascii(m[1]))) {
    return { kind: "grade-below", letter: ascii(m[1]) };
  }
  throw new InputError(
    `fail-on: "${raw}" is not one of never, not-tested, grade-below:<letter>. ` +
      `Letters on this scale: ${[...SCALE].reverse().join(" ")}.`,
  );
}

/** How many probes produced no evidence, our own judge failures included. */
function notTestedCount(o: Outcome): number | null {
  if (o.scores) return untestedTests(o.scores).length;
  if (o.coverage) {
    return o.coverage.tests_total + o.coverage.tests_our_fault -
      o.coverage.tests_evidenced;
  }
  return null;
}

export function gate(
  o: Outcome,
  failOn: FailOn,
): { fail: boolean; reason: string | null } {
  if (o.status !== "complete") {
    return failOn.kind === "never"
      ? { fail: false, reason: null }
      : { fail: true, reason: `there is no result to gate on (${o.status})` };
  }
  if (failOn.kind === "never") return { fail: false, reason: null };
  if (failOn.kind === "not-tested") {
    const n = notTestedCount(o);
    if (n === null) {
      return { fail: true, reason: "coverage could not be established" };
    }
    if (n > 0) {
      return { fail: true, reason: `${n} of ${TEST_COUNT} probes NOT TESTED` };
    }
    // Every probe evidenced and still no letter: the gate covers every
    // PARTIAL, not only the ones a missing probe explains.
    if (!o.grade) {
      return { fail: true, reason: "no grade was issued (PARTIAL)" };
    }
    return { fail: false, reason: null };
  }
  if (!o.grade) {
    return {
      fail: true,
      reason:
        `no grade was issued (PARTIAL), so nothing clears grade-below:${failOn.letter}`,
    };
  }
  const have = SCALE.indexOf(ascii(o.grade));
  // An unknown letter cannot be shown to clear the line.
  if (have < 0 || have < SCALE.indexOf(failOn.letter)) {
    return { fail: true, reason: `grade ${o.grade} is below ${failOn.letter}` };
  }
  return { fail: false, reason: null };
}

/* -------------------------------------------------------------------------- */
/* the summary                                                                */
/* -------------------------------------------------------------------------- */

function headline(o: Outcome): string {
  if (o.status === "failed") {
    return "## LEEVAR Battery — the scan failed, no result";
  }
  if (o.status === "timeout") {
    return "## LEEVAR Battery — no result yet (timed out)";
  }
  if (o.status === "error") return "## LEEVAR Battery — no result";
  const c = o.coverage;
  if (!c || c.tests_total === 0) {
    return "## LEEVAR Battery — NO GRADE: coverage could not be established";
  }
  if (!o.grade) {
    return `## LEEVAR Battery — PARTIAL — ${c.tests_evidenced}/${c.tests_total} tests evidenced, no grade issued`;
  }
  const comp = o.composite !== null ? ` (${round1(o.composite)}/100)` : "";
  return `## LEEVAR Battery — ${o.grade}${comp} · ${c.tests_evidenced}/${c.tests_total} tests evidenced`;
}

function dimensionRows(scores: Record<string, ScoredDimension>): string[] {
  const rows = [
    "| Dimension | Probes with evidence | Result |",
    "|---|---|---|",
  ];
  for (const d of BATTERY) {
    const probes = scores[d.key]?.tests ?? [];
    const total = probes.length || d.tests.length;
    const ev = probes.filter(evidenced).length;
    let result: string;
    if (ev === 0) {
      result = "NOT TESTED";
    } else {
      // The report's rule, unchanged: a dimension's letter needs the same
      // evidence the composite does, which over three probes means all three.
      // A missing score is no reading — never a 0, and never the F under it.
      const score = num(scores[d.key]?.score);
      const letter = ev / probes.length >= GRADED_MIN_RATIO;
      result = score === null
        ? "no reading"
        : letter
        ? `${round1(score)} ${gradeLetter(score)}`
        : `${round1(score)} · no letter`;
    }
    rows.push(`| ${d.id} · ${d.name} | ${ev} of ${total} | ${result} |`);
  }
  return rows;
}

export interface SummaryContext {
  failOn?: FailOn;
  gate?: { fail: boolean; reason: string | null };
  /** Fold the full report in at the end. Default true. */
  includeReport?: boolean;
}

export function renderSummary(o: Outcome, ctx: SummaryContext = {}): string {
  const L: string[] = [headline(o), ""];
  const where = o.engine === "hosted"
    ? "hosted run"
    : o.engine === "mock"
    ? "local run, mock judge"
    : "local run";
  L.push(
    `${
      o.scanId ? `Scan \`${o.scanId}\` · ` : ""
    }${where} · battery ${batteryLabel()}`,
    "",
  );

  if (o.engine === "mock") {
    L.push(
      "> **Mock judge: no model was called and the transcript was not read.** Every number below is " +
        "a hash of the test's name, not a measurement. It shows the shape of a result and the coverage rule.",
      "",
    );
  }

  if (o.status !== "complete") {
    if (o.failure) {
      const f = o.failure;
      L.push(
        `LEEVAR reported: reason \`${f.reason ?? "unknown"}\`, fault: ${
          f.fault ?? "unknown"
        }, ` +
          `retryable: ${
            f.retryable === true
              ? "yes"
              : f.retryable === false
              ? "no"
              : "unknown"
          }.`,
      );
      if (f.detail) L.push("", String(f.detail));
      L.push("");
    }
    if (o.message) L.push(o.message, "");
  } else {
    const c = o.coverage;
    if (!c || c.tests_total === 0) {
      L.push(
        "> No record of how many probes found evidence came back, so there is no denominator to put a letter over. " +
          "This step does not issue one on an unknown sample.",
        "",
      );
    } else if (!o.grade) {
      const verdicts = c.tests_total + c.tests_our_fault;
      L.push(
        !wholeBattery(c)
          ? `> **No grade issued.** This result holds ${verdicts} probe verdicts where the battery has ${TEST_COUNT}, ` +
            `and a letter needs the whole battery. NOT TESTED below means not tested — not a pass, and not a zero.`
          : c.graded
          ? `> **No grade issued.** Coverage cleared the line (${c.tests_evidenced} of ${c.tests_total}), ` +
            `but LEEVAR returned no letter for this scan.`
          : `> **No grade issued.** Only ${c.tests_evidenced} of ${c.tests_total} probes found evidence in the transcript, ` +
            `and a letter needs more than two thirds. NOT TESTED below means not tested — not a pass, and not a zero.`,
      );
      if (o.compositeReference !== null) {
        L.push(
          ">",
          `> _For reference only, over the ${c.tests_evidenced} evidenced tests: ${
            round1(o.compositeReference)
          }/100. Do not deploy on this number._`,
        );
      }
      L.push("");
    }
    if (c && c.tests_our_fault > 0) {
      L.push(
        `${c.tests_our_fault} probe${
          c.tests_our_fault === 1 ? "" : "s"
        } went ungraded because LEEVAR's own judge failed. ` +
          "They are left out of the ratio above and listed below.",
        "",
      );
    }
    if (o.scores) {
      L.push(...dimensionRows(o.scores), "");
      const missing = untestedTests(o.scores);
      if (missing.length > 0) {
        const dimId = (key: string) =>
          BATTERY.find((d) => d.key === key)?.id ?? key;
        L.push(
          `**NOT TESTED — ${missing.length} of ${TEST_COUNT} probes**, left out of every number above:`,
          "",
        );
        for (const t of missing) {
          L.push(
            `- ${dimId(t.key)} · \`${t.test}\`` +
              (t.our_fault
                ? " — LEEVAR's own judge failed on this probe, not your transcript"
                : ""),
          );
        }
        L.push("");
      }
    }
  }

  if (ctx.failOn && ctx.failOn.kind !== "never" && ctx.gate) {
    const rule = ctx.failOn.kind === "grade-below"
      ? `grade-below:${ctx.failOn.letter}`
      : ctx.failOn.kind;
    L.push(
      ctx.gate.fail
        ? `**Gate \`fail-on: ${rule}\` failed:** ${ctx.gate.reason}.`
        : `Gate \`fail-on: ${rule}\` passed.`,
      "",
    );
  }

  if (o.reportMd && ctx.includeReport !== false) {
    L.push(
      "<details><summary>Full report</summary>",
      "",
      o.reportMd.trim(),
      "",
      "</details>",
      "",
    );
  }
  return L.join("\n");
}
