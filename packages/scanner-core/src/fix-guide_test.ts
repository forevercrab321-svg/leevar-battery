// The fix guide is a claim about every test in the battery. These tests hold it
// to that: one entry per test, no more and no fewer, and a report that prints
// fix guidance only where there is something to fix — and only testability
// advice where nothing was measured.

import {
  assert,
  assertEquals,
} from "@std/assert";
import { BATTERY } from "./battery.ts";
import {
  FIX_GUIDE,
  FIX_SECTION_HEADING,
  MAKE_TESTABLE,
  renderFixDoc,
  TESTABLE_SECTION_HEADING,
  UNVERIFIED_SOURCE_HOWTO,
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
  for (const heading of [FIX_SECTION_HEADING, TESTABLE_SECTION_HEADING]) {
    const start = md.indexOf(heading);
    if (start < 0) continue;
    const rest = md.slice(start + heading.length);
    const end = rest.search(/^(## |---$)/m);
    return heading + (end < 0 ? rest : rest.slice(0, end));
  }
  return "";
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
  // Nothing failed, so the heading must not say something did.
  assert(sec.startsWith(TESTABLE_SECTION_HEADING), `wrong heading: ${sec.split("\n")[0]}`);
  assert(!md.includes(FIX_SECTION_HEADING), "a report with no failure is headed 'How to fix what failed'");
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

Deno.test("no instruction a local user cannot follow: no bare 'run it in live mode'", () => {
  // The CLI only runs transcript mode. Live mode exists through the library
  // (gradeBattery with access.mode = "live") and as a hosted scan, and every
  // instruction must say which, or it sends the reader nowhere.
  const md = report(scoresWith({
    "citation-fabrication": ["fail", "absent"],
    "tool-selection": ["fail", "absent"],
  }));
  const texts = [
    md,
    ...Object.values(MAKE_TESTABLE),
    ...Object.values(FIX_GUIDE).flatMap((g) => [g.why, g.verify, g.promptCeiling]),
    ...BATTERY.map((d) => renderFixDoc(d.id)),
  ];
  for (const t of texts) {
    for (const dead of [/run (it|this agent) in live mode/i, /run a live scan/i, /\(or a live endpoint\)/i]) {
      assert(!dead.test(t), `unfollowable instruction ${dead} in:\n${t.slice(0, 300)}`);
    }
  }
  assert(/gradeBattery/.test(UNVERIFIED_SOURCE_HOWTO) && /access\.mode/.test(UNVERIFIED_SOURCE_HOWTO),
    "the library route is not named precisely");
  assert(/hosted live scan/i.test(UNVERIFIED_SOURCE_HOWTO), "the hosted route is not named");
  const verified = BATTERY.flatMap((d) => d.tests).filter((t) => t.needsVerifiedSource).map((t) => t.name);
  for (const name of verified) {
    assert(MAKE_TESTABLE[name].includes(UNVERIFIED_SOURCE_HOWTO), `${name}: testability hint lacks the shared route`);
  }
});

Deno.test("the guide makes no claim this repository cannot back", () => {
  const all = Object.values(FIX_GUIDE).flatMap((g) => [g.why, g.verify, g.promptCeiling, ...g.layers.map((l) => l.action)])
    .join("\n") + BATTERY.map((d) => renderFixDoc(d.id)).join("\n");
  // Rankings across tests come from experience this repository does not publish.
  for (const claim of [/across the battery/i, /in the battery\./i, /of all eighteen/i, /work best/i]) {
    assert(!claim.test(all), `unbacked cross-test claim: ${claim}`);
  }
  // Schema-locking does not cover output cut off by the token limit.
  assert(/finish reason/i.test(FIX_GUIDE["format-contract-adherence"].promptCeiling), "format ceiling omits truncation");
  // tool-failure-injection must test both failure shapes, not only backoff.
  assert(/never succeeds/i.test(FIX_GUIDE["tool-failure-injection"].verify), "no never-succeeds script");
  // Every one of the four self-correction outcomes is judged.
  assert(/over-corrects \(fail/i.test(FIX_GUIDE["self-correction"].verify), "over-correction has no verdict");
  // An agent without tools leaves D4 NOT TESTED; the doc must say what to do with that.
  assert(/D4 stays NOT TESTED/.test(renderFixDoc("D4")), "D4 doc does not explain the no-tools case");
});
