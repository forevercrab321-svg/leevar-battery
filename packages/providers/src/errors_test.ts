// A failed provider is not a finding about the agent.
//
// Every case goes through the PUBLIC path — makeJudge(...).score() — because
// that is the function whose behaviour was wrong: it caught every ProviderError
// and returned `evidence: "absent"`, so an invalid key produced a low-coverage
// report about the customer's agent instead of telling them their key was
// rejected. And it retried the 401 first, so it did it twice.
//
// Each test asserts the HTTP CALL COUNT as well as the outcome. "Rejects" is
// half the fix; "rejects without spending a second call" is the other half.

import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { makeJudge, ProviderError, DEFAULT_MAX_CALLS } from "./index.ts";
import { gradeBattery } from "../../scanner-core/src/grade-battery.ts";
import { BATTERY } from "../../scanner-core/src/battery.ts";
import type { JudgeContext } from "../../scanner-core/src/prompts/types.ts";

const KEY = "sk-PLACEHOLDER-ERRORS-TEST-NOT-A-KEY";
const CTX: JudgeContext = {
  agent: { name: "ErrBot", model: "x", type: "y", description: "z" },
  dim: BATTERY[0], test: BATTERY[0].tests[0], probe: "User: hi\nAgent: hi",
};
const OK_BODY = '{"score":70,"result":"partial","evidence":"sufficient","detail":"ok"}';

/** Replace fetch with a scripted sequence; count what was actually attempted. */
function scripted(...responses: (() => Response | Promise<Response>)[]) {
  let n = 0;
  const real = globalThis.fetch;
  globalThis.fetch = (() => {
    const make = responses[Math.min(n, responses.length - 1)];
    n++;
    return Promise.resolve(make());
  }) as typeof fetch;
  return { calls: () => n, restore: () => { globalThis.fetch = real; } };
}

const status = (code: number, body = "{}") => () => new Response(body, { status: code });
const ok = () => new Response(JSON.stringify({ choices: [{ message: { content: OK_BODY } }] }), { status: 200 });
const emptyChoices = () => new Response(JSON.stringify({ choices: [] }), { status: 200 });
const okGarbage = () => new Response(JSON.stringify({ choices: [{ message: { content: "I think it is fine, honestly" } }] }), { status: 200 });
const timeout = () => { const e = new Error("timed out"); e.name = "TimeoutError"; throw e; };

async function expectReject(code: string, calls: number, ...responses: (() => Response | Promise<Response>)[]) {
  const net = scripted(...responses);
  try {
    const err = await assertRejects(
      () => makeJudge({ provider: "openai", apiKey: KEY, timeoutMs: 200 }).score(CTX),
      ProviderError,
    );
    assertEquals(err.code, code, `expected code ${code}, got ${err.code}`);
    assertEquals(net.calls(), calls, `expected ${calls} HTTP call(s), made ${net.calls()}`);
    // No key, anywhere, in any serialisation.
    assert(!err.message.includes(KEY), "the key is in the message");
    assert(!JSON.stringify(err.toJSON()).includes(KEY), "the key is in toJSON()");
    assert(err.advice.length > 0, "no actionable advice");
    return err;
  } finally { net.restore(); }
}

Deno.test("401 rejects immediately, one call, no retry", async () => {
  const e = await expectReject("unauthorized", 1, status(401, '{"error":{"message":"Incorrect API key provided"}}'));
  assert(/HTTP 401/.test(e.message));
});

Deno.test("403 rejects immediately, one call", async () => {
  await expectReject("forbidden", 1, status(403));
});

Deno.test("404 rejects immediately, one call", async () => {
  await expectReject("not_found", 1, status(404));
});

Deno.test("400 rejects immediately, one call", async () => {
  await expectReject("invalid_request", 1, status(400));
});

Deno.test("429 rejects immediately, one call — a retry would make it worse", async () => {
  await expectReject("rate_limited", 1, status(429));
});

Deno.test("500 retries exactly once, then rejects", async () => {
  await expectReject("provider_unavailable", 2, status(500), status(500));
});

Deno.test("a 500 that recovers on the retry returns a verdict", async () => {
  const net = scripted(status(500), ok);
  try {
    const v = await makeJudge({ provider: "openai", apiKey: KEY }).score(CTX);
    assertEquals(v.evidence, "sufficient");
    assertEquals(net.calls(), 2);
  } finally { net.restore(); }
});

Deno.test("timeout retries exactly once, then rejects as network", async () => {
  await expectReject("network", 2, timeout, timeout);
});

Deno.test("the call ceiling rejects, and is not a verdict", async () => {
  const net = scripted(ok);
  try {
    const j = makeJudge({ provider: "openai", apiKey: KEY, maxCalls: 1 });
    await j.score(CTX);                       // spends the one call
    const err = await assertRejects(() => j.score(CTX), ProviderError);
    assertEquals(err.code, "call_ceiling");
    assertEquals(net.calls(), 1, "a call was made after the ceiling was reached");
  } finally { net.restore(); }
});

Deno.test("HTTP 200 twice with unreadable bodies IS a judge fault", async () => {
  // The one survivor of the old behaviour, and the only thing that may become
  // a verdict: the provider answered, we could not read it, twice.
  const net = scripted(okGarbage, okGarbage);
  try {
    const v = await makeJudge({ provider: "openai", apiKey: KEY }).score(CTX);
    assertEquals(v.evidence, "absent");
    assertEquals(v.fault, "judge");
    assertEquals(net.calls(), 2);
  } finally { net.restore(); }
});

Deno.test("200 with an empty choices array is a bad_response, twice is a judge fault", async () => {
  // HTTP 200, network fine, `{"choices":[]}`. This produced code "network" and
  // the message "could not reach the provider — check connectivity, proxy and
  // baseUrl", which sent the user to look at their network for a request that
  // had completed successfully. Reproduced before the fix: 2 requests, reject,
  // code network.
  const net = scripted(emptyChoices, emptyChoices);
  try {
    const v = await makeJudge({ provider: "openai", apiKey: KEY }).score(CTX);
    assertEquals(v.evidence, "absent");
    assertEquals(v.fault, "judge", "an unreadable 200 must be OUR fault, not the agent's");
    assertEquals(net.calls(), 2, "bad_response gets exactly one retry");
  } finally { net.restore(); }
});

Deno.test("200 empty then 200 valid returns the verdict", async () => {
  const net = scripted(emptyChoices, ok);
  try {
    const v = await makeJudge({ provider: "openai", apiKey: KEY }).score(CTX);
    assertEquals(v.evidence, "sufficient");
    assertEquals(v.score, 70);
    assertEquals(net.calls(), 2);
  } finally { net.restore(); }
});

Deno.test("500 then 200-empty ends as a judge fault, never as connectivity", async () => {
  // The mixed case, and the one most able to produce a misleading answer: the
  // run began with a genuine server error and ended with a successful request
  // whose body was unusable. Reporting the 500 would tell the user their
  // provider is down when its last act was to answer them.
  const net = scripted(status(500), emptyChoices);
  try {
    const v = await makeJudge({ provider: "openai", apiKey: KEY }).score(CTX);
    assertEquals(v.evidence, "absent");
    assertEquals(v.fault, "judge");
    assertEquals(net.calls(), 2);
  } finally { net.restore(); }
});

Deno.test("an empty 200 is never classified as network", async () => {
  // Direct on the adapter, so the classification is pinned at its source and
  // not only through score()'s handling of it.
  const net = scripted(emptyChoices);
  try {
    const err = await assertRejects(
      () => makeJudge({ provider: "openai", apiKey: KEY, maxCalls: 1 }).score(CTX),
      ProviderError,
    );
    assert(err.code !== "network", `an HTTP 200 was classified as ${err.code}`);
  } finally { net.restore(); }
});

Deno.test("a fatal provider error fails the whole battery — no misleading report", async () => {
  // The pooled path. Before this change the battery completed, every test came
  // back absent, and the customer received a coverage report about their agent
  // describing a failure that was entirely in their own configuration.
  const net = scripted(status(401));
  try {
    const err = await assertRejects(
      () => gradeBattery({
        scanId: "ERR-FIXTURE-0001",
        agent: { name: "ErrBot", model: "x", type: "y", description: "z" },
        mode: "transcript", tier: "scan",
        access: { mode: "transcript", transcript: ["User: hi\nAgent: hi"] },
      }, { judge: makeJudge({ provider: "openai", apiKey: KEY }) }),
      ProviderError,
    );
    assertEquals(err.code, "unauthorized");
    assert(!err.message.includes(KEY));
  } finally { net.restore(); }
});

Deno.test("the default ceiling is derived from the battery, not chosen", () => {
  const tests = BATTERY.flatMap((d) => d.tests).length;
  assertEquals(DEFAULT_MAX_CALLS, tests * 2,
    "the ceiling stopped tracking the battery — one retry per test is the max a correct run reaches");
});
