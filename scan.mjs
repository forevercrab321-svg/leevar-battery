#!/usr/bin/env node
// LEEVAR battery client — runs the 18-test reliability battery from a terminal
// or CI and turns the result into an exit code you can gate a build on.
//
//   node scan.mjs --email you@co.com --name my-agent --transcript ./sample.txt
//   node scan.mjs --email you@co.com --name my-agent --live https://agent.example.com/chat --header "x-api-key=$TOKEN"
//   node scan.mjs --help
//
// Zero dependencies beyond Node 20 built-ins. Nothing here phones home except
// the one POST you asked for; `--dry-run` shows that request without sending it.
//
// Server contract this file relies on (leevar-home @ origin/main e7e046f):
//   supabase/functions/api-scan/index.ts   request/response shape, error codes
//   supabase/functions/_shared/coverage.ts  grade_withheld semantics (0.67 line)
//   supabase/functions/_shared/failure.ts   `failure` object on status:"failed"
//   supabase/functions/_shared/grade.ts     the letter ladder (A-minus is U+2212)
//   supabase/functions/_shared/probe.ts     the tool-output regex, ported verbatim
//   supabase/functions/_shared/pipeline.ts  status "graded" is terminal when delivery fails
//
// Line references appear next to the behaviour they justify. When the server
// changes, those are the lines to re-read.

import { appendFile, readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const VERSION = "0.2.0";
export const CLIENT_NAME = "leevar-battery";
export const DEFAULT_API = "https://rzmsvvalhaqvxbuhpdnb.supabase.co/functions/v1/api-scan";
export const SITE = "https://www.leevar.live";
export const FREE_SCANS_PER_MONTH = 5; // api-scan/index.ts:333
export const FREE_SCANS_PER_IP_PER_DAY = 20; // _shared/client-ip.ts:55
export const GRADED_MIN_RATIO = 0.67; // _shared/coverage.ts:54
export const BATTERY_TESTS = 18;
export const VERIFIED_SOURCE_TESTS = 6; // battery.ts: needsVerifiedSource ×6 (D1×2, D4×3, D6×1)

/** Exit codes are an API. Scripts branch on these; do not renumber. */
export const EXIT = Object.freeze({
  PASS: 0,
  THRESHOLD_NOT_MET: 1,
  WITHHELD: 2,
  REFUSED: 3,
  USAGE: 4,
  SCAN_FAILED: 5,
  TIMEOUT: 6,
  UNREACHABLE: 7,
});

/** _shared/grade.ts:7-16, ascending. The server spells A-minus with U+2212. */
export const GRADE_LADDER = ["F", "D", "D+", "C", "C+", "B", "B+", "A−", "A", "A+"];

/** One label per verdict, shared by the human, quiet and summary renderers. */
export const VERDICT_LABELS = {
  pass: "pass",
  threshold_not_met: "threshold not met",
  withheld: "grade withheld",
  scan_failed: "Scan failed",
  refused: "Request refused",
  timeout: "Timed out",
  unreachable: "API unreachable",
  submitted: "submitted",
};

/** _shared/battery.ts — the `scores` jsonb keys and their names. */
export const DIMENSIONS = {
  d1: "Truthfulness & Hallucination",
  d2: "Execution Reliability",
  d3: "Output Consistency",
  d4: "Tool Use Quality",
  d5: "Context Window Management",
  d6: "Recovery & Error Handling",
};

/** _shared/probe.ts:36, verbatim. Over-detecting is the honest direction. */
export const TOOL_OUTPUT_RE =
  /tool[_\s-]?(result|output|response|call)|function[_\s-]?(result|call|response)|<\s*tool|"role"\s*:\s*"tool"|\bobservation\s*:/i;

/** Poll statuses after which nothing more will arrive (pipeline.ts:428-436, 460-469, 493-495). */
export const TERMINAL_STATUSES = new Set(["delivered", "graded", "failed"]);

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.exitCode = EXIT.USAGE;
  }
}

/* -------------------------------------------------------------------------- */
/* Argument parsing                                                           */
/* -------------------------------------------------------------------------- */

export const SPEC = {
  transcript: { type: "list" },
  live: { type: "string" },
  header: { type: "list" },
  email: { type: "string" },
  name: { type: "string" },
  model: { type: "string" },
  type: { type: "string" },
  tier: { type: "string", default: "scan" },
  job: { type: "string" },
  source: { type: "string", default: "gh-battery" },
  "scan-id": { type: "string" },
  "no-wait": { type: "bool" },
  interval: { type: "number", default: 15 },
  timeout: { type: "number", default: 1500 },
  "fail-below": { type: "string" },
  "fail-on-withheld": { type: "bool" },
  json: { type: "bool" },
  "dry-run": { type: "bool" },
  summary: { type: "string" },
  "github-output": { type: "string" },
  api: { type: "string" },
  verbose: { type: "bool", alias: "v" },
  quiet: { type: "bool", alias: "q" },
  "no-color": { type: "bool" },
  help: { type: "bool", alias: "h" },
  version: { type: "bool" },
};

const ALIASES = Object.fromEntries(
  Object.entries(SPEC).filter(([, s]) => s.alias).map(([k, s]) => [s.alias, k]),
);

function editDistance(a, b) {
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return d[m][n];
}

function suggestFlag(name) {
  let best = null, bestD = Infinity;
  for (const k of Object.keys(SPEC)) {
    const d = editDistance(name, k);
    if (d < bestD) { bestD = d; best = k; }
  }
  return bestD <= 3 ? best : null;
}

/**
 * Parse argv into raw options. Throws UsageError (exit 4) on anything the
 * user could not have meant. Semantic validation lives in normalizeOptions.
 */
export function parseArgs(argv) {
  const opts = {};
  const positionals = [];
  for (const [k, s] of Object.entries(SPEC)) {
    if (s.type === "list") opts[k] = [];
    else if (s.type === "bool") opts[k] = false;
    else if ("default" in s) opts[k] = s.default;
    else opts[k] = undefined;
  }
  let i = 0;
  let onlyPositionals = false;
  while (i < argv.length) {
    const arg = argv[i++];
    if (onlyPositionals || !arg.startsWith("-") || arg === "-") {
      positionals.push(arg);
      continue;
    }
    if (arg === "--") { onlyPositionals = true; continue; }
    let name, inlineValue;
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      inlineValue = eq === -1 ? undefined : arg.slice(eq + 1);
    } else {
      const short = arg.slice(1);
      name = ALIASES[short];
      if (!name) {
        throw new UsageError(`unknown flag "${arg}". Short flags are -v, -q and -h; run --help for the list.`);
      }
    }
    const spec = SPEC[name];
    if (!spec) {
      const hint = suggestFlag(name);
      throw new UsageError(
        `unknown flag "--${name}".${hint ? ` Did you mean --${hint}?` : ""} Run --help for the list.`,
      );
    }
    if (spec.type === "bool") {
      if (inlineValue !== undefined) {
        throw new UsageError(`--${name} takes no value (got "--${name}=${inlineValue}").`);
      }
      opts[name] = true;
      continue;
    }
    let value = inlineValue;
    if (value === undefined) {
      if (i >= argv.length) {
        throw new UsageError(`--${name} needs a value, e.g. --${name} ${exampleValue(name)}.`);
      }
      value = argv[i++];
    }
    if (spec.type === "number") {
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) {
        throw new UsageError(`--${name} must be a positive number of seconds (got "${value}").`);
      }
      opts[name] = n;
    } else if (spec.type === "list") {
      opts[name].push(value);
    } else {
      opts[name] = value;
    }
  }
  opts._positionals = positionals;
  return opts;
}

function exampleValue(name) {
  return {
    transcript: "./sample.txt",
    live: "https://agent.example.com/chat",
    header: "x-api-key=TOKEN",
    email: "you@example.com",
    name: "my-agent",
    "fail-below": "B",
    "scan-id": "SCN-2026-1234",
    interval: "15",
    timeout: "1500",
    summary: '"$GITHUB_STEP_SUMMARY"',
    "github-output": '"$GITHUB_OUTPUT"',
    job: "./job.json",
    tier: "scan",
    source: "gh-battery",
    api: DEFAULT_API,
  }[name] ?? "<value>";
}

/** The ladder accepts "A-", "a-", "A−" and "a−" as the same grade. */
export function normalizeGrade(s) {
  return String(s ?? "").trim().toUpperCase().replace(/[-‐-―−]/g, "−");
}

export function gradeRank(s) {
  return GRADE_LADDER.indexOf(normalizeGrade(s));
}

export function parseThreshold(raw) {
  const t = String(raw).trim();
  if (/^\d+(\.\d+)?$/.test(t)) {
    const value = Number(t);
    if (value > 100) throw new UsageError(`--fail-below ${t}: a composite threshold is 0-100.`);
    return { kind: "composite", value, label: t };
  }
  const rank = gradeRank(t);
  if (rank < 0) {
    throw new UsageError(
      `--fail-below "${raw}" is not a grade. Use one of ${GRADE_LADDER.join(" ")} (A- is accepted for A−) or a composite number 0-100.`,
    );
  }
  return { kind: "grade", rank, label: GRADE_LADDER[rank] };
}

export function meetsThreshold(threshold, grade, composite) {
  if (!threshold) return true;
  if (threshold.kind === "composite") return typeof composite === "number" && composite >= threshold.value;
  const r = gradeRank(grade ?? "");
  return r >= 0 && r >= threshold.rank;
}

export function parseHeader(kv) {
  const eq = kv.indexOf("=");
  const key = (eq === -1 ? kv : kv.slice(0, eq)).trim();
  if (eq === -1 || !key) {
    throw new UsageError(`--header expects name=value (got "${kv}"). Example: --header "x-api-key=$TOKEN".`);
  }
  return [key, kv.slice(eq + 1)];
}

/**
 * Turn raw options into a validated plan. `env` decides whether a key is
 * present, which changes what is required.
 */
export function normalizeOptions(raw, env = {}) {
  const o = { ...raw };
  o.api = (o.api || env.LEEVAR_API_URL || DEFAULT_API).trim();
  o.apiKey = (env.LEEVAR_API_KEY || "").trim() || null;
  delete o._positionals;
  o.warnings = [];

  // Legacy form kept so nobody's script breaks: node scan.mjs <email> <agent> <file>
  const pos = raw._positionals ?? [];
  if (pos.length) {
    const legacy = pos.length === 3 && pos[0].includes("@") && !raw.email && !raw.name && raw.transcript.length === 0;
    if (!legacy) {
      throw new UsageError(
        `unexpected argument "${pos[0]}". This client takes flags: --email, --name and --transcript (or --live). ` +
          `The old positional form "node scan.mjs <email> <agent-name> <transcript-file>" still works but is deprecated.`,
      );
    }
    [o.email, o.name] = pos;
    o.transcript = [pos[2]];
    o.warnings.push(
      "positional arguments are deprecated and will be removed in 1.0; use --email, --name and --transcript.",
    );
  }

  if (o.help || o.version) return o;

  if (o.tier !== "scan" && o.tier !== "full") {
    throw new UsageError(`--tier must be "scan" or "full" (got "${o.tier}").`);
  }
  if (o.tier === "full" && !o.apiKey) {
    o.warnings.push("--tier full needs an API key; the free tier is locked to \"scan\" and the server will downgrade this request (api-scan/index.ts:325).");
  }
  if (!/^[A-Za-z0-9._:-]{1,40}$/.test(o.source)) {
    throw new UsageError(`--source must be 1-40 characters of letters, digits, . _ : - (got "${o.source}").`);
  }
  o.threshold = o["fail-below"] === undefined ? null : parseThreshold(o["fail-below"]);
  o.email = o.email === undefined ? null : String(o.email).trim().toLowerCase();
  if (o.email !== null && !o.email.includes("@")) {
    throw new UsageError(`--email "${raw.email}" is not an email address.`);
  }
  if (o.verbose && o.quiet) throw new UsageError("--verbose and --quiet contradict each other; pick one.");
  if (o.interval < 1 && !/^https?:\/\/(127\.0\.0\.1|localhost)/.test(o.api)) {
    o.warnings.push(`--interval ${o.interval}s is below the 1s floor for the public API; using 1s.`);
    o.interval = 1;
  }

  if (o["scan-id"]) {
    o.scanId = String(o["scan-id"]).trim().toUpperCase();
    if (o.transcript.length || o.live || o.header.length || o["no-wait"]) {
      throw new UsageError("--scan-id polls an existing scan; it cannot be combined with --transcript, --live, --header or --no-wait.");
    }
    if (!o.apiKey && !o.email) {
      throw new UsageError(
        "--scan-id on the free tier needs the --email used when the scan was submitted (api-scan/index.ts:222-225); with LEEVAR_API_KEY set, no email is needed.",
      );
    }
    return o;
  }

  const hasTranscript = o.transcript.length > 0;
  if (hasTranscript && o.live) {
    throw new UsageError("pass either --transcript or --live, not both: a scan has one mode.");
  }
  if (!hasTranscript && !o.live) {
    throw new UsageError(
      "nothing to scan. Pass --transcript <file|-> (a conversation sample) or --live <url> (we call your agent). Run --help for examples.",
    );
  }
  if (o.header.length && !o.live) {
    throw new UsageError("--header only applies to --live (it is sent to your endpoint, not to LEEVAR).");
  }
  if (o.live) {
    let u;
    try { u = new URL(o.live); } catch { u = null; }
    if (!u || !/^https?:$/.test(u.protocol)) {
      throw new UsageError(`--live "${o.live}" is not an http(s) URL.`);
    }
    o.liveHeaders = Object.fromEntries(o.header.map(parseHeader));
  }
  o.mode = o.live ? "live" : "transcript";
  if (!o.name || !String(o.name).trim()) {
    throw new UsageError(
      "--name is required: the server files a nameless scan as \"Unnamed agent\" with a 202 (api-scan/index.ts:432), and the record then cannot say what was measured.",
    );
  }
  o.name = String(o.name).trim();
  if (!o.apiKey && !o.email) {
    throw new UsageError(
      `--email is required on the free tier (${FREE_SCANS_PER_MONTH} scans per calendar month per address; the report is delivered there). Set LEEVAR_API_KEY to use a key instead.`,
    );
  }
  return o;
}

/* -------------------------------------------------------------------------- */
/* Inputs and request building                                                */
/* -------------------------------------------------------------------------- */

async function readStdin(stdin) {
  const chunks = [];
  for await (const c of stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

/** Read transcript samples and the optional job spec. Pure file IO, no network. */
export async function loadInputs(o, { stdin = process.stdin } = {}) {
  const inputs = { samples: [], job: null };
  if (o.mode === "transcript") {
    let stdinUsed = false;
    for (const src of o.transcript) {
      let text;
      if (src === "-") {
        if (stdinUsed) throw new UsageError('"--transcript -" (stdin) can be given once.');
        stdinUsed = true;
        text = await readStdin(stdin);
      } else {
        try {
          text = await readFile(src, "utf8");
        } catch (err) {
          throw new UsageError(`could not read transcript "${src}": ${err.code === "ENOENT" ? "no such file" : err.message}.`);
        }
      }
      if (!text.trim()) {
        throw new UsageError(`transcript "${src}" is empty; the server refuses an empty sample with 400 (api-scan/index.ts:439-441), so this was not sent.`);
      }
      inputs.samples.push(text);
    }
  }
  if (o.job) {
    let parsed;
    try {
      parsed = JSON.parse(await readFile(o.job, "utf8"));
    } catch (err) {
      throw new UsageError(`--job "${o.job}": ${err.code === "ENOENT" ? "no such file" : `not valid JSON (${err.message})`}.`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new UsageError(`--job "${o.job}" must be a JSON object: {"description": "...", "must_do": ["..."]}.`);
    }
    if (typeof parsed.description !== "string" || parsed.description.trim().length < 20) {
      throw new UsageError(`--job: "description" must be a string of at least 20 characters (docs/clinic-api.md, Hire Check rules).`);
    }
    if (parsed.must_do !== undefined) {
      if (!Array.isArray(parsed.must_do) || parsed.must_do.length > 8 || !parsed.must_do.every((s) => typeof s === "string")) {
        throw new UsageError(`--job: "must_do" must be an array of up to 8 strings.`);
      }
    }
    inputs.job = parsed;
  }
  return inputs;
}

/** Local pre-flight: the same regex the server applies (probe.ts:36). */
export function toolOutputWarning(samples) {
  const hit = samples.some((s) => TOOL_OUTPUT_RE.test(s));
  if (!hit) return null;
  const max = BATTERY_TESTS - VERIFIED_SOURCE_TESTS;
  return (
    `the transcript contains tool/function output written by the agent itself. In transcript mode the ${VERIFIED_SOURCE_TESTS} verified-source tests ` +
    `are marked NOT TESTED (pipeline.ts:76-90), so at most ${max}/${BATTERY_TESTS} tests can be evidenced — below the ` +
    `${Math.ceil(GRADED_MIN_RATIO * BATTERY_TESTS - 1e-9)}/${BATTERY_TESTS} line — and the letter grade will be withheld. ` +
    `The scan still runs and still spends a free scan. Use --live to have the battery observe tool results itself.`
  );
}

export function userAgent() {
  return `${CLIENT_NAME}/${VERSION} node/${process.versions.node}`;
}

/**
 * Build the create-scan request. NOT sent: `source`. api-scan reads no such
 * field and stamps meta.source="api" itself (api-scan/index.ts:462-477);
 * attribution is recorded locally until the server grows a field for it.
 */
export function buildRequest(o, inputs) {
  const headers = { "content-type": "application/json", "user-agent": userAgent() };
  if (o.apiKey) headers.authorization = `Bearer ${o.apiKey}`; // api-scan/index.ts:111-112
  const agent = { name: o.name };
  if (o.model) agent.model = o.model;
  if (o.type) agent.type = o.type;
  const body = { agent, mode: o.mode };
  if (o.mode === "transcript") body.transcript = inputs.samples;
  else {
    body.endpoint = o.live;
    if (Object.keys(o.liveHeaders ?? {}).length) body.headers = o.liveHeaders;
  }
  if (o.email) body.email = o.email;
  if (o.tier === "full") body.tier = "full"; // api-scan/index.ts:325
  if (inputs.job) body.job = inputs.job;
  return { url: o.api, method: "POST", headers, body };
}

export function buildPollRequest(o, scanId) {
  const headers = { "content-type": "application/json", "user-agent": userAgent() };
  if (o.apiKey) headers.authorization = `Bearer ${o.apiKey}`;
  const body = { scan_id: scanId };
  if (o.email) body.email = o.email; // free-tier ownership, api-scan/index.ts:222-225
  return { url: o.api, method: "POST", headers, body };
}

/** For printing only. The API key and every --header value are replaced. */
export function redactRequest(req) {
  const headers = { ...req.headers };
  if (headers.authorization) {
    const n = req.headers.authorization.replace(/^Bearer\s+/i, "").length;
    headers.authorization = `Bearer ***redacted*** (LEEVAR_API_KEY, ${n} chars)`;
  }
  const body = structuredClone(req.body);
  if (body && body.headers) {
    for (const k of Object.keys(body.headers)) {
      body.headers[k] = `***redacted*** (${String(body.headers[k]).length} chars)`;
    }
  }
  return { ...req, headers, body };
}

/* -------------------------------------------------------------------------- */
/* Transport                                                                  */
/* -------------------------------------------------------------------------- */

export class NetworkError extends Error {}

async function postJson(req, fetchImpl, timeoutMs = 30_000) {
  let res;
  try {
    res = await fetchImpl(req.url, {
      method: "POST",
      headers: req.headers,
      body: JSON.stringify(req.body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const cause = err?.cause?.code || err?.code || err?.name || "";
    throw new NetworkError(`${err?.message ?? err}${cause ? ` (${cause})` : ""}`);
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON body: keep text */ }
  return { httpStatus: res.status, ok: res.ok, json, text };
}

const sleepDefault = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll until a terminal status. 5xx answers are retried until --timeout — the
 * server documents them as "our read failed, change nothing" (api-scan/index.ts
 * 47-52, docs/clinic-api.md:91-99). A 404 is final: re-submitting spends a
 * free scan, which is the exact loop the server warns about.
 */
export async function pollUntilDone(o, scanId, { fetchImpl = fetch, sleep = sleepDefault, now = Date.now, log = () => {} } = {}) {
  const started = now();
  const timeoutMs = o.timeout * 1000;
  const intervalMs = o.interval * 1000;
  let lastStatus = null;
  let netErrors = 0;
  let last = null;
  let lastHeartbeat = started;
  for (;;) {
    let r;
    try {
      r = await postJson(buildPollRequest(o, scanId), fetchImpl);
      netErrors = 0;
    } catch (err) {
      netErrors++;
      if (netErrors >= 5) return { kind: "unreachable", error: err, scanId, elapsedMs: now() - started };
      log(`network error while polling (${err.message}); retrying`);
      r = null;
    }
    if (r) {
      if (r.httpStatus >= 500) {
        last = r;
        log(`server answered HTTP ${r.httpStatus}${r.json?.code ? ` ${r.json.code}` : ""} — a read failed on their side; polling again`);
      } else if (!r.ok) {
        return { kind: "refused", ...r, scanId, elapsedMs: now() - started };
      } else {
        last = r;
        const status = r.json?.status;
        if (typeof status === "string" && TERMINAL_STATUSES.has(status)) {
          return { kind: "done", ...r, scanId, elapsedMs: now() - started };
        }
        if (status !== lastStatus) {
          log(`${status ?? "unknown status"} (${fmtDuration(now() - started)})`);
          lastStatus = status;
          lastHeartbeat = now();
        } else if (now() - lastHeartbeat >= 60_000) {
          log(`still ${status} (${fmtDuration(now() - started)})`);
          lastHeartbeat = now();
        }
      }
    }
    if (now() - started >= timeoutMs) {
      return { kind: "timeout", last, scanId, elapsedMs: now() - started };
    }
    await sleep(intervalMs);
  }
}

/* -------------------------------------------------------------------------- */
/* Classification — one result object feeds every renderer                    */
/* -------------------------------------------------------------------------- */

export function fmtDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h) return `${h}h${String(m % 60).padStart(2, "0")}m`;
  return `${m}m${String(s % 60).padStart(2, "0")}s`;
}

export function maskEmail(e) {
  if (!e) return "";
  const at = e.indexOf("@");
  if (at === -1) return "***";
  return `${e.slice(0, 1)}***@${e.slice(at + 1)}`;
}

export function reportUrl(scanId) {
  return scanId ? `${SITE}/clinic/r/${encodeURIComponent(scanId)}` : `${SITE}/clinic/history`;
}

function evidencedTest(t) {
  return t?.evidence === "sufficient" || t?.evidence === "thin"; // _shared/coverage.ts:77-79
}

function baseResult(o, extra) {
  return {
    ok: false,
    exit_code: EXIT.REFUSED,
    verdict: "refused",
    reason: "",
    scan_id: null,
    status: null,
    grade: null,
    composite: null,
    grade_withheld: null,
    composite_reference: null,
    coverage: null,
    job_fit: null,
    failure: null,
    report_url: null,
    free_scans_remaining_this_month: null,
    threshold: o.threshold ? { kind: o.threshold.kind, label: o.threshold.label } : null,
    fail_on_withheld: Boolean(o["fail-on-withheld"]),
    source: o.source,
    mode: o.mode ?? null,
    agent: o.name ?? null,
    email: o.email ?? null,
    warnings: [...(o.warnings ?? [])],
    server: { http_status: null, error: null, code: null, retryable: null },
    response: null,
    elapsed_ms: null,
    client: { name: CLIENT_NAME, version: VERSION },
    ...extra,
  };
}

/** A non-2xx from the server, on submit or on poll. */
export function classifyRefusal(o, r, { scanId = null, phase = "submit" } = {}) {
  const j = r.json ?? {};
  const msg = typeof j.error === "string" ? j.error : (r.text || "").slice(0, 300) || `HTTP ${r.httpStatus}`;
  const res = baseResult(o, {
    exit_code: EXIT.REFUSED,
    verdict: "refused",
    scan_id: scanId,
    report_url: scanId ? reportUrl(scanId) : null,
    server: { http_status: r.httpStatus, error: msg, code: j.code ?? null, retryable: typeof j.retryable === "boolean" ? j.retryable : null },
    response: r.json ?? r.text ?? null,
  });
  const retry = j.retryable === true ? " The server marks this retryable: retry later, change nothing." : "";
  res.reason = `HTTP ${r.httpStatus}${j.code ? ` ${j.code}` : ""} on ${phase}: ${msg}.${retry}`;
  if (r.httpStatus === 404 && phase === "poll") {
    res.reason += " Do not resubmit: a new submission spends another free scan. Free-tier polls must carry the same --email used at submission.";
  }
  if (r.httpStatus === 429) {
    res.reason += ` The free tier is ${FREE_SCANS_PER_MONTH} scans per email per calendar month and ${FREE_SCANS_PER_IP_PER_DAY} per network per day; CI exhausts that quickly — use an API key (LEEVAR_API_KEY).`;
  }
  return res;
}

export function classifyUnreachable(o, err, { scanId = null } = {}) {
  const res = baseResult(o, {
    exit_code: EXIT.UNREACHABLE,
    verdict: "unreachable",
    scan_id: scanId,
    report_url: scanId ? reportUrl(scanId) : null,
    server: { http_status: null, error: err.message, code: null, retryable: true },
  });
  res.reason = `could not reach ${o.api}: ${err.message}. Check the network or --api; nothing was charged` +
    (scanId ? `. The scan ${scanId} may still complete; resume with --scan-id ${scanId}${o.email ? ` --email ${o.email}` : ""}.` : ".");
  return res;
}

export function classifyTimeout(o, scanId, last, elapsedMs) {
  const res = baseResult(o, {
    exit_code: EXIT.TIMEOUT,
    verdict: "timeout",
    scan_id: scanId,
    status: last?.json?.status ?? null,
    report_url: reportUrl(scanId),
    response: last?.json ?? null,
    elapsed_ms: elapsedMs,
    server: { http_status: last?.httpStatus ?? null, error: null, code: null, retryable: null },
  });
  res.reason = `no result after ${fmtDuration(elapsedMs)} waiting for ${scanId} (last status: ${res.status ?? "none"}). ` +
    `The scan keeps running on the server; resume with --scan-id ${scanId}${o.email ? ` --email ${o.email}` : ""}` +
    (o.email ? ", and the report is also emailed." : ".");
  return res;
}

/** A terminal poll response (delivered / graded / failed). */
export function classifyResult(o, r, { scanId, elapsedMs = null, freeRemaining = null } = {}) {
  const j = r.json ?? {};
  const coverage = j.coverage ?? null;
  const withheld = j.grade_withheld ?? (coverage && coverage.graded === false ? "insufficient_coverage" : null);
  const res = baseResult(o, {
    scan_id: j.scan_id ?? scanId,
    status: j.status ?? null,
    grade: withheld ? null : (j.grade ?? null),
    composite: withheld ? null : (typeof j.composite === "number" ? j.composite : null),
    grade_withheld: withheld,
    composite_reference: typeof j.composite_reference === "number" ? j.composite_reference : null,
    coverage,
    job_fit: j.job_fit ?? null,
    failure: j.failure ?? null,
    report_url: reportUrl(j.scan_id ?? scanId),
    free_scans_remaining_this_month: freeRemaining,
    response: j,
    elapsed_ms: elapsedMs,
    server: { http_status: r.httpStatus, error: null, code: null, retryable: null },
  });

  if (res.status === "failed") {
    const f = res.failure ?? { reason: "unknown", fault: "ours", retryable: true, detail: "no failure detail in the response" };
    res.exit_code = EXIT.SCAN_FAILED;
    res.verdict = "scan_failed";
    res.reason = `${f.reason} (fault: ${f.fault}, retryable: ${f.retryable ? "yes" : "no"}). ${f.detail ?? ""}`.trim() +
      (f.fault === "ours" ? " A failure marked fault:ours does not count against the free allowance (docs/clinic-api.md:82)." : "");
    return res;
  }

  const delivery = res.status === "graded"
    ? " Status is \"graded\": the report exists; email delivery had not completed when polling stopped."
    : "";

  if (withheld) {
    const need = coverage ? Math.ceil(GRADED_MIN_RATIO * coverage.tests_total - 1e-9) : null;
    const cov = coverage ? `${coverage.tests_evidenced}/${coverage.tests_total} tests evidenced${need !== null ? `, ${need} needed` : ""}` : "coverage unknown";
    const ref = res.composite_reference !== null ? ` Reference average over the evidenced tests: ${res.composite_reference} — not a grade; do not gate on it.` : "";
    if (o["fail-on-withheld"]) {
      res.exit_code = EXIT.WITHHELD;
      res.verdict = "withheld";
      res.reason = `grade withheld (${withheld}): ${cov}.${ref} Failing because --fail-on-withheld is set.${delivery}`;
    } else {
      res.ok = true;
      res.exit_code = EXIT.PASS;
      res.verdict = "withheld";
      res.reason = `grade withheld (${withheld}): ${cov}.${ref}` +
        (o.threshold ? ` --fail-below ${o.threshold.label} was NOT evaluated (there is no grade); add --fail-on-withheld to make this fail.` : " Exiting 0 because --fail-on-withheld is not set.") + delivery;
    }
    return res;
  }

  if (res.grade === null && res.composite === null) {
    // Unmeasured: no scores at all. Not "withheld" (coverage.ts:113-119), not a pass.
    res.exit_code = EXIT.SCAN_FAILED;
    res.verdict = "scan_failed";
    res.reason = `the server reported status "${res.status}" but no grade, no composite and no withheld marker — an unmeasured scan. Nothing to gate on.${delivery}`;
    return res;
  }

  if (o.threshold) {
    if (meetsThreshold(o.threshold, res.grade, res.composite)) {
      res.ok = true;
      res.exit_code = EXIT.PASS;
      res.verdict = "pass";
      res.reason = `${describeGrade(res)} meets the threshold ${o.threshold.label}.${delivery}`;
    } else {
      res.exit_code = EXIT.THRESHOLD_NOT_MET;
      res.verdict = "threshold_not_met";
      res.reason = `${describeGrade(res)} is below the threshold ${o.threshold.label}.${delivery}`;
    }
    return res;
  }
  res.ok = true;
  res.exit_code = EXIT.PASS;
  res.verdict = "pass";
  res.reason = `${describeGrade(res)}; no threshold requested (--fail-below sets one).${delivery}`;
  return res;
}

function describeGrade(res) {
  if (res.grade !== null && res.composite !== null) return `grade ${res.grade} (composite ${res.composite})`;
  if (res.grade !== null) return `grade ${res.grade}`;
  return `composite ${res.composite}`;
}

/* -------------------------------------------------------------------------- */
/* Rendering                                                                  */
/* -------------------------------------------------------------------------- */

const ANSI = { reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m" };

export function wantColor({ isTTY = false, env = {}, noColor = false } = {}) {
  if (noColor || env.NO_COLOR !== undefined || env.TERM === "dumb") return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "0") return true;
  return Boolean(isTTY);
}

function paint(color) {
  return color ? (c, s) => `${ANSI[c]}${s}${ANSI.reset}` : (_c, s) => s;
}

function dimensionRows(scores) {
  const rows = [];
  for (const key of Object.keys(DIMENSIONS)) {
    const d = scores?.[key];
    const tests = Array.isArray(d?.tests) ? d.tests : [];
    const evidenced = tests.filter(evidencedTest).length;
    const ourFault = tests.filter((t) => t?.fault === "judge").length;
    rows.push({
      key,
      name: DIMENSIONS[key],
      tested: Boolean(d?.tested),
      score: typeof d?.score === "number" ? d.score : null,
      evidenced,
      total: tests.length,
      ourFault,
    });
  }
  return rows;
}

function verdictColor(res) {
  if (res.verdict === "pass" && res.grade_withheld) return "yellow";
  if (res.verdict === "pass") return "green";
  if (res.verdict === "withheld") return "yellow";
  return "red";
}

export function renderHuman(res, { color = false } = {}) {
  const p = paint(color);
  const out = [];
  const title = res.agent ? `${res.agent} — LEEVAR battery${res.mode ? `, ${res.mode} mode` : ""}` : "LEEVAR battery";
  out.push(p("bold", title));
  if (res.scan_id) {
    out.push(`Scan ${res.scan_id}${res.status ? ` · ${res.status}` : ""}${res.elapsed_ms !== null ? ` in ${fmtDuration(res.elapsed_ms)}` : ""}`);
  }
  out.push("");
  if (res.verdict === "refused" || res.verdict === "unreachable" || res.verdict === "timeout" || res.verdict === "scan_failed") {
    out.push(p(verdictColor(res), `${VERDICT_LABELS[res.verdict] ?? res.verdict}: ${res.reason}`));
  } else {
    if (res.grade_withheld) {
      out.push(p("yellow", `Grade withheld — ${res.grade_withheld.replace("_", " ")}`));
    } else {
      out.push(p("bold", `Grade ${res.grade ?? "—"}${res.composite !== null ? ` (composite ${res.composite})` : ""}`));
    }
    if (res.coverage) {
      const c = res.coverage;
      out.push(`Coverage ${c.tests_evidenced}/${c.tests_total} tests evidenced · ${c.dimensions_tested}/${c.dimensions_total} dimensions${c.tests_our_fault ? ` · ${c.tests_our_fault} ungraded by our judge (not counted)` : ""}`);
    }
    const scores = res.response?.scores;
    if (scores) {
      out.push("");
      for (const r of dimensionRows(scores)) {
        const score = r.score !== null && r.tested ? String(r.score).padStart(5) : "    —";
        const tag = r.tested ? "" : "  NOT TESTED";
        out.push(`  ${r.key}  ${r.name.padEnd(30)}${score}   ${r.evidenced}/${r.total} tests${tag}`);
      }
    }
    if (res.job_fit) {
      const jf = res.job_fit;
      out.push("");
      out.push(`Job-Fit: ${jf.verdict ?? "n/a"}${jf.fit_score !== null && jf.fit_score !== undefined ? ` (fit ${jf.fit_score}` : ""}${jf.requirements_verified !== null && jf.requirements_verified !== undefined ? `, ${jf.requirements_verified}/${jf.requirements_total} requirements verified)` : (jf.fit_score !== null && jf.fit_score !== undefined ? ")" : "")}`);
    }
    out.push("");
    out.push(p(verdictColor(res), `Verdict: ${VERDICT_LABELS[res.verdict] ?? res.verdict} — ${res.reason}`));
  }
  if (res.scan_id && res.verdict !== "refused") {
    out.push("");
    out.push(`Report: ${res.report_url} (opens with the email used)${res.email ? ` · emailed to ${maskEmail(res.email)}` : ""}`);
    if (res.free_scans_remaining_this_month !== null) {
      out.push(`Free tier: ${res.free_scans_remaining_this_month} of ${FREE_SCANS_PER_MONTH} scans left this month for ${maskEmail(res.email)}`);
    }
  }
  for (const w of res.warnings) out.push(p("yellow", `warning: ${w}`));
  return out.join("\n") + "\n";
}

/** Markdown for $GITHUB_STEP_SUMMARY. Emails are masked: run pages can be public. */
export function renderSummary(res) {
  const L = [];
  L.push(`## LEEVAR reliability battery${res.agent ? ` — \`${res.agent}\`` : ""}`);
  L.push("");
  const verdictLabel = VERDICT_LABELS[res.verdict] ?? res.verdict;
  if (res.verdict === "refused" || res.verdict === "unreachable" || res.verdict === "timeout" || res.verdict === "scan_failed") {
    L.push(`**${verdictLabel}** (exit ${res.exit_code}) — ${res.reason}`);
  } else {
    if (res.grade_withheld) {
      L.push(`**Grade: withheld** (${res.grade_withheld.replace("_", " ")}) · verdict: **${verdictLabel}** (exit ${res.exit_code})`);
    } else {
      L.push(`**Grade: ${res.grade ?? "—"}**${res.composite !== null ? ` (composite ${res.composite})` : ""} · verdict: **${verdictLabel}** (exit ${res.exit_code})`);
    }
    L.push("");
    L.push(res.reason);
    if (res.coverage) {
      const c = res.coverage;
      L.push("");
      L.push(`Coverage: ${c.tests_evidenced}/${c.tests_total} tests evidenced · ${c.dimensions_tested}/${c.dimensions_total} dimensions${c.tests_our_fault ? ` · ${c.tests_our_fault} ungraded by the judge (excluded)` : ""}`);
    }
    const scores = res.response?.scores;
    if (scores) {
      L.push("");
      L.push("| Dimension | Score | Evidenced |");
      L.push("|---|---:|---:|");
      for (const r of dimensionRows(scores)) {
        L.push(`| ${r.name} | ${r.tested && r.score !== null ? r.score : "NOT TESTED"} | ${r.evidenced}/${r.total} |`);
      }
    }
    if (res.job_fit) {
      const jf = res.job_fit;
      L.push("");
      L.push(`Job-Fit: **${jf.verdict ?? "n/a"}**${jf.fit_score !== null && jf.fit_score !== undefined ? ` · fit ${jf.fit_score}` : ""}${jf.requirements_verified !== null && jf.requirements_verified !== undefined ? ` · ${jf.requirements_verified}/${jf.requirements_total} requirements verified` : ""}`);
    }
  }
  L.push("");
  const bits = [];
  if (res.scan_id) bits.push(`Scan \`${res.scan_id}\``);
  if (res.mode) bits.push(`${res.mode} mode`);
  if (res.scan_id) bits.push(`[report](${res.report_url}) (opens with the email used)`);
  if (res.email) bits.push(`emailed to ${maskEmail(res.email)}`);
  if (res.free_scans_remaining_this_month !== null) bits.push(`${res.free_scans_remaining_this_month} of ${FREE_SCANS_PER_MONTH} free scans left this month`);
  if (bits.length) L.push(bits.join(" · "));
  for (const w of res.warnings) L.push(`\n> warning: ${w}`);
  L.push("");
  L.push(`<sub>${CLIENT_NAME} ${VERSION} · source \`${res.source}\` (recorded here only; the API has no attribution field yet)</sub>`);
  return L.join("\n") + "\n";
}

/** key=value lines for $GITHUB_OUTPUT. Every value is single-line. */
export function githubOutputLines(res) {
  const one = (v) => (v === null || v === undefined ? "" : String(v).replace(/\r?\n/g, " "));
  return [
    `grade=${one(res.grade)}`,
    `composite=${one(res.composite)}`,
    `withheld=${res.grade_withheld ? "true" : "false"}`,
    `report-url=${one(res.report_url)}`,
    `scan-id=${one(res.scan_id)}`,
    `status=${one(res.status)}`,
    `verdict=${one(res.verdict)}`,
    `exit-code=${one(res.exit_code)}`,
  ].join("\n") + "\n";
}

export function renderJson(res) {
  const { email, ...rest } = res;
  return JSON.stringify({ ...rest, email: email ?? null }, null, 2) + "\n";
}

export function helpText() {
  return `${CLIENT_NAME} ${VERSION} — run the 18-test LEEVAR reliability battery from a terminal or CI

USAGE
  node scan.mjs --email <you@co.com> --name <agent> --transcript <file|->  [options]
  node scan.mjs --email <you@co.com> --name <agent> --live <url> [--header k=v]...  [options]
  node scan.mjs --scan-id <SCN-...> --email <you@co.com>        poll an existing scan

INPUT (exactly one)
  --transcript <file|->   a conversation sample; repeat for several samples, "-" reads stdin
  --live <url>            we call your agent: POST {"input","test","dimension"} per probe
  --header <k=v>          header sent to --live (repeatable; values are never printed)

WHO / WHAT
  --email <addr>          report recipient; required on the free tier (${FREE_SCANS_PER_MONTH} scans/month/email)
  --name <agent>          agent name on the report (required)
  --model <s>, --type <s> optional metadata; --type shapes live-mode scenarios
  --job <file.json>       Hire Check: {"description":">=20 chars","must_do":["...",...]} (max 8)
  --tier <scan|full>      "full" needs an API key; the free tier is locked to "scan"
  --source <tag>          attribution tag (default gh-battery). Recorded locally only — the
                          API has no field for it yet, so nothing is sent

GATE (exit codes)
  --fail-below <grade|n>  exit 1 unless grade >= <grade> (${GRADE_LADDER.slice().reverse().join(" ")}; A- works)
                          or composite >= n
  --fail-on-withheld      exit 2 when the letter is withheld for insufficient coverage

FLOW
  --no-wait               submit, print the scan id, do not poll
  --scan-id <id>          poll only (resume); free-tier polls need the same --email
  --interval <s>          seconds between polls (default 15)
  --timeout <s>           stop waiting after (default 1500 = 25 min); the scan keeps running

OUTPUT
  --json                  machine-readable result on stdout (progress stays on stderr)
  --dry-run               print the request with secrets redacted and exit 0; nothing is sent
  --summary <file>        append a Markdown summary (use "$GITHUB_STEP_SUMMARY")
  --github-output <file>  append grade= composite= withheld= report-url= scan-id= status= lines
  -v, --verbose           show every poll response       -q, --quiet   errors only
  --no-color              plain output (also NO_COLOR, or automatically when piped)
  --api <url>             API base URL override (also LEEVAR_API_URL)
  -h, --help              this text                      --version     print ${VERSION}

ENVIRONMENT
  LEEVAR_API_KEY   sent as "Authorization: Bearer"; never printed. Without it: free tier, --email required
  LEEVAR_API_URL   same as --api          NO_COLOR   disable colour

EXIT CODES
  0  pass (or no gate requested)          1  below --fail-below
  2  grade withheld (--fail-on-withheld)  3  request refused by the server; its message is printed
  4  usage error                          5  scan ran but failed server-side (fault "ours" = credited back)
  6  timed out waiting (resume with --scan-id)   7  could not reach the API

EXAMPLES
  node scan.mjs --email you@co.com --name support-bot --transcript ./samples/refund.txt --fail-below B+
  cat thread.txt | node scan.mjs --email you@co.com --name support-bot --transcript - --json
  LEEVAR_API_KEY=... node scan.mjs --name support-bot --live https://bot.example.com/chat \\
      --header "x-api-key=$BOT_KEY" --fail-below 88 --fail-on-withheld
  node scan.mjs --email you@co.com --name support-bot --transcript ./t.txt --dry-run
  node scan.mjs --scan-id SCN-2026-1234 --email you@co.com

FREE TIER
  ${FREE_SCANS_PER_MONTH} scans per calendar month per email, ${FREE_SCANS_PER_IP_PER_DAY} per network per day, and a global daily cap.
  A transcript containing tool output the agent wrote itself can evidence at most
  ${BATTERY_TESTS - VERIFIED_SOURCE_TESTS} of ${BATTERY_TESTS} tests, below the ${Math.ceil(GRADED_MIN_RATIO * BATTERY_TESTS - 1e-9)}-of-${BATTERY_TESTS} line: the letter is withheld. Use --live for those.
`;
}

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

async function writeArtifacts(o, res, stderr) {
  if (o.summary) {
    try { await appendFile(o.summary, renderSummary(res)); } catch (err) { stderr.write(`warning: could not write --summary ${o.summary}: ${err.message}\n`); }
  }
  if (o["github-output"]) {
    try { await appendFile(o["github-output"], githubOutputLines(res)); } catch (err) { stderr.write(`warning: could not write --github-output ${o["github-output"]}: ${err.message}\n`); }
  }
}

export let currentScan = null;

/**
 * Run the CLI. Returns the exit code; never calls process.exit itself so tests
 * can drive it in-process. `io` lets tests swap streams, fetch and clocks.
 */
export async function main(argv, io = {}) {
  const env = io.env ?? process.env;
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const stdin = io.stdin ?? process.stdin;
  const fetchImpl = io.fetch ?? fetch;
  const sleep = io.sleep ?? sleepDefault;
  const now = io.now ?? Date.now;

  let o;
  try {
    o = normalizeOptions(parseArgs(argv), env);
  } catch (err) {
    if (err instanceof UsageError) {
      stderr.write(`error: ${err.message}\n`);
      return EXIT.USAGE;
    }
    throw err;
  }
  if (o.help) { stdout.write(helpText()); return EXIT.PASS; }
  if (o.version) { stdout.write(`${VERSION}\n`); return EXIT.PASS; }

  const color = wantColor({ isTTY: stdout.isTTY, env, noColor: o["no-color"] || o.json });
  const p = paint(color);
  const log = (msg) => { if (!o.quiet) stderr.write(`${p("dim", "[leevar]")} ${msg}\n`); };
  const warn = (msg) => { if (!o.quiet) stderr.write(`${p("yellow", "warning:")} ${msg}\n`); };
  for (const w of o.warnings) warn(w);

  const emit = (res) => {
    if (o.json) stdout.write(renderJson(res));
    else if (!o.quiet) stdout.write(renderHuman(res, { color }));
    else if (res.exit_code !== EXIT.PASS) stderr.write(`${VERDICT_LABELS[res.verdict] ?? res.verdict}: ${res.reason}\n`);
  };
  const finish = async (res) => {
    await writeArtifacts(o, res, stderr);
    emit(res);
    return res.exit_code;
  };

  /* ---- poll an existing scan -------------------------------------------- */
  if (o.scanId) {
    currentScan = { scanId: o.scanId, email: o.email };
    log(`polling ${o.scanId} every ${o.interval}s (timeout ${fmtDuration(o.timeout * 1000)})`);
    const out = await pollUntilDone(o, o.scanId, { fetchImpl, sleep, now, log: o.verbose ? (m) => log(m) : log });
    if (o.verbose && out.json) log(`last response: ${JSON.stringify(out.json)}`);
    if (out.kind === "done") return finish(classifyResult(o, out, { scanId: o.scanId, elapsedMs: out.elapsedMs }));
    if (out.kind === "refused") return finish(classifyRefusal(o, out, { scanId: o.scanId, phase: "poll" }));
    if (out.kind === "unreachable") return finish(classifyUnreachable(o, out.error, { scanId: o.scanId }));
    return finish(classifyTimeout(o, o.scanId, out.last, out.elapsedMs));
  }

  /* ---- submit ------------------------------------------------------------ */
  let inputs;
  try {
    inputs = await loadInputs(o, { stdin });
  } catch (err) {
    if (err instanceof UsageError) { stderr.write(`error: ${err.message}\n`); return EXIT.USAGE; }
    throw err;
  }
  const preflight = o.mode === "transcript" ? toolOutputWarning(inputs.samples) : null;
  if (preflight) { o.warnings.push(preflight); warn(preflight); }
  const req = buildRequest(o, inputs);

  if (o["dry-run"]) {
    const shown = redactRequest(req);
    if (o.json) {
      stdout.write(JSON.stringify({ dry_run: true, request: shown, source: o.source, warnings: o.warnings, client: { name: CLIENT_NAME, version: VERSION } }, null, 2) + "\n");
    } else {
      stdout.write(`${p("bold", "dry run — nothing was sent")}\n${shown.method} ${shown.url}\n`);
      for (const [k, v] of Object.entries(shown.headers)) stdout.write(`  ${k}: ${v}\n`);
      stdout.write(`\n${JSON.stringify(shown.body, null, 2)}\n`);
      stdout.write(`\n${o.apiKey ? "tier: keyed (LEEVAR_API_KEY present)" : `tier: free — this would spend 1 of ${FREE_SCANS_PER_MONTH} scans this month for ${maskEmail(o.email)}`}\n`);
      stdout.write(`source tag "${o.source}" is not sent: the API has no attribution field yet.\n`);
    }
    return EXIT.PASS;
  }

  if (!o.apiKey) log(`free tier: this spends 1 of ${FREE_SCANS_PER_MONTH} scans this month for ${maskEmail(o.email)}`);
  log(`submitting ${o.mode} scan for "${o.name}" to ${o.api}`);
  let sub;
  try {
    sub = await postJson(req, fetchImpl);
  } catch (err) {
    return finish(classifyUnreachable(o, err));
  }
  if (!sub.ok || !sub.json?.scan_id) {
    if (sub.ok) {
      sub = { ...sub, httpStatus: sub.httpStatus, json: { error: `unexpected ${sub.httpStatus} response without a scan_id: ${sub.text.slice(0, 200)}` } };
    }
    return finish(classifyRefusal(o, sub, { phase: "submit" }));
  }
  const scanId = String(sub.json.scan_id);
  const freeRemaining = typeof sub.json.free_scans_remaining_this_month === "number" ? sub.json.free_scans_remaining_this_month : null;
  currentScan = { scanId, email: o.email };
  log(`submitted ${scanId}${freeRemaining !== null ? ` · ${freeRemaining} free scans left this month` : ""}`);
  if (o.verbose) log(`submit response: ${JSON.stringify(sub.json)}`);

  if (o["no-wait"]) {
    const res = baseResult(o, {
      ok: true,
      exit_code: EXIT.PASS,
      verdict: "submitted",
      scan_id: scanId,
      status: sub.json.status ?? "queued",
      report_url: reportUrl(scanId),
      free_scans_remaining_this_month: freeRemaining,
      response: sub.json,
      server: { http_status: sub.httpStatus, error: null, code: null, retryable: null },
      reason: `submitted; not waiting. Poll with --scan-id ${scanId}${o.email ? ` --email ${o.email}` : ""}${o.email ? "; the report is also emailed" : ""}.`,
    });
    if (o.json) stdout.write(renderJson(res));
    else if (!o.quiet) stdout.write(`${scanId}\n${res.reason}\nReport: ${res.report_url} (opens with the email used)\n`);
    await writeArtifacts(o, res, stderr);
    return EXIT.PASS;
  }

  log(`polling every ${o.interval}s (timeout ${fmtDuration(o.timeout * 1000)})`);
  const out = await pollUntilDone(o, scanId, { fetchImpl, sleep, now, log });
  if (o.verbose && out.json) log(`last response: ${JSON.stringify(out.json)}`);
  if (out.kind === "done") return finish(classifyResult(o, out, { scanId, elapsedMs: out.elapsedMs, freeRemaining }));
  if (out.kind === "refused") return finish(classifyRefusal(o, out, { scanId, phase: "poll" }));
  if (out.kind === "unreachable") return finish(classifyUnreachable(o, out.error, { scanId }));
  return finish(classifyTimeout(o, scanId, out.last, out.elapsedMs));
}

/* ---- CLI entry (skipped when imported by tests) --------------------------- */
function isCliEntry() {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isCliEntry()) {
  process.once("SIGINT", () => {
    if (currentScan?.scanId) {
      process.stderr.write(
        `\ninterrupted. ${currentScan.scanId} keeps running on the server; resume with --scan-id ${currentScan.scanId}${currentScan.email ? ` --email ${currentScan.email}` : ""}.\n`,
      );
    }
    process.exit(130);
  });
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (err) => {
      process.stderr.write(`error: ${err?.stack ?? err}\n`);
      process.exitCode = EXIT.USAGE;
    },
  );
}
