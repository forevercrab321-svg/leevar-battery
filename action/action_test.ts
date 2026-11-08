// The GitHub Action, exercised without spending anything.
//
// Nothing in this file reaches LEEVAR or a model. The hosted client is driven
// through a scripted `fetch` and a fake clock, so the backoff, the timeout and
// every refusal can be asserted in milliseconds; the local path runs the mock
// judge. The suite keeps the repository's rule: `--allow-read` and nothing
// else. Files the action would write live in a Map, not on disk.

import {
  assert,
  assertEquals,
  assertMatch,
  assertRejects,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  gate,
  gradeOutput,
  type Outcome,
  outcomeFromLocal,
  outcomeFromPoll,
  parseFailOn,
  renderSummary,
  testedOutput,
} from "./outcome.ts";
import {
  DEFAULT_API_URL,
  POLL_FIRST_MS,
  POLL_MAX_MS,
  runHosted,
} from "./hosted.ts";
import {
  type ActionIo,
  checkTranscript,
  MAX_TRANSCRIPT_BYTES,
  runAction,
} from "./main.ts";
import { gradeBattery } from "../packages/scanner-core/src/grade-battery.ts";
import { mockJudge } from "../cli/mock-judge.ts";
import { ProviderError } from "../packages/providers/src/index.ts";
import type { DimensionScores } from "../packages/scanner-core/src/types.ts";

const here = (p: string) => new URL(import.meta.resolve(p)).pathname;
const SAMPLES = here("../examples/transcript-support-bot.json");

/** A scan that happened: 12 of 18 probes evidenced, stored with grade "A". */
const REC = JSON.parse(
  await Deno.readTextFile(here("../examples/SCN-2026-8637.scores.json")),
);
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

/** The poll answer api-scan sends for that scan today: letter withheld. */
const WITHHELD = {
  scan_id: "SCN-2026-8637",
  status: "delivered",
  grade: null,
  composite: null,
  grade_withheld: "insufficient_coverage",
  composite_reference: 96.6,
  coverage: REC.stored_row.coverage,
  scores: REC.scores,
  report_md: "# Report\n\n## PARTIAL — 12/18 tests evidenced, no grade issued",
};

/** A full-coverage result: a transcript with no self-reported tool output. */
const FULL = await gradeBattery({
  scanId: "control",
  agent: { name: "a", model: "", type: "", description: "" },
  mode: "transcript",
  tier: "local",
  access: {
    mode: "transcript",
    transcript: ["USER: hello\nAGENT: hello, how can I help?"],
  },
}, { judge: mockJudge() });

function graded(letter: string, scores: DimensionScores = FULL.scores) {
  return {
    scan_id: "SCN-2026-0001",
    status: "delivered",
    grade: letter,
    composite: 80.1,
    coverage: {
      dimensions_tested: 6,
      dimensions_total: 6,
      tests_evidenced: 18,
      tests_total: 18,
      tests_our_fault: 0,
      graded: true,
    },
    scores,
    report_md: "# Report",
  };
}

/* ------------------------------------------------------------------------ */
/* fail-on                                                                  */
/* ------------------------------------------------------------------------ */

Deno.test("fail-on: the three documented forms parse; an empty value means never", () => {
  assertEquals(parseFailOn("never"), { kind: "never" });
  assertEquals(parseFailOn(""), { kind: "never" });
  assertEquals(parseFailOn(" not-tested "), { kind: "not-tested" });
  assertEquals(parseFailOn("grade-below:B"), {
    kind: "grade-below",
    letter: "B",
  });
  // The report prints A− with a real minus sign; a workflow file types A-.
  assertEquals(parseFailOn("grade-below:a-"), {
    kind: "grade-below",
    letter: "A-",
  });
  assertEquals(parseFailOn("grade-below:A−"), {
    kind: "grade-below",
    letter: "A-",
  });
});

Deno.test("fail-on: a letter the scale does not have is refused, not rounded", () => {
  // There is no B− on this scale. Guessing B or C+ would gate on a line the
  // user did not draw.
  for (
    const bad of [
      "grade-below:B-",
      "grade-below:",
      "grade-below:E",
      "always",
      "grade>=B",
    ]
  ) {
    assertThrows(() => parseFailOn(bad), Error, "fail-on");
  }
});

/* ------------------------------------------------------------------------ */
/* reading a result                                                          */
/* ------------------------------------------------------------------------ */

Deno.test("a withheld grade comes out as PARTIAL, with the reference kept apart", () => {
  const o = outcomeFromPoll(WITHHELD);
  assertEquals(o.status, "complete");
  assertEquals(o.grade, null);
  assertEquals(gradeOutput(o), "PARTIAL");
  assertEquals(testedOutput(o), "12/18");
  assertEquals(o.compositeReference, 96.6);
  assertEquals(o.composite, null);
});

Deno.test("the stored row that said A while its coverage said ungraded is read as PARTIAL", () => {
  // examples/SCN-2026-8637.scores.json records this exact defect: the row was
  // stored with grade "A" in the same object that says graded:false. An action
  // that reads `grade` first would put that A in somebody's CI.
  const o = outcomeFromPoll({
    status: "delivered",
    ...REC.stored_row,
    scores: REC.scores,
  });
  assertEquals(o.grade, null);
  assertEquals(gradeOutput(o), "PARTIAL");
});

Deno.test("no coverage at all is no grade, never a confident one", () => {
  const o = outcomeFromPoll({ status: "delivered", grade: "A", composite: 90 });
  assertEquals(o.grade, null);
  assertEquals(gradeOutput(o), "PARTIAL");
  assertEquals(testedOutput(o), "");
  assertMatch(renderSummary(o), /coverage could not be established/);
});

Deno.test("a graded scan carries its letter, ASCII in the output", () => {
  const o = outcomeFromPoll(graded("A−"));
  assertEquals(o.grade, "A−");
  assertEquals(gradeOutput(o), "A-");
  assertEquals(testedOutput(o), "18/18");
});

/** FULL's scores with whole dimensions taken out, as a short answer would be. */
function without(...keys: string[]): Record<string, unknown> {
  const scores = clone(FULL.scores) as Record<string, unknown>;
  for (const k of keys) delete scores[k];
  return scores;
}

Deno.test("a letter needs the whole battery: a result missing a dimension is PARTIAL", () => {
  // 15 of 15 is "every probe evidenced" only if nobody counts the three that
  // never came back. A letter over five dimensions is not a battery grade.
  const fromScores = outcomeFromPoll({
    ...graded("A", without("d6") as DimensionScores),
    coverage: undefined,
  });
  assertEquals(fromScores.grade, null);
  assertEquals(gradeOutput(fromScores), "PARTIAL");

  // Same rule when only the server's coverage object came back.
  const fromCoverage = outcomeFromPoll({
    status: "delivered",
    grade: "A",
    composite: 90,
    coverage: {
      dimensions_tested: 5,
      dimensions_total: 5,
      tests_evidenced: 15,
      tests_total: 15,
      tests_our_fault: 0,
      graded: true,
    },
  });
  assertEquals(fromCoverage.grade, null);
  assertEquals(gradeOutput(fromCoverage), "PARTIAL");
});

Deno.test("a probe our own judge failed still counts toward the whole battery", () => {
  // 17 evidenced + 1 of ours = 18: the battery is all there, and the judge
  // failure must not cost the agent its letter.
  const scores = clone(FULL.scores);
  scores.d4.tests[1] = {
    ...scores.d4.tests[1],
    evidence: "absent",
    fault: "judge",
  };
  const o = outcomeFromPoll({ ...graded("B", scores), coverage: undefined });
  assertEquals(o.grade, "B");
});

Deno.test("a local run is read the same way as a hosted one", async () => {
  const thin = await gradeBattery({
    scanId: "local-x",
    agent: { name: "a", model: "", type: "", description: "" },
    mode: "transcript",
    tier: "local",
    access: {
      mode: "transcript",
      transcript: JSON.parse(await Deno.readTextFile(SAMPLES)),
    },
  }, { judge: mockJudge() });
  const o = outcomeFromLocal(thin, "local-x", "mock");
  assertEquals(gradeOutput(o), "PARTIAL");
  assertEquals(testedOutput(o), "12/18");
  assertEquals(o.engine, "mock");
  assertEquals(
    gradeOutput(outcomeFromLocal(FULL, "local-y", "mock")),
    FULL.grade!.replace("−", "-"),
  );
});

/* ------------------------------------------------------------------------ */
/* the job summary                                                           */
/* ------------------------------------------------------------------------ */

Deno.test("summary: PARTIAL is the headline, and the reference is labelled as not a verdict", () => {
  const md = renderSummary(outcomeFromPoll(WITHHELD));
  const headline = md.split("\n").find((l) => l.startsWith("## "))!;
  assertMatch(headline, /PARTIAL — 12\/18 tests evidenced, no grade issued/);
  assert(!/\bA\b/.test(headline), headline);
  assertMatch(
    md,
    /For reference only, over the 12 evidenced tests: 96\.6\/100\. Do not deploy on this number\./,
  );
});

Deno.test("summary: every dimension is listed; a partly evidenced one gets a number and no letter", () => {
  const md = renderSummary(outcomeFromPoll(WITHHELD));
  const rows = md.split("\n").filter((l) => /^\| D\d · /.test(l));
  assertEquals(rows.length, 6);
  // D2: all three probes evidenced → a letter.
  assertMatch(
    rows[1],
    /^\| D2 · Execution Reliability \| 3 of 3 \| 94\.7 A \|$/,
  );
  // D3: one probe of three → the mean of one probe is a reading, not a grade.
  assertMatch(
    rows[2],
    /^\| D3 · Output Consistency \| 1 of 3 \| 100 · no letter \|$/,
  );
});

Deno.test("summary: NOT TESTED never turns into a number", () => {
  // Strip every probe in D5 of its evidence. The stored dimension score (94)
  // is still sitting in the object; the row must not print it.
  const scores = clone(REC.scores);
  for (const t of scores.d5.tests) t.evidence = "absent";
  const md = renderSummary(
    outcomeFromPoll({ ...WITHHELD, coverage: undefined, scores }),
  );
  const row = md.split("\n").find((l) => l.startsWith("| D5 · "))!;
  assertEquals(row, "| D5 · Context Window Management | 0 of 3 | NOT TESTED |");
  // Each unevidenced probe is named, so the reader knows what to send next.
  assertMatch(md, /NOT TESTED — 7 of 18 probes/);
  assertMatch(md, /- D5 · `instruction-retention`/);
  assertMatch(md, /- D1 · `grounded-qa`/);
});

Deno.test("summary: a probe our own judge failed on is named as ours, not the transcript's", () => {
  const scores = clone(FULL.scores);
  scores.d4.tests[1] = {
    ...scores.d4.tests[1],
    evidence: "absent",
    fault: "judge",
  };
  const md = renderSummary(
    outcomeFromPoll({ ...graded("B", scores), coverage: undefined }),
  );
  assertMatch(
    md,
    /- D4 · `argument-validity` — LEEVAR's own judge failed on this probe, not your transcript/,
  );
});

Deno.test("summary: a mock run says on its face that nothing was measured", async () => {
  const thin = await gradeBattery({
    scanId: "local-x",
    agent: { name: "a", model: "", type: "", description: "" },
    mode: "transcript",
    tier: "local",
    access: {
      mode: "transcript",
      transcript: JSON.parse(await Deno.readTextFile(SAMPLES)),
    },
  }, { judge: mockJudge() });
  assertMatch(
    renderSummary(outcomeFromLocal(thin, "local-x", "mock")),
    /Mock judge: no model was called/,
  );
});

Deno.test("summary: an evidenced dimension with no score reads 'no reading', never 0 F", () => {
  const scores = clone(FULL.scores) as unknown as Record<
    string,
    Record<string, unknown>
  >;
  delete scores.d2.score;
  scores.d3.score = null;
  const md = renderSummary(
    outcomeFromPoll({
      ...graded("B", scores as unknown as DimensionScores),
      coverage: undefined,
    }),
  );
  const row = (id: string) =>
    md.split("\n").find((l) => l.startsWith(`| ${id} · `))!;
  assertEquals(
    row("D2"),
    "| D2 · Execution Reliability | 3 of 3 | no reading |",
  );
  assertEquals(row("D3"), "| D3 · Output Consistency | 3 of 3 | no reading |");
  assert(!/\| 0 F \|/.test(md), md);
});

Deno.test("summary: full coverage with no letter says so, instead of 'only 18 of 18'", () => {
  const o = outcomeFromPoll({ ...graded("B"), grade: null });
  assertEquals(gradeOutput(o), "PARTIAL");
  const md = renderSummary(o);
  assertMatch(
    md,
    /Coverage cleared the line \(18 of 18\), but LEEVAR returned no letter for this scan\./,
  );
  assert(!md.includes("Only 18 of 18"), md);
});

Deno.test("summary: a result missing a dimension does not claim coverage cleared the line", () => {
  const md = renderSummary(
    outcomeFromPoll({
      ...graded("A", without("d6") as DimensionScores),
      coverage: undefined,
    }),
  );
  assert(!md.includes("Coverage cleared the line"), md);
  assertMatch(md, /15 probe verdicts where the battery has 18/);
  // The three that never came back are still named.
  assertMatch(md, /NOT TESTED — 3 of 18 probes/);
});

Deno.test("summary: the full report rides along, folded", () => {
  const md = renderSummary(outcomeFromPoll(WITHHELD));
  assertMatch(md, /<details><summary>Full report<\/summary>\n\n# Report/);
});

/* ------------------------------------------------------------------------ */
/* the gate                                                                  */
/* ------------------------------------------------------------------------ */

Deno.test("gate: never does not fail on a result, whatever it is", () => {
  assertEquals(gate(outcomeFromPoll(WITHHELD), { kind: "never" }).fail, false);
  assertEquals(
    gate(outcomeFromPoll(graded("F")), { kind: "never" }).fail,
    false,
  );
});

Deno.test("gate: grade-below fails closed on PARTIAL — there is no grade to clear the line", () => {
  const g = gate(outcomeFromPoll(WITHHELD), {
    kind: "grade-below",
    letter: "F",
  });
  assertEquals(g.fail, true);
  assertMatch(g.reason!, /no grade was issued/);
});

Deno.test("gate: grade-below compares on the published scale", () => {
  const below = (letter: string, line: string) =>
    gate(outcomeFromPoll(graded(letter)), { kind: "grade-below", letter: line })
      .fail;
  assertEquals(below("C+", "B"), true);
  assertEquals(below("B", "B"), false);
  assertEquals(below("A−", "B"), false);
  assertEquals(below("A−", "A"), true);
  assertEquals(below("A+", "A"), false);
});

Deno.test("gate: not-tested fails on any unevidenced probe, including PARTIAL", () => {
  assertEquals(
    gate(outcomeFromPoll(WITHHELD), { kind: "not-tested" }).fail,
    true,
  );
  assertEquals(
    gate(outcomeFromPoll(graded("B")), { kind: "not-tested" }).fail,
    false,
  );
  // Graded, but one probe went untested: still not the full battery.
  const scores = clone(FULL.scores);
  scores.d6.tests[0].evidence = "absent";
  const g = gate(
    outcomeFromPoll({ ...graded("B", scores), coverage: undefined }),
    { kind: "not-tested" },
  );
  assertEquals(g.fail, true);
  assertMatch(g.reason!, /1 of 18 probes NOT TESTED/);
});

Deno.test("gate: not-tested fails a PARTIAL even when every probe found evidence", () => {
  // Coverage 18/18, but no letter came back. "Nothing NOT TESTED" is true and
  // still not a pass: the gate's promise includes every PARTIAL.
  const o = outcomeFromPoll({ ...graded("B"), grade: null });
  assertEquals(testedOutput(o), "18/18");
  const g = gate(o, { kind: "not-tested" });
  assertEquals(g.fail, true);
  assertMatch(g.reason!, /no grade was issued \(PARTIAL\)/);
});

Deno.test("gate: a run with no result fails a gate, and does not fail never", () => {
  const timedOut: Outcome = {
    ...outcomeFromPoll(WITHHELD),
    status: "timeout",
    grade: null,
    message: "no result after 20 minutes",
  };
  assertEquals(gate(timedOut, { kind: "never" }).fail, false);
  assertEquals(gate(timedOut, { kind: "not-tested" }).fail, true);
  assertEquals(gate(timedOut, { kind: "grade-below", letter: "D" }).fail, true);
});

/* ------------------------------------------------------------------------ */
/* the hosted client                                                         */
/* ------------------------------------------------------------------------ */

type Answer = [number, unknown] | Error;

function scriptedFetch(
  answer: (body: Record<string, unknown>, n: number) => Answer,
) {
  const calls: {
    url: string;
    body: Record<string, unknown>;
    headers: Headers;
  }[] = [];
  const fn = ((input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    calls.push({
      url: String(input),
      body,
      headers: new Headers(init?.headers),
    });
    const a = answer(body, calls.length);
    // A real fetch rejects; it does not throw synchronously.
    if (a instanceof Error) return Promise.reject(a);
    const [status, json] = a;
    return Promise.resolve(
      new Response(typeof json === "string" ? json : JSON.stringify(json), {
        status,
        headers: {
          "content-type": typeof json === "string"
            ? "text/html"
            : "application/json",
        },
      }),
    );
  }) as typeof fetch;
  return Object.assign(fn, { calls });
}

function fakeClock() {
  let t = 0;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: (ms: number) => {
      sleeps.push(ms);
      t += ms;
      return Promise.resolve();
    },
    sleeps,
  };
}

const QUEUED = [202, {
  scan_id: "SCN-2026-5555",
  status: "queued",
  grant: "GRANT-SECRET-123",
}] as Answer;
const API = "https://www.leevar.live/api/scan";

function hosted(
  fetchImpl: typeof fetch,
  opts: { email?: string; timeoutMs?: number } = {},
) {
  const clock = fakeClock();
  const log: string[] = [];
  const run = runHosted({
    apiUrl: API,
    agent: { name: "support-bot", type: "Customer support" },
    samples: ["USER: hi\nAGENT: hello"],
    email: opts.email,
    timeoutMs: opts.timeoutMs ?? 20 * 60_000,
  }, {
    fetch: fetchImpl,
    sleep: clock.sleep,
    now: clock.now,
    log: (l) => log.push(l),
  });
  return { run, clock, log };
}

Deno.test("hosted: one submission in the documented shape, then polls with the grant", async () => {
  const f = scriptedFetch((_body, n) =>
    n === 1
      ? QUEUED
      : n < 4
      ? [200, { status: n === 2 ? "queued" : "running" }]
      : [200, WITHHELD]
  );
  const { run, log } = hosted(f, { email: "dev@example.com" });
  const o = await run;
  assertEquals(o.status, "complete");
  assertEquals(o.scanId, "SCN-2026-5555");
  assertEquals(gradeOutput(o), "PARTIAL");
  assertEquals(f.calls[0].url, API);
  assertEquals(f.calls[0].body, {
    agent: { name: "support-bot", type: "Customer support" },
    mode: "transcript",
    transcript: ["USER: hi\nAGENT: hello"],
    email: "dev@example.com",
    acq: "github-action",
  });
  assertMatch(
    f.calls[0].headers.get("user-agent")!,
    /^leevar-battery-action\//,
  );
  for (const c of f.calls.slice(1)) {
    assertEquals(c.body, {
      scan_id: "SCN-2026-5555",
      grant: "GRANT-SECRET-123",
    });
  }
  // The grant reads the result; in a public repository's log it would let
  // anyone read it. It is masked before anything else is printed.
  assertEquals(log[0], "::add-mask::GRANT-SECRET-123");
  assert(!log.slice(1).some((l) => l.includes("GRANT-SECRET-123")));
});

Deno.test("hosted: no email means no email field — not an empty one", async () => {
  const f = scriptedFetch((_b, n) => n === 1 ? QUEUED : [200, WITHHELD]);
  await hosted(f).run;
  assert(!("email" in f.calls[0].body));
});

Deno.test("hosted: polling backs off and is capped", async () => {
  const f = scriptedFetch((_b, n) =>
    n === 1 ? QUEUED : n < 9 ? [200, { status: "running" }] : [200, WITHHELD]
  );
  const { run, clock } = hosted(f);
  await run;
  assertEquals(clock.sleeps[0], POLL_FIRST_MS);
  for (let i = 1; i < clock.sleeps.length; i++) {
    assert(clock.sleeps[i] >= clock.sleeps[i - 1]);
  }
  assertEquals(Math.max(...clock.sleeps), POLL_MAX_MS);
});

Deno.test("hosted: a refused submission is reported plainly and never resubmitted", async () => {
  // Each submission can spend a free scan. A client that retries a 429 is
  // spending the shared daily capacity to work around its own limit.
  const f = scriptedFetch(() => [429, {
    error: "free tier is at today's limit for this network (20/day)",
    code: "network_daily_limit",
  }]);
  const o = await hosted(f).run;
  assertEquals(f.calls.length, 1);
  assertEquals(o.status, "error");
  assertMatch(o.message!, /HTTP 429/);
  assertMatch(o.message!, /network_daily_limit/);
  assertMatch(o.message!, /today's limit for this network/);
  assertMatch(o.message!, /not resubmit/);
});

Deno.test("hosted: a submission with no answer in 30 s may have been counted, and is not resubmitted", async () => {
  // The POST timed out, not the network: the scan may well be queued and its
  // free scan spent. "Could not reach" would invite a retry that spends another.
  const f = scriptedFetch(() =>
    new DOMException("Signal timed out.", "TimeoutError")
  );
  const o = await hosted(f).run;
  assertEquals(o.status, "error");
  assertEquals(f.calls.length, 1);
  assertMatch(
    o.message!,
    /no answer within 30 s; the scan may have been queued and counted\. This step does not resubmit\./,
  );
  assert(!/could not reach/.test(o.message!), o.message!);
});

Deno.test("hosted: an unreachable service is said to be unreachable", async () => {
  const f = scriptedFetch(() => new TypeError("fetch failed"));
  const o = await hosted(f).run;
  assertEquals(o.status, "error");
  assertMatch(o.message!, /could not reach LEEVAR/);
  assertEquals(f.calls.length, 1);
});

Deno.test("hosted: a queued scan with no poll ticket is not pretended to be readable", async () => {
  const f = scriptedFetch(
    () => [202, { scan_id: "SCN-2026-5556", status: "queued", grant: null }],
  );
  const o = await hosted(f, { email: "dev@example.com" }).run;
  assertEquals(o.status, "error");
  assertEquals(o.scanId, "SCN-2026-5556");
  assertMatch(o.message!, /no poll ticket/);
  assertMatch(o.message!, /emailed to dev@example\.com/);
  assertEquals(f.calls.length, 1);
});

Deno.test("hosted: an outage while polling is waited out; reads cost no free scan", async () => {
  const f = scriptedFetch((_b, n) =>
    n === 1 ? QUEUED : n === 2
      ? [503, {
        error: "lookup failed",
        code: "lookup_failed",
        retryable: true,
      }]
      : n === 3
      ? [502, "<html>Bad gateway</html>"]
      : n === 4
      ? new TypeError("connection reset")
      : [200, WITHHELD]
  );
  const o = await hosted(f).run;
  assertEquals(o.status, "complete");
  assertEquals(f.calls.length, 5);
  assertEquals(f.calls.filter((c) => !("scan_id" in c.body)).length, 1);
});

Deno.test("hosted: a poll the service rejects for good stops at once", async () => {
  const f = scriptedFetch((_b, n) =>
    n === 1
      ? QUEUED
      : [404, { error: "scan not found", code: "not_found", retryable: false }]
  );
  const o = await hosted(f).run;
  assertEquals(o.status, "error");
  assertMatch(o.message!, /HTTP 404/);
  assertMatch(o.message!, /not_found/);
  assertEquals(f.calls.length, 2);
});

Deno.test("hosted: a scan LEEVAR marks failed says whose fault it was", async () => {
  const f = scriptedFetch((_b, n) =>
    n === 1 ? QUEUED : [200, {
      scan_id: "SCN-2026-5555",
      status: "failed",
      failure: { reason: "watchdog_timeout", fault: "ours", retryable: true },
      grade: null,
      composite: null,
      coverage: null,
    }]
  );
  const o = await hosted(f).run;
  assertEquals(o.status, "failed");
  assertEquals(gradeOutput(o), "");
  const md = renderSummary(o);
  assertMatch(md, /watchdog_timeout/);
  assertMatch(md, /fault: ours/);
});

Deno.test("hosted: the timeout is a deadline, and it is reported as one", async () => {
  const f = scriptedFetch((_b, n) =>
    n === 1 ? QUEUED : [200, { status: "running" }]
  );
  const { run, clock } = hosted(f, { timeoutMs: 5 * 60_000 });
  const o = await run;
  assertEquals(o.status, "timeout");
  assertEquals(o.scanId, "SCN-2026-5555");
  assertMatch(o.message!, /no result after 5 minutes/);
  assertMatch(o.message!, /SCN-2026-5555 may still finish/);
  // Never past the deadline, and still exactly one submission.
  assertEquals(clock.now(), 5 * 60_000);
  assertEquals(f.calls.filter((c) => !("scan_id" in c.body)).length, 1);
});

/* ------------------------------------------------------------------------ */
/* the action as GitHub runs it                                              */
/* ------------------------------------------------------------------------ */

const GH_ENV = {
  // The repository root: every fixture these tests read lives under it.
  GITHUB_WORKSPACE: here("../"),
  GITHUB_OUTPUT: "/gh/output",
  GITHUB_STEP_SUMMARY: "/gh/summary",
  RUNNER_TEMP: "/gh/tmp",
  GITHUB_REPOSITORY: "acme/support-bot",
  GITHUB_ACTION: "battery",
};

function memIo(
  env: Record<string, string>,
  fetchImpl?: typeof fetch,
  extra: Partial<ActionIo> = {},
) {
  const files = new Map<string, string>();
  const out: string[] = [];
  const clock = fakeClock();
  const noNetwork = (() => {
    throw new Error("this test must not reach the network");
  }) as unknown as typeof fetch;
  const io: ActionIo = {
    env: (n) => ({ ...GH_ENV, ...env } as Record<string, string>)[n],
    fetch: fetchImpl ?? noNetwork,
    sleep: clock.sleep,
    now: clock.now,
    stdout: (l) => out.push(l),
    appendFile: (p, d) => {
      files.set(p, (files.get(p) ?? "") + d);
      return Promise.resolve();
    },
    writeFile: (p, d) => {
      files.set(p, d);
      return Promise.resolve();
    },
    ...extra,
  };
  const outputs = () =>
    Object.fromEntries(
      (files.get("/gh/output") ?? "").split("\n").filter(Boolean).map((l) => {
        const i = l.indexOf("=");
        return [l.slice(0, i), l.slice(i + 1)];
      }),
    );
  return { io, files, out, outputs };
}

Deno.test("action: a hosted PARTIAL writes every output, the summary and the report", async () => {
  const f = scriptedFetch((_b, n) => n === 1 ? QUEUED : [200, WITHHELD]);
  const m = memIo({
    INPUT_TRANSCRIPT: SAMPLES,
    INPUT_EMAIL: "action-test@leevar.internal",
  }, f);
  const code = await runAction(m.io);
  assertEquals(code, 0);
  assertEquals(m.outputs(), {
    "scan-id": "SCN-2026-5555",
    grade: "PARTIAL",
    tested: "12/18",
    report: "/gh/tmp/leevar-battery-battery.md",
    status: "complete",
  });
  assertMatch(m.files.get("/gh/summary")!, /PARTIAL — 12\/18 tests evidenced/);
  assertEquals(
    m.files.get("/gh/tmp/leevar-battery-battery.md"),
    m.files.get("/gh/summary"),
  );
  // Agent named after the repository when no name is given.
  assertEquals((f.calls[0].body.agent as { name: string }).name, "support-bot");
  // The log says where the transcript went before it went.
  assert(m.out.some((l) => l.includes("third-party language models")));
});

Deno.test("action: local mode with the mock judge needs no network and no key", async () => {
  const m = memIo({
    INPUT_TRANSCRIPT: SAMPLES,
    INPUT_MODE: "local",
    INPUT_PROVIDER: "mock",
  });
  assertEquals(await runAction(m.io), 0);
  assertEquals(m.outputs().grade, "PARTIAL");
  assertEquals(m.outputs().tested, "12/18");
  assertMatch(m.outputs()["scan-id"], /^local-/);
});

Deno.test("action: fail-on not-tested fails the step on PARTIAL, and says why", async () => {
  const m = memIo({
    INPUT_TRANSCRIPT: SAMPLES,
    INPUT_MODE: "local",
    INPUT_PROVIDER: "mock",
    INPUT_FAIL_ON: "not-tested",
  });
  assertEquals(await runAction(m.io), 1);
  assert(
    m.out.some((l) => l.startsWith("::error::") && l.includes("NOT TESTED")),
    m.out.join("\n"),
  );
  // The outputs are written either way: a later `if: always()` step can read them.
  assertEquals(m.outputs().grade, "PARTIAL");
});

Deno.test("action: LEEVAR being unavailable warns under never and fails a gate", async () => {
  const busy = () =>
    scriptedFetch(
      () => [429, {
        error: "free tier is at today's global capacity",
        code: "daily_capacity_reached",
      }],
    );
  const never = memIo({ INPUT_TRANSCRIPT: SAMPLES }, busy());
  assertEquals(await runAction(never.io), 0);
  assert(
    never.out.some((l) =>
      l.startsWith("::warning::") && l.includes("daily_capacity_reached")
    ),
  );
  assertEquals(never.outputs().status, "error");
  assertEquals(never.outputs().grade, "");
  const gated = memIo({
    INPUT_TRANSCRIPT: SAMPLES,
    INPUT_FAIL_ON: "grade-below:C",
  }, busy());
  assertEquals(await runAction(gated.io), 1);
  assert(gated.out.some((l) => l.startsWith("::error::")));
});

Deno.test("action: wrong inputs fail the step even under never", async () => {
  const cases: Record<string, string>[] = [
    {},
    { INPUT_TRANSCRIPT: "/no/such/file.json" },
    { INPUT_TRANSCRIPT: here("../cli/fixtures/not-an-array.json") },
    { INPUT_TRANSCRIPT: SAMPLES, INPUT_MODE: "live" },
    { INPUT_TRANSCRIPT: SAMPLES, INPUT_FAIL_ON: "grade-below:B-" },
    { INPUT_TRANSCRIPT: SAMPLES, INPUT_MODE: "local" },
    {
      INPUT_TRANSCRIPT: SAMPLES,
      INPUT_MODE: "local",
      INPUT_PROVIDER: "not-a-provider",
    },
    { INPUT_TRANSCRIPT: SAMPLES, INPUT_POLL_TIMEOUT_MINUTES: "soon" },
  ];
  for (const env of cases) {
    const m = memIo({ INPUT_FAIL_ON: "never", ...env });
    assertEquals(await runAction(m.io), 1, JSON.stringify(env));
    assert(m.out.some((l) => l.startsWith("::error::")), JSON.stringify(env));
    assertEquals(m.outputs().status, "error", JSON.stringify(env));
  }
});

Deno.test("action: a provider failure mid-run is not reported as a finding about the agent", async () => {
  const failing = {
    mode: "failing",
    calls: () => 0,
    score: () =>
      Promise.reject(new ProviderError("openai", "HTTP 401", 401, null)),
  };
  const m = memIo(
    {
      INPUT_TRANSCRIPT: SAMPLES,
      INPUT_MODE: "local",
      INPUT_PROVIDER: "openai",
    },
    undefined,
    { makeJudge: () => failing as never },
  );
  assertEquals(await runAction(m.io), 0);
  assertEquals(m.outputs().status, "error");
  assertEquals(m.outputs().grade, "");
  assert(!m.files.get("/gh/summary")!.includes("PARTIAL"));
});

Deno.test("action: a value from the server cannot write a second output line or a log command", async () => {
  const evil = "SCN-1\ngrade=A+\n::add-mask::x";
  const f = scriptedFetch(
    () => [202, { scan_id: evil, grant: "grant-1234567890" }],
  );
  const m = memIo({ INPUT_TRANSCRIPT: SAMPLES }, f);
  await runAction(m.io);
  const lines = m.files.get("/gh/output")!.split("\n").filter(Boolean);
  assertEquals(lines.filter((l) => l.startsWith("grade=")), ["grade="]);
  assertEquals(m.outputs().status, "error");
  assert(!m.out.some((l) => l.startsWith("::add-mask::x")), m.out.join("\n"));
});

Deno.test("action: a result this step cannot read is no result, not a crash", async () => {
  // Each of these once threw out of the step: in deriveCoverage (a null
  // dimension, a null verdict) or in the summary table (tests not a list).
  const malformed: unknown[] = [
    { d1: null },
    { d1: { score: 90, tests: 5 } },
    { d1: { score: 90, tests: [null] } },
    { d1: { score: 90, tests: [7] } },
  ];
  for (const scores of malformed) {
    const f = scriptedFetch((_b, n) =>
      n === 1 ? QUEUED : [200, { ...WITHHELD, scores }]
    );
    const m = memIo({ INPUT_TRANSCRIPT: SAMPLES }, f);
    assertEquals(await runAction(m.io), 0, JSON.stringify(scores));
    assertEquals(m.outputs().status, "error", JSON.stringify(scores));
    assertEquals(m.outputs()["scan-id"], "SCN-2026-5555");
    assertEquals(m.outputs().grade, "");
    assertMatch(
      m.files.get("/gh/summary")!,
      /LEEVAR answered with a result this step could not read/,
    );
  }
});

Deno.test("action: the endpoint is LEEVAR's; an environment variable cannot redirect the transcript", async () => {
  // LEEVAR_API_URL is set on the job by anyone who edits the workflow, or by
  // a step before this one. It was read, so it could send the transcript to
  // any host, over plain http too.
  const f = scriptedFetch((_b, n) => n === 1 ? QUEUED : [200, WITHHELD]);
  const m = memIo({
    INPUT_TRANSCRIPT: SAMPLES,
    LEEVAR_API_URL: "http://attacker.example/scan",
  }, f);
  assertEquals(await runAction(m.io), 0);
  assert(f.calls.length > 0);
  assert(f.calls.every((c) => c.url === DEFAULT_API_URL), f.calls[0].url);
  assert(!m.out.some((l) => l.includes("attacker.example")));
});

/* ------------------------------------------------------------------------ */
/* the transcript stays in the workspace                                     */
/* ------------------------------------------------------------------------ */

// A pull request can add a symlink. Checked out, `evals/t.json -> /etc/…` is a
// path inside the repository that reads a file outside it, and hosted mode
// would send that file to a third party. `--allow-read` does not stop it: Deno
// checks the path it is given, not where the link goes.
const WS = here("./fixtures/workspace");

Deno.test("transcript: a link out of the workspace is refused before anything is read or sent", async () => {
  const m = memIo({
    GITHUB_WORKSPACE: WS,
    INPUT_TRANSCRIPT: `${WS}/escape.json`,
  });
  // memIo's fetch throws if it is called: nothing may leave the runner.
  assertEquals(await runAction(m.io), 1);
  assertEquals(m.outputs().status, "error");
  const err = m.out.find((l) => l.startsWith("::error::")) ?? "";
  assertMatch(
    err,
    /transcript: .*escape\.json resolves outside the repository/,
  );
  assertMatch(err, /examples\/transcript-support-bot\.json/);
  assertMatch(err, /links out of the workspace are refused/);
});

Deno.test("transcript: a file inside the workspace is read", async () => {
  const m = memIo({
    GITHUB_WORKSPACE: WS,
    INPUT_TRANSCRIPT: `${WS}/inside.json`,
    INPUT_MODE: "local",
    INPUT_PROVIDER: "mock",
  });
  assertEquals(await runAction(m.io), 0);
  assertEquals(m.outputs().status, "complete");
});

Deno.test("transcript: a relative path is read from the workspace, whatever the working directory", async () => {
  // Deno resolves a relative path against the real working directory; when the
  // workspace path itself runs through a symlink, that lands outside the
  // --allow-read scope. The documented contract is "relative to the
  // repository root", so the root is what it is joined to.
  const m = memIo({
    GITHUB_WORKSPACE: WS,
    INPUT_TRANSCRIPT: "inside.json",
    INPUT_MODE: "local",
    INPUT_PROVIDER: "mock",
  });
  assertEquals(await runAction(m.io), 0, m.out.join("\n"));
  assertEquals(m.outputs().status, "complete");
});

Deno.test("transcript: a directory is refused as not a regular file", async () => {
  const m = memIo({
    GITHUB_WORKSPACE: WS,
    INPUT_TRANSCRIPT: WS,
    INPUT_MODE: "local",
    INPUT_PROVIDER: "mock",
  });
  assertEquals(await runAction(m.io), 1);
  assertMatch(
    m.out.find((l) => l.startsWith("::error::")) ?? "",
    /is not a regular file/,
  );
});

Deno.test("transcript: a file over the size cap is refused, not read", async () => {
  // The cap is a parameter so this can be shown without a 5 MiB fixture.
  const size = (await Deno.stat(SAMPLES)).size;
  await assertRejects(
    () => checkTranscript(SAMPLES, here("../"), size - 1),
    Error,
    `is ${size} bytes`,
  );
  await checkTranscript(SAMPLES, here("../"), size);
  assertEquals(MAX_TRANSCRIPT_BYTES, 5 * 1024 * 1024);
});

Deno.test({
  name: "transcript: a device such as /dev/zero is refused, not read forever",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    // Outside the repository, it is refused on that ground first.
    await assertRejects(
      () => checkTranscript("/dev/zero", here("../")),
      Error,
      "resolves outside the repository",
    );
    // With the containment rule out of the way (a workspace of "/": Deno
    // guards /dev itself behind --allow-all), the device is still refused.
    await assertRejects(
      () => checkTranscript("/dev/zero", "/"),
      Error,
      "is not a regular file",
    );
  },
});

/* ------------------------------------------------------------------------ */
/* action.yml stays wired to the code                                        */
/* ------------------------------------------------------------------------ */

Deno.test("action.yml: every input reaches the script and every output comes from it", async () => {
  // A composite action cannot be unit-tested from here, so its wiring is: an
  // input declared in action.yml but never passed through is a setting that
  // silently does nothing.
  const yml = await Deno.readTextFile(here("../action.yml"));
  const main = await Deno.readTextFile(here("./main.ts"));
  const block = (from: string, to: string) =>
    yml.slice(yml.indexOf(`\n${from}:`), yml.indexOf(`\n${to}:`));
  const inputs = [...block("inputs", "outputs").matchAll(/^ {2}([a-z-]+):$/gm)]
    .map((m) => m[1]);
  const outputs = [...block("outputs", "runs").matchAll(/^ {2}([a-z-]+):$/gm)]
    .map((m) => m[1]);
  assert(
    inputs.includes("transcript") && inputs.includes("fail-on"),
    inputs.join(","),
  );
  for (const name of inputs) {
    const env = `INPUT_${name.toUpperCase().replaceAll("-", "_")}`;
    assert(
      yml.includes(`${env}: \${{ inputs.${name} }}`),
      `${name} is not passed to the script`,
    );
    assert(main.includes(`"${env}"`), `${env} is never read`);
  }
  // The step reads the caller's workspace and nothing else on the runner.
  assert(
    yml.includes('--allow-read="$GITHUB_WORKSPACE"'),
    "--allow-read is not narrowed to the workspace",
  );
  const run = yml.slice(yml.indexOf("run: >-"));
  assert(!/--allow-read(\s|$)/m.test(run), "a bare --allow-read is left");
  assertEquals(outputs.sort(), [
    "grade",
    "report",
    "scan-id",
    "status",
    "tested",
  ]);
  for (const name of outputs) {
    assert(
      yml.includes(`value: \${{ steps.run.outputs.${name} }}`),
      `${name} is not wired`,
    );
    assert(
      new RegExp(`["']?${name}["']?: `).test(main),
      `${name} is never written`,
    );
  }
});
