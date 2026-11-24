// The fix guide is a claim about every test in the battery. These tests hold it
// to that: one entry per test, no more and no fewer, and a report that prints
// fix guidance only where there is something to fix — and only testability
// advice where nothing was measured.

import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { BATTERY } from "./battery.ts";
import {
  FIX_GUIDE,
  FIX_SECTION_HEADING,
  MAKE_TESTABLE,
  renderFixDoc,
} from "./fix-guide.ts";
import { buildReportMd, type ReportInput } from "./report.ts";
import type { DimensionScores, TestVerdict } from "./types.ts";

const ALL_TESTS = BATTERY.flatMap((d) => d.tests.map((t) => t.name));

Deno.test("FIX_GUIDE has exactly one entry per battery test, and each is complete", () => {
  // Both directions: a battery test with no entry is a report that goes silent
  // on a failure; an entry with no test is guidance for a probe that never runs.
  assertEquals(Object.keys(FIX_GUIDE).sort(), [...ALL_TESTS].sort());
  assertEquals(Object.keys(MAKE_TESTABLE).sort(), [...ALL_TESTS].sort());
  for (const name of ALL_TESTS) {
    const g = FIX_GUIDE[name];
    assertEquals(
      g.test,
      name,
      `FIX_GUIDE["${name}"].test names a different test`,
    );
    for (const field of ["why", "promptCeiling", "verify"] as const) {
      assert(
        g[field].trim().length > 20,
        `${name}.${field} is empty or a stub`,
      );
    }
    assert(g.layers.length >= 2, `${name} offers fewer than two changes`);
    for (const l of g.layers) {
      assert(
        ["prompt", "architecture", "process"].includes(l.layer),
        `${name}: bad layer ${l.layer}`,
      );
      assert(
        ["low", "medium", "high"].includes(l.strength),
        `${name}: bad strength ${l.strength}`,
      );
      assert(
        l.action.trim().length > 20,
        `${name}: an action is empty or a stub`,
      );
    }
    assert(
      MAKE_TESTABLE[name].trim().length > 20,
      `${name}: testability hint is empty`,
    );
  }
});

// --- report fixtures --------------------------------------------------------

function verdict(
  name: string,
  result: TestVerdict["result"],
  evidence: TestVerdict["evidence"],
): TestVerdict {
  const score = result === "pass" ? 95 : result === "partial" ? 60 : 10;
  return { name, score, result, evidence, detail: "fixture" };
}

/** Every test PASS with evidence, except the overrides. */
function scoresWith(
  overrides: Record<string, [TestVerdict["result"], TestVerdict["evidence"]]> =
    {},
): DimensionScores {
  const s: DimensionScores = {};
  for (const d of BATTERY) {
    const tests = d.tests.map((t) => {
      const [r, e] = overrides[t.name] ?? ["pass", "sufficient"];
      return verdict(t.name, r, e);
    });
    const ev = tests.filter((t) => t.evidence !== "absent");
    s[d.key] = {
      score: ev.length ? ev.reduce((a, t) => a + t.score, 0) / ev.length : 0,
      tests,
      tested: ev.length > 0,
    };
  }
  return s;
}

function report(scores: DimensionScores): string {
  const input: ReportInput = {
    scanId: "fixture-scan",
    agent: {
      name: "Fixture Agent",
      model: "unspecified",
      type: "Support",
      description: "fixture",
    },
    mode: "transcript",
    tier: "fixture",
    scores,
    composite: 90,
    grade: "A",
  };
  return buildReportMd(input);
}

/** The fix section alone, from its heading to the next H2 or the footer rule. */
function section(md: string): string {
  const start = md.indexOf(FIX_SECTION_HEADING);
  if (start < 0) return "";
  const rest = md.slice(start + FIX_SECTION_HEADING.length);
  const end = rest.search(/^(## |---$)/m);
  return FIX_SECTION_HEADING + (end < 0 ? rest : rest.slice(0, end));
}

Deno.test("an all-PASS report has no fix section", () => {
  const md = report(scoresWith());
  assertEquals(FIX_SECTION_HEADING, "## How to fix what failed");
  assert(
    !md.includes(FIX_SECTION_HEADING),
    "a clean report printed a fix section",
  );
  assert(
    !md.includes("leevar.live"),
    "a clean report printed the re-test line",
  );
});

Deno.test("a FAIL prints that test's why, ordered layers, ceiling and verify", () => {
  const md = report(
    scoresWith({
      "capability-overclaim": ["fail", "sufficient"],
      "tone-drift": ["partial", "thin"],
    }),
  );
  const sec = section(md);
  assert(sec.length > 0, "a report with a FAIL printed no fix section");
  for (const name of ["capability-overclaim", "tone-drift"]) {
    const g = FIX_GUIDE[name];
    assert(sec.includes(g.why), `${name}: why missing`);
    assert(sec.includes(g.verify), `${name}: verify missing`);
    assert(
      sec.includes(g.promptCeiling),
      `${name}: prompt-only ceiling missing`,
    );
    // Strongest first: each action appears no later than any weaker one.
    const rank = { high: 0, medium: 1, low: 2 };
    const pos = g.layers.map((l) => ({
      r: rank[l.strength],
      at: sec.indexOf(l.action),
    }));
    assert(pos.every((p) => p.at >= 0), `${name}: an action is missing`);
    for (const a of pos) {
      for (const b of pos) {
        if (a.r < b.r) {
          assert(
            a.at < b.at,
            `${name}: a weaker change is listed before a stronger one`,
          );
        }
      }
    }
  }
  // A passing test gets nothing.
  assert(
    !sec.includes(FIX_GUIDE["citation-fabrication"].why),
    "a PASS got fix guidance",
  );
  // The single hosted line, with no price.
  assert(
    sec.trimEnd().endsWith(
      "Want a re-test that proves the fix, or someone to make the change? leevar.live",
    ),
    "the closing line is missing or not last",
  );
  assert(!/\$\s?\d/.test(sec), "the fix section quotes a price");
});

Deno.test("a NOT TESTED probe gets one testability line and no fix", () => {
  const md = report(scoresWith({ "grounded-qa": ["fail", "absent"] }));
  const sec = section(md);
  assert(sec.length > 0, "an unevidenced probe printed no section at all");
  const lines = sec.split("\n").filter((l) => l.includes("`grounded-qa`"));
  assertEquals(
    lines.length,
    1,
    `expected one line for grounded-qa, got:\n${lines.join("\n")}`,
  );
  assert(
    lines[0].includes(MAKE_TESTABLE["grounded-qa"]),
    "the testability hint is missing",
  );
  assert(
    /testable/i.test(lines[0]),
    "the line does not say how to make it testable",
  );
  assert(!/fix/i.test(lines[0]), `a NOT TESTED line offers a fix: ${lines[0]}`);
  const g = FIX_GUIDE["grounded-qa"];
  for (
    const text of [
      g.why,
      g.verify,
      g.promptCeiling,
      ...g.layers.map((l) => l.action),
    ]
  ) {
    assert(
      !sec.includes(text),
      "fix guidance was printed for a probe that was never measured",
    );
  }
  // The judge said "fail" with no evidence. That is not a failure, so no re-test pitch.
  assert(
    !sec.includes("leevar.live"),
    "an unmeasured probe was sold a re-test",
  );
});

Deno.test("docs/fixes/D1..D6 are exactly what the guide renders", async () => {
  for (const d of BATTERY) {
    const onDisk = await Deno.readTextFile(
      new URL(import.meta.resolve(`../../../docs/fixes/${d.id}.md`)),
    );
    assertEquals(
      onDisk,
      renderFixDoc(d.id),
      `docs/fixes/${d.id}.md is stale — run \`deno task fixes\``,
    );
  }
});
