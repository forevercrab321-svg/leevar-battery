// What an open build's report must NOT contain.
//
// The renderer was split out of a file that held a live Stripe payment link,
// two upsell boxes and a prescription ranking. Splitting it left two things
// behind that were worse than either keeping or removing them cleanly: a
// re-open line that said `(not hosted)` and invited the reader to enter an
// email nobody would receive, and an empty `## Top-3 prescriptions` heading
// advertising a section that had been taken out.
//
// Both are broken instructions rather than missing ones, which is the failure
// mode this battery grades other agents on.

import { assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { gradeBattery } from "./grade-battery.ts";
import { BATTERY } from "./battery.ts";
import type { Judge } from "./judge-types.ts";
import type { JudgeContext } from "./prompts/types.ts";

const judge: Judge = {
  mode: "mock",
  calls: () => BATTERY.flatMap((d) => d.tests).length,
  // deno-lint-ignore require-await
  async score(ctx: JudgeContext) {
    return { name: ctx.test.name, score: 71, result: "partial" as const, evidence: "sufficient" as const, detail: "scripted" };
  },
};

const OPTS = {
  scanId: "PUBLIC-FIXTURE-0001",
  agent: { name: "PublicBot", model: "GPT-4/5-class", type: "Customer support", description: "public render fixture" },
  mode: "transcript" as const,
  tier: "scan",
  access: { mode: "transcript" as const, transcript: ["User: hi\nAgent: hi"] },
};

/** No branding, no prescriptions — exactly what an open build passes. */
async function publicReport(): Promise<string> {
  const r = await gradeBattery(OPTS, { judge });
  return r.report_md;
}

Deno.test("the public report contains no address, no URL, and no dead instruction", async () => {
  const md = await publicReport();

  // GENERIC, NOT A LIST OF OUR OWN STRINGS.
  //
  // The first version listed the literals — a payment host, an internal
  // address — and the second built them from fragments to get past the leak
  // gate. Both were wrong for the same reason: this file SHIPS in the
  // publishable package, so writing the address at all publishes it, and
  // splitting it into ordered fragments publishes it too while evading the
  // regex that was supposed to catch exactly that. Evasion is not redaction.
  //
  // These patterns name a SHAPE. They catch our address without containing it,
  // they catch a payment host we have not thought of, and they do not weaken if
  // a domain changes.
  const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
  const URL = /https?:\/\/\S+/;

  const email = EMAIL.exec(md);
  assert(!email, `the public report contains an email address: ${email?.[0]}`);

  // No URL of any kind. Stronger than a list of payment hosts and it needs no
  // list: an open build hosts nothing, links to nothing and sells nothing, so a
  // URL in its report is a defect whatever it points at.
  const url = URL.exec(md);
  assert(!url, `the public report contains a URL: ${url?.[0]}`);

  // Instructions with nowhere to go, and headings for sections that are absent.
  // These are generic English, not identifiers, so naming them costs nothing.
  for (const dead of ["Re-open", "not hosted", "Top-3 prescriptions"]) {
    assert(!md.includes(dead), `the public report contains "${dead}"`);
  }
});

Deno.test("branding, when supplied, does render — the absence above is the default, not a break", async () => {
  // The assertions above are satisfiable by a renderer that lost the ability to
  // show a re-open link at all. `example.invalid` is reserved by RFC 2606 and
  // resolves nowhere, so the fixture proves the path works without naming a
  // real host.
  const r = await gradeBattery(OPTS, {
    judge,
    report: { branding: { title: "Fixture Report", reopenUrl: (id) => `https://scans.example.invalid/r/${id}` } },
  });
  assert(r.report_md.includes("Fixture Report"), "the injected title did not render");
  assert(r.report_md.includes("scans.example.invalid"), "the injected re-open URL did not render");
  assert(r.report_md.includes("Re-open"), "the re-open line did not render when a URL was supplied");
});

Deno.test("the public report is still a report", async () => {
  // The assertions above are satisfiable by returning an empty string, so this
  // one exists to stop that: removing the commercial surface must not remove
  // the thing the surface was attached to.
  const md = await publicReport();
  assert(md.length > 500, `expected a real report, got ${md.length} bytes`);
  for (const required of ["Truthfulness", "Execution", "DIMENSION", "SCAN"]) {
    assert(md.toUpperCase().includes(required.toUpperCase()), `the public report lost "${required}"`);
  }
});

Deno.test("the public report promises nothing about retention or hosting", async () => {
  // The footer used to end, unconditionally: "Access data (transcripts/
  // endpoints) is purged 30 days after the scan." That is a statement about a
  // hosted service. Under BYOK against Ollama the transcript never leaves the
  // machine and nothing here could purge anything either way — the sentence was
  // a promise made on behalf of an operator this code has never met.
  const md = await publicReport();
  for (const claim of ["purged", "30 days", "we delete", "we retain", "retention policy", "our servers", "uploaded"]) {
    assert(
      !md.toLowerCase().includes(claim.toLowerCase()),
      `the public report claims "${claim}" — it hosts nothing and cannot promise it`,
    );
  }
});

Deno.test("an operator that does host can say so, and it renders", async () => {
  // The absence above must be a DEFAULT, not a lost capability.
  const note = "Access data is purged 30 days after the scan.";
  const r = await gradeBattery(OPTS, {
    judge,
    report: { branding: { title: "Fixture Report", footerNote: note } },
  });
  assert(r.report_md.includes(note), "an injected footerNote did not render");
  assert(/temperature 0[^_]*Access data/.test(r.report_md),
    "the note did not land in the method footer where it belongs");
});

Deno.test("the method footer asserts no model version it cannot know", async () => {
  // It mapped a provider id to a fixed version — "deepseek" to "DeepSeek-V3",
  // "real" to "Claude Opus 4.8". Under BYOK the caller picks the model, so any
  // fixed version is a guess about someone else's configuration; and it was
  // already wrong for the hosted judge, which runs deepseek-v4-flash.
  for (const mode of ["deepseek", "moonshot", "real", "openai", "ollama"]) {
    const r = await gradeBattery(OPTS, { judge: { ...judge, mode } });
    // Judge versions only. "GPT-4" is excluded on purpose: the fixture agent
    // declares model "GPT-4/5-class", and that IS in the report legitimately —
    // it is the subject's own declaration, not a claim about the examiner. The
    // first version of this list caught it and was wrong to.
    for (const wrong of ["DeepSeek-V3", "Kimi K3", "Claude Opus 4.8"]) {
      assert(
        !r.report_md.includes(wrong),
        `judgeMode "${mode}" produced a report claiming the examiner was ${wrong}`,
      );
    }
    assert(r.report_md.includes(mode) || mode === "mock",
      `the report does not name the provider it actually used (${mode})`);
  }
});

Deno.test("the public report quotes no price", async () => {
  // A SHAPE, not a list of our price points. Listing them would put them in a
  // file that ships in the public package — the same mistake as writing an
  // address down in order to assert it is absent, which this branch has now
  // made in four different files. The leak gate covers the tier NAMES at source
  // level; this covers the rendered output, and it catches a price nobody here
  // has thought of.
  const md = await publicReport();
  const money = /\$\s?\d/.exec(md);
  assert(!money, `the public report quotes a price: ${money?.[0]}`);
  assert(!/\bupsell\b/i.test(md), "the public report contains an upsell");
});

// ---------------------------------------------------------------------------
// buildReportMd is the PUBLIC entry point. Every test above reaches it through
// gradeBattery, which always fills judgeMode in from judge.mode — so no test
// above can ever observe judgeMode missing, and none of them did. But the field
// is declared optional on ReportInput, so a self-hoster who renders a report
// from their own stored scores is not obliged to pass it, and got:
//
//     graded by undefined at temperature 0
//
// The renderer must not name an examiner it was never told about. These call
// buildReportMd DIRECTLY, without gradeBattery, which is the only way to reach
// the state a caller can actually reach.

import { buildReportMd, type ReportInput } from "./report.ts";

function inputWithout(judgeMode: string | undefined): ReportInput {
  const base: ReportInput = {
    scanId: "fixture-scan",
    agent: { name: "Fixture Agent", model: "unspecified", type: "Support", description: "fixture" },
    mode: "transcript",
    tier: "fixture",
    scores: {},
    composite: 71,
    grade: "C",
  };
  // Assigned, not spread, so that `undefined` means ABSENT rather than present-
  // and-undefined. Those are different objects and only one of them is what an
  // omitting caller produces.
  if (judgeMode !== undefined) base.judgeMode = judgeMode;
  return base;
}

function examinerIn(md: string): string {
  const m = /graded by (.*?) at temperature 0/.exec(md);
  assert(m, `the method footer is missing entirely:\n${md.slice(-300)}`);
  return m![1];
}

Deno.test("buildReportMd names no examiner when it was told of none", async (t) => {
  // "absent", "" and "   " are three different ways a caller reaches the same
  // state: nothing is known about who graded this. All three used to render
  // differently and all three were wrong — the first invented a judge called
  // `undefined`, the other two left a hole in the sentence.
  const cases: Array<[string, string | undefined]> = [
    ["absent", undefined],
    ["empty string", ""],
    ["whitespace only", "   "],
    ["a tab", "\t"],
  ];
  for (const [label, mode] of cases) {
    await t.step(label, () => {
      const examiner = examinerIn(buildReportMd(inputWithout(mode)));
      // The claim under test is not "it says this exact string" — it is that
      // the sentence names something, and names nothing false.
      for (const junk of ["undefined", "null", "NaN", "[object Object]"]) {
        assert(
          !examiner.includes(junk),
          `judgeMode ${label} rendered the examiner as "${examiner}" — that is a JS artifact, not a judge`,
        );
      }
      assert(examiner.trim().length > 0, `judgeMode ${label} left the examiner blank: "graded by ${examiner} at"`);
      assert(
        examiner === "an LLM examiner",
        `judgeMode ${label} should fall back to the honest generic name, got "${examiner}"`,
      );
    });
  }
});

Deno.test("buildReportMd still distinguishes the mock judge from a real one", () => {
  // The fallback must not swallow the one case where we DO know something: a
  // mock judge produces scores no LLM produced, and a report that called it
  // "an LLM examiner" would be claiming an examination that never happened.
  assert(
    examinerIn(buildReportMd(inputWithout("mock"))) === "a deterministic mock judge",
    "the mock judge lost its label",
  );
  // And a named provider is passed through as given — the id the caller
  // configured, never a model version this code guesses on their behalf.
  const examiner = examinerIn(buildReportMd(inputWithout("deepseek")));
  assert(examiner === "deepseek", `expected the provider id verbatim, got "${examiner}"`);
  assert(!/v\d|\d\.\d/i.test(examiner), `the footer invented a version: "${examiner}"`);
});
