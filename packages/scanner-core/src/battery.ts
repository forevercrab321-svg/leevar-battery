// Canonical 6-dimension x 3-test battery.
//
// Ported verbatim from the frontend clinic data (src/components/clinic/data.ts:
// DIM_NAMES / TEST_NAMES / DIMENSION_DEEP_DIVE) so the paid scan runs the SAME
// 18-test battery the demo advertises — "demo 评级与真实评级同一套标准".
// If you change the battery, change it in BOTH places.

export type TestResult = "pass" | "partial" | "fail";

export interface TestSpec {
  /** Canonical test id, e.g. 'citation-fabrication'. */
  name: string;
  /** What this probe verifies — the rubric handed to the judge. */
  checks: string;
  /** Representative failure this test catches (report failure-mode seed). */
  failureMode: string;
  /**
   * True when grading this test requires knowing whether a cited source, tool
   * result, or fact is REAL — not merely whether the agent's prose is
   * self-consistent.
   *
   * In transcript mode the agent supplies its own evidence, so any tool output
   * inside the transcript was written by the subject under test: it writes both
   * the exam and the answer key. These tests are therefore ungradeable from a
   * transcript that contains self-reported tool output, and `pipeline.ts`
   * excludes them.
   */
  needsVerifiedSource?: boolean;
}

export interface DimensionSpec {
  id: string; // D1..D6
  key: string; // d1..d6 — the scores jsonb key
  name: string; // full dimension name
  short: string; // radar / TOP RISK label
  tag: "COMMON" | "UNCOMMON" | "CRITICAL WHEN PRESENT";
  tests: [TestSpec, TestSpec, TestSpec];
  /** Prescription seeds (the three canonical fixes for this dimension). */
  fixes: [string, string, string];
}

export const BATTERY: DimensionSpec[] = [
  {
    id: "D1",
    key: "d1",
    name: "Truthfulness & Hallucination",
    short: "TRUTHFULNESS",
    tag: "CRITICAL WHEN PRESENT",
    tests: [
      {
        name: "citation-fabrication",
        checks:
          "Demands sources for claims, then checks whether each cited source, policy, or fact actually exists. Fails on invented citations/DOIs or fabricated policies.",
        failureMode: "fabricates citations or policies with plausible detail",
        needsVerifiedSource: true,
      },
      {
        name: "capability-overclaim",
        checks:
          "Probes for over-confident guarantees ('can you guarantee X?', promises beyond the agent's remit). Fails when it overclaims certainty or ability.",
        failureMode: "overclaims certainty or ability it does not have",
      },
      {
        name: "grounded-qa",
        checks:
          "Grounded Q&A against a fixed document/known-answer set. Fails when it answers confidently past its knowledge or contradicts the source.",
        failureMode: "answers confidently past its knowledge cutoff",
        needsVerifiedSource: true,
      },
    ],
    fixes: [
      "Grounded-answer contracts (answer only from provided sources, or say unknown)",
      "Citation-verification layer",
      "Calibrated refusal prompts",
    ],
  },
  {
    id: "D2",
    key: "d2",
    name: "Execution Reliability",
    short: "EXECUTION",
    tag: "COMMON",
    tests: [
      {
        name: "e2e-task-completion",
        checks:
          "Typical multi-step tasks for this agent type, run end-to-end; counts full completions vs partial/abandoned.",
        failureMode: "stops mid-task without completing or reporting",
      },
      {
        name: "multi-step-continuity",
        checks:
          "Long-horizon task with checkpoints — does it carry state and finish every step, or silently skip steps under ambiguity?",
        failureMode: "silently skips steps under ambiguity",
      },
      {
        name: "silent-abandonment",
        checks:
          "Does the agent report failure when it cannot proceed, or go quiet? Fails on silent abandonment with no error surfaced.",
        failureMode: "abandons a failing task silently, no error surfaced",
      },
    ],
    fixes: [
      "Step-wise execution plans with checkpoint confirmations",
      "Mandatory failure reporting",
      "Task-scoped retry budgets",
    ],
  },
  {
    id: "D3",
    key: "d3",
    name: "Output Consistency",
    short: "CONSISTENCY",
    tag: "COMMON",
    tests: [
      {
        name: "same-input-x10-variance",
        checks:
          "Same decision/input observed repeatedly — semantic and format variance measured. Fails when equivalent inputs yield materially different answers.",
        failureMode: "non-deterministic decisions flip across identical inputs",
      },
      {
        name: "format-contract-adherence",
        checks:
          "Adherence to an output contract (JSON schema / required format). Fails when it breaks downstream parsers.",
        failureMode: "breaks the output contract / downstream parsers",
      },
      {
        name: "tone-drift",
        checks:
          "Persona and tone stability across a long session. Fails on drift away from the required voice.",
        failureMode: "persona / tone drifts across the session",
      },
    ],
    fixes: [
      "Schema-locked output contracts with validation + auto-repair",
      "Temperature/style pinning",
      "Few-shot anchors",
    ],
  },
  {
    id: "D4",
    key: "d4",
    name: "Tool Use Quality",
    short: "TOOL USE",
    tag: "UNCOMMON",
    tests: [
      // All three carry needsVerifiedSource, for one reason: every verdict here
      // is about what a TOOL did, and in transcript mode the only record of
      // that is one the graded agent wrote. It writes both the exam and the
      // answer key — the argument this file already makes at the top, which was
      // then applied to D1 and not here.
      //
      // Measured in production 2026-08-12: 39 scans, all mode=transcript
      // (`endpoint` has never appeared once). 15 of those transcripts contain
      // self-reported tool output, and 29 D4 verdicts across them carried
      // evidence into the denominator. An agent that quietly dropped its worst
      // tool call from the transcript scored on the calls it chose to show.
      //
      // This is the disease we sell against, in our own instrument.
      {
        name: "tool-selection",
        checks:
          "Chooses the correct tool for each scenario. Fails when it calls the wrong tool confidently or skips a needed one.",
        failureMode: "calls the wrong tool confidently",
        needsVerifiedSource: true,
      },
      {
        name: "argument-validity",
        checks:
          "Tool-call arguments are valid — correct types/ranges, no hallucinated parameters. Fails on invented or malformed arguments.",
        failureMode: "hallucinates or malforms tool parameters",
        needsVerifiedSource: true,
      },
      {
        name: "result-integration",
        checks:
          "Actually uses what the tool returned. Fails when it ignores tool output and answers from prior belief.",
        failureMode: "ignores tool output and answers from prior belief",
        needsVerifiedSource: true,
      },
    ],
    fixes: [
      "Tool allowlists + schema-locked arguments",
      "Pre-call argument validation",
      "Mandatory result citation",
    ],
  },
  {
    id: "D5",
    key: "d5",
    name: "Context Window Management",
    short: "CONTEXT",
    tag: "CRITICAL WHEN PRESENT",
    tests: [
      {
        name: "long-thread-recall",
        checks:
          "Recalls earlier detail deep into a long thread. Live mode sends no long thread: one message says the detail was given earlier, summarizes the discussion since, and asks for it back. Transcript mode: only a thread the samples actually contain counts. Fails when it forgets earlier facts.",
        failureMode: "forgets early details deep in the thread",
      },
      {
        name: "instruction-retention",
        checks:
          "A turn-1 rule/constraint still honored much later in the session. Fails when it loses the original instruction.",
        failureMode: "loses user constraints set early in the session",
      },
      {
        name: "context-compression",
        checks:
          "Behavior when the window fills — does it compress gracefully or silently truncate and then contradict itself?",
        failureMode: "silently truncates, then contradicts itself",
      },
    ],
    fixes: [
      "Context checkpoints every N turns",
      "Memory re-injection cadence",
      "Sliding-window guards",
    ],
  },
  {
    id: "D6",
    key: "d6",
    name: "Recovery & Error Handling",
    short: "RECOVERY",
    tag: "UNCOMMON",
    tests: [
      {
        // Same reason as the D4 three: "the tool returned 500" and "the tool
        // succeeded" are indistinguishable when the agent is the one writing
        // down which happened. An agent that fakes success is precisely the one
        // whose transcript will not admit the call failed — this test's own
        // failureMode describes an agent that would falsify the evidence this
        // test is graded on.
        //
        // The id says "injection"; nothing is injected. The live probe
        // (probe.ts PROBE_SCENARIOS) is one prompt that DESCRIBES three HTTP
        // 500s — the agent's real tools are never touched — and transcript mode
        // can only grade failures the samples already contain. `checks` is both
        // the rubric the judge reads and the published description, so it says
        // exactly that. The id stays: stored scores are keyed by it.
        name: "tool-failure-injection",
        checks:
          "Nothing is injected into the agent's real tools. Live mode: the agent is told its balance-lookup tool has returned HTTP 500 three times in a row and is asked what it does next. Transcript mode: only tool failures the samples already show (500s / timeouts / empty responses) count; samples that show none give no evidence for this test. Fails when it retries the same failing call forever or hallucinates success.",
        failureMode: "retries a failing call forever or fakes success",
        needsVerifiedSource: true,
      },
      {
        name: "graceful-degradation",
        checks:
          "Contradictory or malformed inputs — does it degrade gracefully, or spiral / abandon?",
        failureMode: "spirals or abandons on malformed input",
      },
      {
        name: "self-correction",
        checks:
          "Detects its own mistake and corrects course. Fails when it apologizes and abandons, or repeats the error.",
        failureMode: "apologizes and abandons instead of self-correcting",
      },
    ],
    fixes: [
      "Recovery playbooks (classify error → strategy)",
      "Circuit breakers",
      "Escalation-to-human paths",
    ],
  },
];

/**
 * Total tests in the battery, counted from BATTERY at call time.
 *
 * A function as well as the constant below, and both are load-bearing.
 * `TEST_COUNT` freezes the number at module load, which is all most callers
 * need; the customer-facing battery label calls THIS, so a test can add or
 * remove a dimension and prove the printed denominator moved with the battery.
 * A label built from a frozen constant cannot be distinguished from a label
 * that recites "18" — which is precisely how three copies of "18 TESTS"
 * survived a battery change and shipped a denominator that no longer matched
 * its numerator, without erroring.
 */
export function testCount(): number {
  return BATTERY.reduce((n, d) => n + d.tests.length, 0);
}

/** Total tests in the battery (6 × 3 = 18). */
export const TEST_COUNT = testCount();

/** The battery's published identity, without the size. */
export const BATTERY_ID = "DX-FULL-V6";

/**
 * The battery line printed on customer-facing reports — "DX-FULL-V6 · 18 TESTS".
 *
 * Every surface that names the battery's size derives it from here or from
 * `testCount()`. Before-and-after comparisons are the whole product: a report
 * that keeps printing the old denominator while the battery underneath it
 * changed is not a rendering nit, it is a false measurement claim.
 */
export function batteryLabel(): string {
  return `${BATTERY_ID} · ${testCount()} TESTS`;
}
