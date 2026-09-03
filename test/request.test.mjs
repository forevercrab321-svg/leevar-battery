import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildPollRequest,
  buildRequest,
  loadInputs,
  normalizeOptions,
  parseArgs,
  redactRequest,
  toolOutputWarning,
} from "../scan.mjs";
import { startStub } from "./helpers/stub-server.mjs";
import { baseArgs, runCli, tempDir, writeTranscript } from "./helpers/cli.mjs";

const opts = (args, env = {}) => normalizeOptions(parseArgs(args), env);

test("buildRequest: transcript mode, free tier — the api-scan create shape (index.ts:15-23)", () => {
  const o = opts(["--email", "Dev@Example.com", "--name", "support-bot", "--transcript", "t.txt", "--model", "gpt-4-class", "--type", "Customer support"]);
  const req = buildRequest(o, { samples: ["User: hi\nAgent: hello"], job: null });
  assert.equal(req.method, "POST");
  assert.deepEqual(req.body, {
    agent: { name: "support-bot", model: "gpt-4-class", type: "Customer support" },
    mode: "transcript",
    transcript: ["User: hi\nAgent: hello"],
    email: "dev@example.com",
  });
  assert.equal(req.headers["content-type"], "application/json");
  assert.match(req.headers["user-agent"], /^leevar-battery\/\d+\.\d+\.\d+ node\//);
  assert.equal("authorization" in req.headers, false, "free tier sends no Authorization header");
  assert.equal("source" in req.body, false, "api-scan reads no `source` field (index.ts:462-477); nothing is sent");
  assert.equal("tier" in req.body, false, "default tier is not sent");
});

test("buildRequest: live mode with headers, key, tier full and a job spec", () => {
  const o = opts(["--name", "bot", "--live", "https://bot.example.com/chat", "--header", "x-api-key=SECRET", "--header", "x-team=blue", "--tier", "full"], { LEEVAR_API_KEY: "key-123" });
  const job = { description: "Handle my Shopify support inbox end to end", must_do: ["Look up an order"] };
  const req = buildRequest(o, { samples: [], job });
  assert.equal(req.headers.authorization, "Bearer key-123", "api-scan/index.ts:111-112");
  assert.deepEqual(req.body, {
    agent: { name: "bot" },
    mode: "live",
    endpoint: "https://bot.example.com/chat",
    headers: { "x-api-key": "SECRET", "x-team": "blue" },
    tier: "full",
    job,
  });
  assert.equal("email" in req.body, false, "keyed run without --email: the key's email is used server-side (index.ts:331)");
});

test("buildPollRequest: free tier carries the email (index.ts:222-225); keyed does not need it", () => {
  assert.deepEqual(buildPollRequest(opts(["--scan-id", "SCN-1", "--email", "a@b.c"]), "SCN-1").body, { scan_id: "SCN-1", email: "a@b.c" });
  const keyed = buildPollRequest(opts(["--scan-id", "SCN-1"], { LEEVAR_API_KEY: "k" }), "SCN-1");
  assert.deepEqual(keyed.body, { scan_id: "SCN-1" });
  assert.equal(keyed.headers.authorization, "Bearer k");
});

test("redactRequest hides the API key and every --header value, and leaves the original intact", () => {
  const o = opts(["--name", "bot", "--live", "https://x.y/z", "--header", "authorization=Bearer abc", "--header", "x-plain=hello"], { LEEVAR_API_KEY: "sk-very-secret" });
  const req = buildRequest(o, { samples: [], job: null });
  const shown = redactRequest(req);
  assert.equal(shown.headers.authorization, "Bearer ***redacted*** (LEEVAR_API_KEY, 14 chars)");
  assert.equal(shown.body.headers.authorization, "***redacted*** (10 chars)");
  assert.equal(shown.body.headers["x-plain"], "***redacted*** (5 chars)", "all values are redacted; we do not guess which header is secret");
  assert.equal(req.headers.authorization, "Bearer sk-very-secret");
  assert.equal(req.body.headers.authorization, "Bearer abc");
  assert.equal(JSON.stringify(shown).includes("sk-very-secret"), false);
});

test("toolOutputWarning: the probe.ts:36 regex, and what it costs", () => {
  assert.equal(toolOutputWarning(["User: hi\nAgent: hello there"]), null);
  for (const sample of ['TOOL_RESULT: {"refund_state":"processed"}', "tool result: ok", "<tool>x</tool>", '{"role": "tool", "content": "x"}', "Observation: the API returned 200", "function_call: lookup"]) {
    const w = toolOutputWarning(["User: hi", sample]);
    assert.ok(w, `should warn on ${sample}`);
    assert.match(w, /at most 12\/18 tests can be evidenced — below the 13\/18 line/);
    assert.match(w, /still spends a free scan/);
  }
});

test("loadInputs: several files become several samples; empty file is a usage error", async () => {
  const dir = await tempDir();
  const a = await writeTranscript(dir, "a.txt", "User: a\nAgent: b\n");
  const b = await writeTranscript(dir, "b.txt", "User: c\nAgent: d\n");
  const empty = path.join(dir, "empty.txt");
  await writeFile(empty, "   \n");
  const o = opts(["--email", "a@b.c", "--name", "n", "--transcript", a, "--transcript", b]);
  assert.deepEqual((await loadInputs(o)).samples, ["User: a\nAgent: b\n", "User: c\nAgent: d\n"]);
  await assert.rejects(loadInputs(opts(["--email", "a@b.c", "--name", "n", "--transcript", empty])), /is empty; the server refuses an empty sample with 400/);
  await assert.rejects(loadInputs(opts(["--email", "a@b.c", "--name", "n", "--transcript", a, "--job", path.join(dir, "missing.json")])), /--job .*no such file/);
  await writeFile(path.join(dir, "short.json"), JSON.stringify({ description: "too short" }));
  await assert.rejects(loadInputs(opts(["--email", "a@b.c", "--name", "n", "--transcript", a, "--job", path.join(dir, "short.json")])), /at least 20 characters/);
});

test("--dry-run sends nothing and prints no secret (human and --json)", async () => {
  const stub = await startStub();
  const dir = await tempDir();
  const t = await writeTranscript(dir);
  try {
    const env = { LEEVAR_API_KEY: "sk-live-DO-NOT-PRINT-0123456789" };
    const human = await runCli(["--api", stub.url, "--name", "bot", "--live", "https://bot.example.com/chat", "--header", "x-api-key=HEADER-SECRET-XYZ", "--dry-run"], { env });
    assert.equal(human.code, 0, human.all);
    assert.match(human.stdout, /dry run — nothing was sent/);
    assert.match(human.stdout, /authorization: Bearer \*\*\*redacted\*\*\* \(LEEVAR_API_KEY, 31 chars\)/);
    assert.match(human.stdout, /source tag "gh-battery" is not sent/);
    assert.equal(human.all.includes("DO-NOT-PRINT"), false);
    assert.equal(human.all.includes("HEADER-SECRET-XYZ"), false);

    const json = await runCli(baseArgs(stub.url, t, ["--dry-run", "--json"]), { env });
    assert.equal(json.code, 0, json.all);
    const parsed = JSON.parse(json.stdout);
    assert.equal(parsed.dry_run, true);
    assert.equal(parsed.request.url, stub.url);
    assert.equal(parsed.request.body.mode, "transcript");
    assert.equal("source" in parsed.request.body, false);
    assert.equal(json.all.includes("DO-NOT-PRINT"), false);

    assert.equal(stub.requests.length, 0, "dry-run must not touch the API");
  } finally {
    await stub.close();
  }
});

test("--transcript - reads stdin", async () => {
  const stub = await startStub();
  try {
    const r = await runCli(["--api", stub.url, "--email", "a@b.c", "--name", "bot", "--transcript", "-", "--dry-run", "--json"], { input: "User: from stdin\nAgent: yes\n" });
    assert.equal(r.code, 0, r.all);
    assert.deepEqual(JSON.parse(r.stdout).request.body.transcript, ["User: from stdin\nAgent: yes\n"]);
  } finally {
    await stub.close();
  }
});
