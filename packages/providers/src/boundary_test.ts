// Where a BYOK scan is allowed to send bytes, and where a key is allowed to go.
//
// Both are asserted by INTERCEPTING fetch and looking at what was actually
// attempted — not by reading the source and believing it. A grep for
// a grep for a host name would pass on a build that assembles it at runtime; this
// fails on it.

import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { makeJudge, describe, ProviderError, redact, PROVIDER_IDS } from "./index.ts";
import type { JudgeContext } from "../../scanner-core/src/prompts/types.ts";
import { BATTERY } from "../../scanner-core/src/battery.ts";

const CTX: JudgeContext = {
  agent: { name: "BoundaryBot", model: "x", type: "y", description: "z" },
  dim: BATTERY[0],
  test: BATTERY[0].tests[0],
  probe: "User: hi\nAgent: hi",
};

// Names itself. Every provider below is handed this and must not leak it; a
// scanner reading the repo should reach the same conclusion a reader does.
const KEY = "sk-PLACEHOLDER-BOUNDARY-TEST-NOT-A-KEY";

/** Record every request the code under test attempts, and answer them all. */
function intercept(reply: unknown) {
  const seen: { url: string; headers: Record<string, string>; body: string }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? {}).forEach((v, k) => (headers[k] = v));
    seen.push({ url, headers, body: String(init?.body ?? "") });
    return Promise.resolve(new Response(JSON.stringify(reply), {
      status: 200, headers: { "content-type": "application/json" },
    }));
  }) as typeof fetch;
  return { seen, restore: () => { globalThis.fetch = real; } };
}

const OPENAI_OK = { choices: [{ message: { content: '{"score":70,"result":"partial","evidence":"sufficient","detail":"ok"}' } }] };

Deno.test("every provider sends only to the endpoint it names — no LEEVAR host", async () => {
  const FORBIDDEN = /leevar\.live|leevarai\.org|supabase\.co/i;
  for (const id of PROVIDER_IDS) {
    const cfg = id === "openai-compatible"
      ? { provider: id, baseUrl: "https://llm.example.invalid/v1/chat/completions", apiKey: KEY }
      : { provider: id, apiKey: KEY };
    const shape = id === "anthropic"
      ? { content: [{ text: '{"score":70,"result":"partial","evidence":"sufficient","detail":"ok"}' }] }
      : id === "gemini"
      ? { candidates: [{ content: { parts: [{ text: '{"score":70,"result":"partial","evidence":"sufficient","detail":"ok"}' }] } }] }
      : OPENAI_OK;
    const net = intercept(shape);
    try {
      await makeJudge(cfg).score(CTX);
      assert(net.seen.length >= 1, `${id} made no request at all`);
      for (const r of net.seen) {
        assert(!FORBIDDEN.test(r.url), `${id} sent a request to ${r.url}`);
        assertEquals(r.url.startsWith(describe(cfg).endpoint.split("/models/")[0]), true,
          `${id} sent to ${r.url}, not the endpoint it reported`);
      }
    } finally { net.restore(); }
  }
});

Deno.test("Ollama runs with no key at all, and stays on localhost", async () => {
  const net = intercept(OPENAI_OK);
  try {
    // No apiKey, no apiKeyEnv, and an env reader that would throw if consulted.
    const j = makeJudge({ provider: "ollama", readEnv: () => { throw new Error("env was read for a keyless provider"); } });
    await j.score(CTX);
    assertEquals(net.seen.length, 1);
    assert(/^http:\/\/127\.0\.0\.1:11434\//.test(net.seen[0].url), net.seen[0].url);
    assert(!("authorization" in net.seen[0].headers), "Ollama sent an Authorization header");
  } finally { net.restore(); }
});

Deno.test("a provider that needs a key refuses rather than inventing one", () => {
  try {
    makeJudge({ provider: "openai", readEnv: () => undefined });
    throw new Error("expected a refusal");
  } catch (err) {
    assert(err instanceof ProviderError);
    assert(/no API key/.test(err.message));
    assert(/OPENAI_API_KEY/.test(err.message), "the refusal does not name the variable to set");
  }
});

Deno.test("the key reaches the provider and nothing else", async () => {
  const net = intercept(OPENAI_OK);
  try {
    await makeJudge({ provider: "openai", apiKey: KEY }).score(CTX);
    const r = net.seen[0];
    assertEquals(r.headers["authorization"], `Bearer ${KEY}`);
    // Not in the URL, where it would reach every proxy log on the way.
    assert(!r.url.includes(KEY), "the key is in the request URL");
    // Not in the body either.
    assert(!r.body.includes(KEY), "the key is in the request body");
  } finally { net.restore(); }
});

Deno.test("a provider error carries no key, even when the API echoes it back", async () => {
  const real = globalThis.fetch;
  // The realistic bad case: a 401 whose body quotes the Authorization header.
  globalThis.fetch = (() => Promise.resolve(new Response(
    JSON.stringify({ error: { message: `Incorrect API key provided: ${KEY}`, header: `Bearer ${KEY}` } }),
    { status: 401 },
  ))) as typeof fetch;
  try {
    // score() REJECTS on a 401 now. An earlier version of this test asserted it
    // returned a verdict with the key absent — true, and the wrong shape: an
    // invalid key was becoming a coverage gap in a report about the customer's
    // agent. See errors_test.ts for the classification this now follows.
    const err = await assertRejects(
      () => makeJudge({ provider: "openai", apiKey: KEY }).score(CTX),
      ProviderError,
    );
    assertEquals(err.code, "unauthorized");
    assert(!err.message.includes(KEY), "the key survived into the message");
    assert(!JSON.stringify(err.toJSON()).includes(KEY), "the key survived into toJSON()");
    assert(!err.message.includes("Bearer"), "an Authorization header survived into the message");
  } finally { globalThis.fetch = real; }
});

Deno.test("redact removes a key by value and by shape", () => {
  // FIXTURES THAT READ AS PLACEHOLDERS, NOT AS TOKENS.
  //
  // The previous fixture was a bearer-token shape with an alphabet body, and
  // GitGuardian flagged it — correctly, since looking like a token was the
  // whole reason it worked as a fixture. Splitting it into fragments would
  // have got past the scanner while leaving the same string in the file, and
  // that move was already ruled out on this branch for the internal address:
  // evasion is not remediation.
  //
  // Note for whoever writes the next comment here: this is the THIRD time on
  // this branch that explaining why a value is forbidden put the value into a
  // public file — the address in a test, the credential store in a comment
  // asserting it is unreadable, and the old token quoted right here. Describe
  // the shape. Do not quote the instance.
  //
  // So the fixtures now spell out what they are while still matching every
  // pattern in redact.ts. A reader and a scanner reach the same conclusion.
  const SHAPES = [
    "sk-ant-PLACEHOLDER-NOT-A-KEY",
    "Authorization: Bearer PLACEHOLDER-NOT-A-TOKEN",
    "AIzaPLACEHOLDER-NOT-A-GOOGLE-KEY-000",
    "sk-or-PLACEHOLDER-NOT-A-KEY",
  ];
  for (const s of SHAPES) {
    const out = redact(s);
    assert(out.includes("[REDACTED]"), `redact left this untouched: ${s}`);
    assert(!out.includes("PLACEHOLDER"), `redact kept the body of: ${s}`);
  }
  // And by exact value, for a provider whose prefix nothing here anticipates.
  assert(!redact(`token=${KEY}`, KEY).includes(KEY));
  assert(!redact("vendor-x zzzz-0000-1111", "zzzz-0000-1111").includes("zzzz-0000-1111"));
});
