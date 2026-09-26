// Tests for leevar-mcp. Nothing here calls the hosted LEEVAR API: every
// request goes to an in-process fake or a local HTTP stub, so running the tests
// spends no one's free scans and no model calls.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createServer, summarize } from "./index.mjs";

const here = dirname(fileURLToPath(import.meta.url));

/** A fake fetch that records requests and answers from a script. */
function fakeFetch(answers) {
  const calls = [];
  const fn = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    const [status, json] = answers(body);
    return new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
  };
  fn.calls = calls;
  return fn;
}

async function connect(fetchImpl) {
  const server = createServer({ fetchImpl });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

const textOf = (r) => r.content.map((c) => c.text).join("\n");

test("the three tools are listed, and the scan tool tells the user where their data goes", async () => {
  const client = await connect(fakeFetch(() => [200, {}]));
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["leevar_battery", "leevar_scan_status", "leevar_scan_transcript"]);
  const scan = tools.find((t) => t.name === "leevar_scan_transcript");
  assert.match(scan.description, /deleted 30 days\s+after the scan/);
  assert.match(scan.description, /third-party language models/);
  assert.match(scan.description, /Ask the user before sending their data/);
  // It spends a free scan and sends data out: never advertised as read-only.
  assert.equal(scan.annotations?.readOnlyHint, false);
  assert.equal(scan.annotations?.openWorldHint, true);
  assert.equal(tools.find((t) => t.name === "leevar_battery").annotations?.readOnlyHint, true);
});

test("scan: sends a transcript-mode request and returns the scan id", async () => {
  // api-scan answers a created scan with 202, not 200.
  const f = fakeFetch(() => [202, { scan_id: "SCN-2026-0001", status: "queued" }]);
  const client = await connect(f);
  const r = await client.callTool({
    name: "leevar_scan_transcript",
    arguments: {
      agent_name: "support-bot",
      email: "dev@example.com",
      transcripts: ["User: where is my order?\nAgent: It shipped Monday."],
      agent_type: "Customer support",
    },
  });
  assert.equal(r.isError, undefined);
  assert.match(textOf(r), /Queued as SCN-2026-0001/);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].body, {
    agent: { name: "support-bot", type: "Customer support" },
    mode: "transcript",
    transcript: ["User: where is my order?\nAgent: It shipped Monday."],
    email: "dev@example.com",
  });
});

test("scan: an API refusal is a tool error that says whose fault it is, not a fake success", async () => {
  // The body api-scan actually sends when an email's quota is used up: no `code` field.
  const f = fakeFetch(() => [429, {
    error: "free tier exhausted (5/5 this month for this email) — email hello@leevarai.org for an API key",
  }]);
  const client = await connect(f);
  const r = await client.callTool({
    name: "leevar_scan_transcript",
    arguments: { agent_name: "a", email: "dev@example.com", transcripts: ["User: hi\nAgent: hello"] },
  });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /HTTP 429/);
  assert.match(textOf(r), /free tier exhausted/);
  assert.doesNotMatch(textOf(r), /code:/);
  const f2 = fakeFetch(() => [503, { error: "lookup failed", code: "lookup_failed", retryable: true, correlation_id: "c-1" }]);
  const r2 = await (await connect(f2)).callTool({
    name: "leevar_scan_status",
    arguments: { scan_id: "SCN-2026-0001", email: "dev@example.com" },
  });
  assert.equal(r2.isError, true);
  assert.match(textOf(r2), /safe to retry/);
  assert.match(textOf(r2), /c-1/);
  assert.match(textOf(r2), /code: lookup_failed/);
});

test("status: a graded scan prints its grade and coverage", async () => {
  const f = fakeFetch(() => [200, {
    status: "delivered",
    grade: "B",
    composite: 81.2,
    coverage: { tests_evidenced: 15, tests_total: 18, dimensions_tested: 6, dimensions_total: 6, graded: true },
    report_md: "# Report\n…",
  }]);
  const r = await (await connect(f)).callTool({
    name: "leevar_scan_status",
    arguments: { scan_id: "SCN-2026-0001", email: "dev@example.com" },
  });
  assert.match(textOf(r), /Grade: B \(composite 81.2\)/);
  assert.match(textOf(r), /15 of 18 tests evidenced/);
  assert.deepEqual(f.calls[0].body, { scan_id: "SCN-2026-0001", email: "dev@example.com" });
});

test("status: a withheld grade is never printed as one — the refusal is the headline", () => {
  const out = summarize({
    scan_id: "SCN-2026-0002",
    status: "delivered",
    grade: null,
    composite: null,
    composite_reference: 96.2,
    grade_withheld: "insufficient_coverage",
    coverage: { tests_evidenced: 12, tests_total: 18, dimensions_tested: 5, dimensions_total: 6, graded: false },
  });
  assert.match(out, /No grade issued/);
  assert.match(out, /NOT TESTED, not passed/);
  assert.match(out, /96.2 — not a verdict/);
  assert.doesNotMatch(out, /Grade: /);
  // Even if a grade field were present, graded:false wins.
  assert.doesNotMatch(summarize({ status: "delivered", grade: "A", coverage: { graded: false } }), /Grade: A/);
});

test("status: queued and failed scans say what to do next", () => {
  assert.match(summarize({ status: "queued" }), /ask again with leevar_scan_status/);
  assert.match(summarize({ status: "running" }), /Not finished yet/);
  const failed = summarize({ status: "failed", failure: { reason: "watchdog_timeout", fault: "ours", retryable: true } });
  assert.match(failed, /fault: ours/);
  assert.match(failed, /credited back/);
  // The customer's fault: no retry advice, no refund promise.
  const theirs = summarize({ status: "failed", failure: { reason: "no_samples", fault: "yours", retryable: false } });
  assert.match(theirs, /fault: yours/);
  assert.match(theirs, /fix the input first/);
  assert.doesNotMatch(theirs, /credited back/);
});

test("status: `graded` is a finished state, not an unfinished one", () => {
  // api-scan returns the row's own status, and a scan can sit at `graded`
  // (report not yet delivered) for a long time. It carries a result.
  const out = summarize({
    status: "graded",
    grade: "B",
    composite: 80.4,
    coverage: { tests_evidenced: 14, tests_total: 18, dimensions_tested: 6, dimensions_total: 6, graded: true },
  });
  assert.doesNotMatch(out, /Not finished yet/);
  assert.match(out, /Grade: B \(composite 80.4\)/);
});

test("a non-JSON answer or no answer at all is a clear tool error, not a crash", async () => {
  const html = async () => new Response("<html>Bad gateway</html>", { status: 502, headers: { "content-type": "text/html" } });
  const r = await (await connect(html)).callTool({
    name: "leevar_scan_status",
    arguments: { scan_id: "SCN-2026-0001", email: "dev@example.com" },
  });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /HTTP 502/);
  const down = async () => { throw new TypeError("fetch failed"); };
  const r2 = await (await connect(down)).callTool({
    name: "leevar_scan_transcript",
    arguments: { agent_name: "a", email: "dev@example.com", transcripts: ["User: hi\nAgent: hello"] },
  });
  assert.equal(r2.isError, true);
  assert.match(textOf(r2), /could not reach LEEVAR: fetch failed/);
  assert.match(textOf(r2), /\(no response\)/);
});

test("battery: lists all 18 tests from the generated definition", async () => {
  const r = await (await connect(fakeFetch(() => [200, {}]))).callTool({ name: "leevar_battery", arguments: {} });
  const t = textOf(r);
  assert.match(t, /Battery DX-FULL-V6/);
  assert.equal((t.match(/^- /gm) ?? []).length, 18);
  assert.match(t, /citation-fabrication \(needs a verified source\)/);
});

test("stdio: the server file starts a real server that talks to the configured API", async () => {
  const seen = [];
  const http = createHttpServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      seen.push(JSON.parse(data));
      res.writeHead(202, { "content-type": "application/json" });
      res.end(JSON.stringify({ scan_id: "SCN-2026-4242", status: "queued" }));
    });
  });
  await new Promise((r) => http.listen(0, "127.0.0.1", r));
  const port = http.address().port;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(here, "index.mjs")],
    env: { ...process.env, LEEVAR_API_URL: `http://127.0.0.1:${port}/api-scan` },
  });
  const client = new Client({ name: "stdio-test", version: "0" });
  try {
    await client.connect(transport);
    const r = await client.callTool({
      name: "leevar_scan_transcript",
      arguments: { agent_name: "x", email: "dev@example.com", transcripts: ["User: a\nAgent: b"] },
    });
    assert.match(textOf(r), /SCN-2026-4242/);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].mode, "transcript");
  } finally {
    await client.close();
    http.close();
  }
});
