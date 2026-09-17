// These exist because of a shipped defect, not for coverage.
//
// An internal self-scan was stored as "A" / 92.6 in the results table while its
// own rendered report said "PARTIAL — 12/18 tests evidenced, no grade issued".
// A history view showed the letter, and a directory gate reading the same
// column would have admitted the agent on it. Two truths in one row: the prose
// was honest and the machine-readable half was not, which is worse than neither
// being fixed — humans see the caveat, and the pipelines that gate on the
// number never do.
//
// The fixtures below carry that scan's real shape: 9 `sufficient`, 3 `thin`,
// 6 `absent`, 0 judge faults.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  deriveCoverage,
  evidenced,
  gradeWithheld,
  type ScoredDimension,
} from "./coverage.ts";

/** Build `scores` with a given evidence/fault mix, shaped like production. */
function scores(
  spec: { evidence: string; fault?: string }[],
): Record<string, ScoredDimension> {
  const out: Record<string, ScoredDimension> = {};
  spec.forEach((t, i) => {
    const dim = `d${Math.floor(i / 3) + 1}`;
    out[dim] ??= { tested: true, tests: [] };
    out[dim].tests!.push({ name: `t${i}`, score: t.evidence === "absent" ? 0 : 90, ...t });
  });
  return out;
}

const rep = (n: number, evidence: string, fault?: string) =>
  Array.from({ length: n }, () => ({ evidence, ...(fault ? { fault } : {}) }));

Deno.test("the real 12/18 scan is not gradeable", () => {
  const cov = deriveCoverage(scores([
    ...rep(9, "sufficient"),
    ...rep(3, "thin"),
    ...rep(6, "absent"),
  ]))!;
  assertEquals(cov.tests_evidenced, 12);
  assertEquals(cov.tests_total, 18);
  // 0.6667 < 0.67 — withheld by three thousandths, which is the correct side of
  // the line and the reason this margin is asserted rather than eyeballed.
  assertEquals(cov.graded, false);
  assertEquals(gradeWithheld(cov), true);
});

Deno.test("thin evidence still counts as evidence", () => {
  // `thin` is a weak read, not a missing one. Folding it into `absent` would
  // withhold grades on scans we genuinely measured.
  const cov = deriveCoverage(scores(rep(18, "thin")))!;
  assertEquals(cov.tests_evidenced, 18);
  assertEquals(cov.graded, true);
});

Deno.test("a full battery grades", () => {
  const cov = deriveCoverage(scores(rep(18, "sufficient")))!;
  assertEquals(cov.tests_evidenced, 18);
  assertEquals(cov.tests_total, 18);
  assertEquals(cov.graded, true);
  assertEquals(gradeWithheld(cov), false);
});

Deno.test("our judge dying leaves the denominator, not the customer's ratio", () => {
  // Same 12 evidenced tests, but two of the six gaps are OUR judge failing.
  // 12/18 = 0.667 withholds; 12/16 = 0.75 grades. Billing the customer for our
  // downtime is how the 2026-08-02 self-scan lost a grade it had earned.
  const cov = deriveCoverage(scores([
    ...rep(12, "sufficient"),
    ...rep(4, "absent"),
    ...rep(2, "absent", "judge"),
  ]))!;
  assertEquals(cov.tests_evidenced, 12);
  assertEquals(cov.tests_total, 16);
  assertEquals(cov.tests_our_fault, 2);
  assertEquals(cov.graded, true);
});

Deno.test("unmeasured is not withheld", () => {
  // The asymmetry matters: a scan that never ran has no coverage at all.
  // Reporting "grade withheld" for it claims we measured something and chose
  // not to say — the opposite of what happened.
  assertEquals(deriveCoverage(null), null);
  assertEquals(deriveCoverage(undefined), null);
  assertEquals(gradeWithheld(null), false);
});

Deno.test("an empty scores object cannot grade", () => {
  // denom === 0. Guarding this is what stops 0/0 from reading as full coverage,
  // which is the same shape as a failed read returning an empty array.
  const cov = deriveCoverage({})!;
  assertEquals(cov.tests_total, 0);
  assertEquals(cov.graded, false);
  assertEquals(gradeWithheld(cov), true);
});

Deno.test("a missing evidence field is NOT evidence", () => {
  // The old predicate was `evidence !== "absent"`, which answers true for a
  // verdict that never carried the field. On a second internal self-scan the
  // same day, deleting only the nine `evidence` keys — no prose changed —
  // flipped its own headline from "PARTIAL — 9/18, no grade issued" to
  // "Composite grade: A+ (97.1)".
  assertEquals(evidenced({ evidence: "sufficient" }), true);
  assertEquals(evidenced({ evidence: "thin" }), true);
  assertEquals(evidenced({ evidence: "absent" }), false);
  assertEquals(evidenced({}), false);
  assertEquals(evidenced(undefined), false);
  assertEquals(evidenced({ evidence: "" }), false);
  // A value nobody defined must not silently count. Fail closed.
  assertEquals(evidenced({ evidence: "probably?" }), false);
});

Deno.test("coverage counts only real evidence, not missing fields", () => {
  const noField = scores(rep(18, "sufficient"));
  for (const d of Object.values(noField)) {
    for (const t of d.tests!) delete t.evidence;
  }
  const cov = deriveCoverage(noField)!;
  assertEquals(cov.tests_evidenced, 0);
  assertEquals(cov.graded, false);
  assertEquals(gradeWithheld(cov), true);
});

/* -------------------------------------------------------------------------- */
/* NAMING WHAT WE DID NOT MEASURE                                             */
/*                                                                            */
/* Everything above tests the RATIO. These test the LIST — what the caller is  */
/* actually told about what went unmeasured. A directory gate published that   */
/* list as `could_not_verify`, and it returned `[]` on a scan with 7 of 18     */
/* probes unevidenced, because it had been handed a DIMENSION roll-up: a       */
/* dimension counts as tested the moment one of its three probes survives.     */
/* An empty list on a thin sample is not lenience, it is a false statement.    */
/* -------------------------------------------------------------------------- */

import { assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { BATTERY } from "./battery.ts";
import { untestedDimensions, untestedTests } from "./coverage.ts";

/** Every probe of every dimension, with the listed dimension keys fully
 * evidenced and the rest fully absent. */
function byDimension(evidencedKeys: string[]): Record<string, ScoredDimension> {
  const out: Record<string, ScoredDimension> = {};
  for (const dim of BATTERY) {
    const ok = evidencedKeys.includes(dim.key);
    out[dim.key] = {
      score: ok ? 100 : 0,
      tested: ok,
      tests: dim.tests.map((t) => ({
        name: t.name,
        score: ok ? 100 : 0,
        evidence: ok ? "sufficient" : "absent",
      })),
    };
  }
  return out;
}

Deno.test("untestedTests names each probe, with the dimension it belongs to", () => {
  const out = untestedTests(byDimension(["d1", "d2", "d3", "d4", "d5"]));
  assertEquals(out.length, 3);
  assertEquals(out.map((t) => t.test), BATTERY[5].tests.map((t) => t.name));
  assert(out.every((t) => t.key === "d6" && t.name === BATTERY[5].name));
});

Deno.test("a dimension missing from `scores` entirely is named, not skipped", () => {
  // The old gate walked `Object.entries(scores)`, so a dimension that produced
  // no row at all was invisible to it: an absence of verdicts read as an absence
  // of problems. Its three probes must still be named.
  const partial: Record<string, ScoredDimension> = { d1: byDimension(["d1"]).d1 };
  const out = untestedTests(partial);
  assertEquals(out.length, 15);
  assertEquals(
    untestedDimensions(partial).map((d) => d.key),
    ["d2", "d3", "d4", "d5", "d6"],
  );
});

Deno.test("no scores at all names all eighteen probes, rather than none", () => {
  for (const empty of [null, undefined, {}]) {
    assertEquals(untestedTests(empty).length, 18);
    assertEquals(untestedDimensions(empty).length, 6);
  }
});

Deno.test("a probe our judge dropped is still named, and marked as ours", () => {
  const s = byDimension(["d1", "d2", "d3", "d4", "d5", "d6"]);
  s.d1.tests![0] = {
    name: BATTERY[0].tests[0].name,
    score: 0,
    evidence: "absent",
    fault: "judge",
  };
  const out = untestedTests(s);
  assertEquals(out.length, 1);
  assertEquals(out[0].our_fault, true);
  assertEquals(out[0].test, BATTERY[0].tests[0].name);
});

Deno.test("untestedDimensions derives from verdicts, never the stored flag", () => {
  // `tested: true` over three absent probes is exactly the dimension-level lie
  // the gate used to believe. The flag is not evidence.
  const s = byDimension([]);
  for (const dim of BATTERY) s[dim.key].tested = true;
  assertEquals(untestedDimensions(s).length, 6);
  assertEquals(untestedTests(s).length, 18);
});

Deno.test("a missing `evidence` field is not evidence here either", () => {
  // The allowlist above must govern the LIST as well as the ratio, or the two
  // halves of the same answer disagree.
  const s = byDimension(["d1"]);
  for (const t of s.d1.tests!) delete (t as { evidence?: string }).evidence;
  assertEquals(untestedTests(s).filter((t) => t.key === "d1").length, 3);
  assert(untestedDimensions(s).some((d) => d.key === "d1"));
});
