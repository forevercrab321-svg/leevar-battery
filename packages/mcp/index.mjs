#!/usr/bin/env node
// leevar-mcp — the LEEVAR reliability battery as an MCP server.
//
// Three tools:
//   leevar_scan_transcript  send conversation samples to the hosted battery
//                           (free: 5 scans a month per email, no account)
//   leevar_scan_status      read a scan's result: grade, coverage, report
//   leevar_battery          the 18 tests, so an agent can write samples that
//                           actually exercise them
//
// What it does NOT do: it does not grade anything itself, and it never invents
// a score. A scan whose samples cannot evidence enough of the battery comes
// back without a grade, and this server says so rather than filling the gap.
//
// Privacy: samples you send go to LEEVAR's hosted service, are graded there by
// third-party language models (named at https://www.leevar.live/privacy), and
// are deleted 30 days after the scan completes.
// Strip API keys, credentials and personal data first.

import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

export const API_URL = process.env.LEEVAR_API_URL ??
  "https://rzmsvvalhaqvxbuhpdnb.supabase.co/functions/v1/api-scan";

const here = dirname(fileURLToPath(import.meta.url));
const BATTERY = JSON.parse(readFileSync(join(here, "battery.json"), "utf8"));

const REPORT_CHARS = 12_000;

/** One call to the hosted API. Returns the parsed body and the status; never
 * throws on a 4xx/5xx — the caller turns those into a clear tool error. */
async function call(body, fetchImpl) {
  let res;
  try {
    res = await fetchImpl(API_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "leevar-mcp/0.1.0" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    return { ok: false, status: 0, body: { error: `could not reach LEEVAR: ${String(err?.message ?? err)}` } };
  }
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { ok: res.ok, status: res.status, body: json ?? {} };
}

const text = (s) => ({ content: [{ type: "text", text: s }] });
const fail = (s) => ({ content: [{ type: "text", text: s }], isError: true });

function describeError(r) {
  const b = r.body ?? {};
  const parts = [`LEEVAR answered HTTP ${r.status || "(no response)"}`];
  if (b.error) parts.push(String(b.error));
  if (b.code) parts.push(`code: ${b.code}`);
  if (b.retryable === true) parts.push("This is on LEEVAR's side and is safe to retry.");
  if (b.correlation_id) parts.push(`correlation id: ${b.correlation_id}`);
  return parts.join(" — ");
}

/** A result as a reader should take it. The grade is printed only when the
 * battery issued one; otherwise the reason it did not is the headline. */
export function summarize(b) {
  const lines = [];
  const status = String(b.status ?? "unknown");
  lines.push(`Scan ${b.scan_id ?? ""} — status: ${status}`.trim());
  if (status === "queued" || status === "running") {
    lines.push("Not finished yet. Scans usually take a few minutes; ask again with leevar_scan_status.");
    return lines.join("\n");
  }
  if (status === "failed") {
    const f = b.failure ?? {};
    lines.push(`Failed: ${f.reason ?? "unknown reason"} (fault: ${f.fault ?? "unknown"}).`);
    if (f.detail) lines.push(String(f.detail));
    lines.push(
      f.retryable
        ? "Retryable. If the fault is LEEVAR's, the free scan is credited back."
        : "Not retryable as sent — fix the input first.",
    );
    return lines.join("\n");
  }
  const c = b.coverage ?? {};
  if (c.tests_total !== undefined) {
    lines.push(
      `Coverage: ${c.tests_evidenced ?? "?"} of ${c.tests_total} tests evidenced; ` +
        `${c.dimensions_tested ?? "?"} of ${c.dimensions_total ?? "?"} dimensions tested` +
        (c.tests_our_fault ? `; ${c.tests_our_fault} not graded because of LEEVAR's own judge` : "") + ".",
    );
  }
  if (b.grade && c.graded !== false) {
    lines.push(`Grade: ${b.grade} (composite ${b.composite}).`);
  } else {
    lines.push(
      "No grade issued: the samples did not evidence enough of the battery to grade honestly. " +
        "Dimensions without evidence are NOT TESTED, not passed. Send longer, real conversations " +
        "that exercise the missing behaviours (a long thread, a repeated task, a tool failure).",
    );
    if (b.composite_reference !== undefined && b.composite_reference !== null) {
      lines.push(`Reference average over the evidenced tests only: ${b.composite_reference} — not a verdict.`);
    }
  }
  if (b.report_md) {
    const r = String(b.report_md);
    lines.push("", r.length > REPORT_CHARS ? r.slice(0, REPORT_CHARS) + "\n\n[report truncated]" : r);
  }
  return lines.join("\n");
}

export function createServer({ fetchImpl = fetch } = {}) {
  const server = new McpServer({ name: "leevar", version: "0.1.0" });

  server.registerTool(
    "leevar_scan_transcript",
    {
      title: "Scan an AI agent's transcripts",
      description:
        "Send real conversation samples from an AI agent to the LEEVAR reliability battery " +
        "(18 tests, 6 dimensions). Free: 5 scans a month per email, no account. Returns a scan id; " +
        "the result takes a few minutes — read it with leevar_scan_status. Dimensions the samples " +
        "cannot evidence come back NOT TESTED, and with fewer than two thirds of the gradeable tests " +
        "evidenced no grade is issued. Samples go to LEEVAR's hosted service, are graded there by " +
        "third-party language models (named at https://www.leevar.live/privacy), and are deleted 30 days " +
        "after the scan; strip keys, credentials and personal data first. Each scan uses one of the " +
        "email's 5 free monthly scans. Ask the user before sending their data.",
      inputSchema: {
        agent_name: z.string().min(1).max(120).describe("Name of the agent being graded"),
        email: z.string().email().describe("Where the report goes; also the free-quota key and needed to read the result"),
        transcripts: z.array(z.string().min(1)).min(1).max(8)
          .describe("1–8 real conversation samples, e.g. 'User: …\\nAgent: …'. More, longer samples evidence more tests."),
        agent_type: z.string().max(80).optional().describe("e.g. Customer support, Coding, Research"),
        model: z.string().max(80).optional().describe("Model class the agent runs on"),
        description: z.string().max(500).optional().describe("What the agent does, in a sentence or two"),
      },
      // Not read-only: it spends one of the email's free scans and sends data
      // to a third-party service.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      const r = await call({
        agent: {
          name: args.agent_name,
          ...(args.model ? { model: args.model } : {}),
          ...(args.agent_type ? { type: args.agent_type } : {}),
          ...(args.description ? { description: args.description } : {}),
        },
        mode: "transcript",
        transcript: args.transcripts,
        email: args.email,
      }, fetchImpl);
      if (!r.ok || !r.body?.scan_id) return fail(describeError(r));
      return text(
        `Queued as ${r.body.scan_id}. The report is also emailed to ${args.email}.\n` +
          `Read the result with leevar_scan_status (scan_id: ${r.body.scan_id}, same email).`,
      );
    },
  );

  server.registerTool(
    "leevar_scan_status",
    {
      title: "Read a LEEVAR scan result",
      description:
        "Read the result of a scan started with leevar_scan_transcript: status, grade (only when one " +
        "was issued), coverage, and the written report. A missing grade means the evidence was too " +
        "thin to grade — never treat it as a pass.",
      inputSchema: {
        scan_id: z.string().min(3).max(60).describe("e.g. SCN-2026-1234"),
        email: z.string().email().describe("The email the scan was created with"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      const r = await call({ scan_id: args.scan_id, email: args.email }, fetchImpl);
      if (!r.ok) return fail(describeError(r));
      return text(summarize({ scan_id: args.scan_id, ...r.body }));
    },
  );

  server.registerTool(
    "leevar_battery",
    {
      title: "List the 18 reliability tests",
      description:
        "The LEEVAR battery: 6 dimensions × 3 tests, what each test checks and the failure it catches. " +
        "Use it to pick conversation samples that exercise every test before scanning.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const lines = [`Battery ${BATTERY.battery_id}`];
      for (const d of BATTERY.dimensions) {
        lines.push("", `## ${d.name} (${d.key})`);
        for (const t of d.tests) {
          lines.push(
            `- ${t.name}${t.needs_verified_source ? " (needs a verified source)" : ""}: ${t.checks} Catches: ${t.catches}.`,
          );
        }
      }
      return text(lines.join("\n"));
    },
  );

  return server;
}

// Run as a stdio server when executed directly (npx leevar-mcp runs it through
// a bin symlink, hence realpath). Imported by the tests, it only exports.
function isMain() {
  try {
    return realpathSync(process.argv[1] ?? "") === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}
if (isMain()) {
  await createServer().connect(new StdioServerTransport());
}
