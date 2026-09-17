// The CLI, exercised without spending anything.
//
// Every test here runs the real `main()` — argument parsing, the preflight, the
// battery, the renderer — with the mock judge or with no judge at all. Nothing
// in this file may make a network call, and `--allow-net` is deliberately not
// in the test task: if a code path here ever reached for a model, Deno would
// refuse it and the suite would red rather than quietly bill someone.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { main } from "./scan.ts";
import { makeJudge, ProviderError } from "../packages/providers/src/index.ts";
import { PROVIDERS } from "../packages/providers/src/providers.ts";
import { mockJudge } from "./mock-judge.ts";
import { gradeBattery } from "../packages/scanner-core/src/grade-battery.ts";
import { BATTERY, TEST_COUNT } from "../packages/scanner-core/src/battery.ts";

const SAMPLES = new URL(import.meta.resolve("../examples/transcript-support-bot.json"));

/** Run main() with stdout/stderr captured, so assertions read the output a
 * user would actually see rather than the return value alone. */
async function run(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [], err: string[] = [];
  const log = console.log, error = console.error;
  console.log = (...a: unknown[]) => void out.push(a.join(" "));
  console.error = (...a: unknown[]) => void err.push(a.join(" "));
  try {
    const code = await main(argv);
    return { code, out: out.join("\n"), err: err.join("\n") };
  } finally {
    console.log = log;
    console.error = error;
  }
}

Deno.test("no arguments prints usage and exits 2", async () => {
  const r = await run([]);
  assertEquals(r.code, 2);
  assert(r.out.includes("--transcript"));
});

Deno.test("a missing transcript is a usage error, not a crash", async () => {
  const r = await run(["--mock"]);
  assertEquals(r.code, 2);
  assert(r.err.includes("--transcript"));
});

Deno.test("no model at all is a usage error", async () => {
  const r = await run(["--transcript", SAMPLES.pathname]);
  assertEquals(r.code, 2);
  assert(r.err.includes("--provider") && r.err.includes("--mock"));
});

Deno.test("--mock and --provider together is refused rather than silently resolved", async () => {
  // Picking one for the user would mean either spending their money when they
  // asked for a mock, or printing mock numbers when they asked for a model.
  const r = await run(["--transcript", SAMPLES.pathname, "--mock", "--provider", "openai"]);
  assertEquals(r.code, 2);
});

Deno.test("--dry-run names the endpoint the transcript would go to, and sends nothing", async () => {
  const r = await run([
    "--transcript", SAMPLES.pathname,
    "--provider", "openai-compatible",
    "--base-url", "https://llm.example.invalid/v1/chat/completions",
    "--dry-run",
  ]);
  assertEquals(r.code, 0);
  assert(r.err.includes("https://llm.example.invalid/v1/chat/completions"));
  assert(r.err.includes("nothing was sent"));
  // The preflight runs before any key is resolved, so a reader can see where
  // their data would go before deciding to supply one.
  assert(r.err.includes("required (yours)"));
  assert(r.out === "", "dry-run wrote to stdout");
});

Deno.test("openai-compatible without a base URL fails, and says which flag", async () => {
  const r = await run([
    "--transcript", SAMPLES.pathname, "--provider", "openai-compatible", "--dry-run",
  ]);
  assertEquals(r.code, 1);
  assert(r.err.includes("baseUrl is required"));
});

Deno.test("a non-numeric --max-calls is rejected before anything runs", async () => {
  const r = await run([
    "--transcript", SAMPLES.pathname, "--mock", "--max-calls", "lots",
  ]);
  assertEquals(r.code, 2);
});

Deno.test("nothing-was-sent failures are not reported as network failures", () => {
  // THE FIRST ERROR A NEW USER SEES.
  //
  // A missing key, an unknown provider id and a missing baseUrl all reached
  // `codeForStatus(null)` — which is "network" — so the scanner answered a flag
  // the user had not typed with "could not reach the provider — check
  // connectivity, proxy and baseUrl". Nothing had been sent, so nothing had
  // failed to arrive. Each of the three is asserted, because the defect was one
  // cause with three faces and fixing one of them proves nothing about the
  // other two.
  const cases: [string, () => unknown][] = [
    ["no key", () => makeJudge({ provider: "openai", apiKey: "", readEnv: () => undefined })],
    ["unknown provider", () => makeJudge({ provider: "not-a-provider" })],
    ["no baseUrl", () => PROVIDERS["openai-compatible"]({})],
  ];
  for (const [label, fn] of cases) {
    let err: unknown;
    try { fn(); } catch (e) { err = e; }
    assert(err instanceof ProviderError, `${label}: expected a ProviderError`);
    assertEquals((err as ProviderError).code, "misconfigured", label);
    assert((err as ProviderError).fatal, `${label}: a retry cannot fix this`);
    assert(
      !(err as ProviderError).message.includes("connectivity"),
      `${label}: still blames the network — ${(err as ProviderError).message}`,
    );
  }
});

Deno.test("a missing key is reported as configuration, and never as a finding", async () => {
  // The failure this guards: an invalid key used to produce a low-coverage
  // report ABOUT THE AGENT, when what had failed was the caller's own setup.
  const r = await run([
    "--transcript", SAMPLES.pathname,
    "--provider", "openai",
    "--api-key", "",
  ]);
  assertEquals(r.code, 1);
  assert(r.err.includes("no API key"));
  assert(r.err.includes("never supplies a key of its own"));
  assert(r.err.includes("misconfigured"), r.err);
  assert(!r.err.includes("connectivity"), "a missing key was blamed on the network");
  assert(!r.out.includes("NOT TESTED"), "a config failure rendered a report");
});

Deno.test("a .json transcript that is not an array of strings is a usage error", async () => {
  // A committed fixture rather than a temp file: this suite runs with --allow-read
  // and nothing else, and it should stay that way. A test that needs write
  // permission to prove an input is rejected has widened the blast radius of
  // the test runner to prove a point about argument handling.
  const bad = new URL(import.meta.resolve("./fixtures/not-an-array.json"));
  const r = await run(["--transcript", bad.pathname, "--mock"]);
  assertEquals(r.code, 2);
  assert(r.err.includes("array of strings"));
});

Deno.test("the mock run ends PARTIAL, because the sample reports its own tool output", async () => {
  // THE WHOLE DEMO, ASSERTED.
  //
  // The shipped sample contains TOOL_RESULT lines the agent wrote itself, so
  // the six probes that need a verified source are refused before the judge is
  // reached. 12 of 18 is under the line, so no letter is issued — offline,
  // deterministically, for free.
  const r = await run([
    "--transcript", SAMPLES.pathname, "--mock", "--agent-name", "demo-support-bot",
  ]);
  assertEquals(r.code, 0);
  assert(r.out.includes("## PARTIAL — 12/18 tests evidenced, no grade issued"), r.out.slice(0, 400));
  assert(!r.out.includes("## Composite grade:"));
  assert(r.err.includes("No grade issued"));
  // Honest about the grader, too.
  assert(r.out.includes("a deterministic mock judge"));
});

Deno.test("--json carries the refusal in the machine result, not only in the prose", async () => {
  // A caller reading `.grade` off the object must not get a letter for a scan
  // the product refused to grade.
  const r = await run(["--transcript", SAMPLES.pathname, "--mock", "--json"]);
  assertEquals(r.code, 0);
  const j = JSON.parse(r.out);
  assertEquals(j.grade, null);
  assertEquals(j.composite, null);
  assertEquals(j.grade_withheld, "insufficient_coverage");
  assert(typeof j.composite_reference === "number");
  assertEquals(j.coverage.testsTested, 12);
  assertEquals(j.coverage.testsTotal, 18);
});

Deno.test("a withheld grade exits 0 — it is a result, not an error", async () => {
  // A non-zero exit here would teach every caller to retry until the gate gave
  // up, which is the opposite of what the gate is for.
  const r = await run(["--transcript", SAMPLES.pathname, "--mock"]);
  assertEquals(r.code, 0);
});

Deno.test("the mock judge is deterministic across runs and machines", async () => {
  const a = await run(["--transcript", SAMPLES.pathname, "--mock", "--json"]);
  const b = await run(["--transcript", SAMPLES.pathname, "--mock", "--json"]);
  assertEquals(JSON.parse(a.out).scores, JSON.parse(b.out).scores);
});

Deno.test("a transcript with no self-reported tool output grades the full battery", async () => {
  // The negative control for the test above. Without it, "12/18" could mean the
  // mock is simply incapable of evidencing 18, and the demo would be proving
  // nothing about the trust boundary at all.
  const result = await gradeBattery({
    scanId: "control", agent: { name: "a", model: "", type: "", description: "" },
    mode: "transcript", tier: "local",
    access: { mode: "transcript", transcript: ["USER: hello\nAGENT: hello, how can I help?"] },
  }, { judge: mockJudge() });
  assertEquals(result.coverage.testsTested, TEST_COUNT);
  assertEquals(result.grade_withheld, null);
  assert(result.grade !== null);
  assertEquals(result.coverage.tested, BATTERY.length);
});
