// The committed example must stay true to the code beside it.
//
// A report checked into a repository is a claim about what the code does. The
// moment the two can drift, the file becomes marketing — and the one thing this
// repository sells is that its artefacts are derived rather than written.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { loadRecorded, referenceComposite, render } from "./render-example.ts";
import { deriveCoverage, gradeWithheld, type ScoredDimension } from "../packages/scanner-core/src/coverage.ts";
import { gradeLetter } from "../packages/scanner-core/src/grade.ts";

const rec = await loadRecorded();
const cov = deriveCoverage(rec.scores as Record<string, ScoredDimension>)!;

Deno.test("the committed report is exactly what this code renders", async () => {
  const onDisk = await Deno.readTextFile(
    new URL(import.meta.resolve("./SCN-2026-8637.report.md")),
  );
  // The committed file is the CLI's own output, which is `console.log`'s — so
  // it carries the trailing newline every text file should end with, and the
  // string the renderer returns does not. Asserted explicitly rather than
  // trimmed away: a comparison that trims is a comparison that would not notice
  // the renderer growing or losing a blank line at the end.
  assertEquals(render(rec) + "\n", onDisk);
});

Deno.test("the recorded scan is 12 of 18, and therefore ungraded", () => {
  assertEquals(cov.tests_evidenced, 12);
  assertEquals(cov.tests_total, 18);
  assertEquals(cov.tests_our_fault, 0);
  assertEquals(cov.graded, false);
  assertEquals(gradeWithheld(cov), true);
});

Deno.test("the withheld reference average is higher than a grade would need", () => {
  // The number is not the point; the refusal is. This asserts the awkward half:
  // the gate withheld a letter from a scan that would have scored an A on the
  // evidence it did have. A gate that only ever refuses low scores is a gate
  // nobody has tested.
  const ref = referenceComposite(rec.scores);
  assert(ref > 90, `reference composite was ${ref}`);
  assertEquals(gradeLetter(ref), "A");
  assertEquals(cov.graded, false);
});

Deno.test("no letter appears in the rendered report's headline", () => {
  const md = render(rec);
  const headline = md.split("\n").find((l) => l.startsWith("## "))!;
  assert(
    headline.startsWith("## PARTIAL — 12/18 tests evidenced, no grade issued"),
    headline,
  );
  assert(!md.includes("## Composite grade:"), "a composite grade was printed");
  assert(md.includes("Do not deploy on this number"));
});

Deno.test("the example carries no branding, no prescriptions, no retention promise", () => {
  // Rendered through the PUBLIC defaults, which is the whole reason this file
  // is here rather than a copy of the delivered artefact. The delivered one had
  // a product title, a re-open link into a hosted account, a Top-3
  // prescriptions section and a 30-day purge promise. None of them belongs to
  // the battery, and none of them survives into an open build.
  const md = render(rec);
  assert(md.startsWith("# Agent Reliability — Diagnostic Report"));
  assert(!md.includes("Re-open this report"), "a hosted re-open link leaked");
  assert(!md.includes("prescriptions"), "the paid planning section leaked");
  assert(!md.toLowerCase().includes("purged"), "a retention promise leaked");
  assert(!/LEEVAR|leevar\.live/.test(md.replace(/leevar-linkedin-specialist/g, "")));
});

Deno.test("the six unevidenced probes are marked excluded, one line each", () => {
  const md = render(rec);
  const excluded = md.match(/_\(no evidence — excluded from the score\)_/g) ?? [];
  assertEquals(excluded.length, 6);
  // 18 probe lines in total — the excluded ones are still PRINTED, named and
  // visible. Dropping them from the report would make a thin scan look like a
  // clean one, which is the whole failure this battery grades others on.
  assertEquals((md.match(/^- \*\*(PASS|PARTIAL|FAIL|NOT TESTED)\*\* · `/gm) ?? []).length, 18);
});

Deno.test("an excluded probe is NOT TESTED, never FAIL", () => {
  // The recording stores `result: "fail"` on all six unevidenced probes — that
  // is what the judge returned when it had nothing to grade. The committed
  // report used to print it: "**FAIL** · `grounded-qa` · _(no evidence —
  // excluded)_", a failure verdict on a test that never ran.
  const lines = render(rec).split("\n").filter((l) => l.startsWith("- **"));
  const excluded = lines.filter((l) => l.includes("no evidence"));
  assertEquals(excluded.length, 6);
  for (const l of excluded) assert(l.startsWith("- **NOT TESTED** · `"), l);
  // Control: the twelve evidenced probes keep the judge's own verdict.
  assertEquals(lines.filter((l) => l.startsWith("- **NOT TESTED**")).length, 6);
  assertEquals(lines.filter((l) => /^- \*\*(PASS|PARTIAL|FAIL)\*\*/.test(l)).length, 12);
});

Deno.test("a dimension with nothing left says NOT TESTED rather than scoring zero", () => {
  // NEGATIVE CONTROL. In this recording every dimension keeps at least one
  // probe, so the NOT TESTED branch is never reached by the data as it stands —
  // and a branch no test reaches is a branch nobody has checked. D3 is stripped
  // to nothing here on a copy, and the report must say so instead of printing
  // the 0 that the stored score would otherwise become.
  const stripped = structuredClone(rec);
  stripped.scores.d3.tested = false;
  for (const t of stripped.scores.d3.tests) t.evidence = "absent";
  const md = render(stripped);
  assert(/### D3 · Output Consistency — NOT TESTED/.test(md), "D3 was not marked NOT TESTED");
  assert(md.includes("excluded from the composite (not scored 0)"));
  // And it drops out of the ratio rather than out of the denominator.
  const cov2 = deriveCoverage(stripped.scores as Record<string, ScoredDimension>)!;
  assertEquals(cov2.tests_evidenced, 11);
  assertEquals(cov2.tests_total, 18);
  assertEquals(cov2.dimensions_tested, 5);
});

Deno.test("the stored row's contradiction is preserved, not quietly fixed", () => {
  // The artefact is worth keeping because it is wrong in a specific way: the
  // same object carries graded=false and grade="A". Losing that would lose the
  // evidence for why GradedResult nulls both fields.
  assertEquals(rec.stored_row.grade, "A");
  assert(rec.stored_row.composite !== null);
});

Deno.test("on the real recording, only the dimensions with all three probes evidenced wear a letter", () => {
  // D2 and D6 kept all three probes; D1 and D4 kept two, D3 and D5 one. The
  // report used to print "D5 · Context Window Management — 94 A" off a single
  // probe — the same thinness the headline refused to grade.
  const heads = render(rec).split("\n").filter((l) => l.startsWith("### D"));
  assertEquals(heads.length, 6);
  for (const id of ["D1", "D4"]) {
    assert(heads.some((h) => h.startsWith(`### ${id} `) && h.endsWith("on 2 of 3 probes · no letter")), heads.join("\n"));
  }
  for (const id of ["D3", "D5"]) {
    assert(heads.some((h) => h.startsWith(`### ${id} `) && h.endsWith("on 1 of 3 probes · no letter")), heads.join("\n"));
  }
  assert(heads.some((h) => h === "### D2 · Execution Reliability — 94.7 A"), heads.join("\n"));
  assert(heads.some((h) => h === "### D6 · Recovery & Error Handling — 94.3 A"), heads.join("\n"));
});
