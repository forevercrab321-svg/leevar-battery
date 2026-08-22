#!/usr/bin/env node
// Zero dependencies. Submits one transcript to the free tier and polls.
//
//   node scan.mjs you@example.com my-agent ./transcript.txt
//
// 5 free scans a month, per email, no account and no API key. A thin sample
// does not produce a generous score — it produces NOT TESTED on the dimensions
// it could not evidence, and those do not clear the gate.

const API = "https://rzmsvvalhaqvxbuhpdnb.supabase.co/functions/v1/api-scan";
const [email, agent, file] = process.argv.slice(2);
if (!email || !agent || !file) {
  console.error("usage: node scan.mjs <email> <agent-name> <transcript-file>");
  process.exit(2);
}
const transcript = await (await import("node:fs/promises")).readFile(file, "utf8");

const res = await fetch(API, {
  method: "POST",
  headers: { "content-type": "application/json" },
  // `agent` is an OBJECT, not a string. api-scan reads `body.agent.name`
  // (api-scan/index.ts:399) and falls back to the literal "Unnamed agent" when
  // it is missing — silently, with a 202. Sending a bare string therefore files
  // a scan that works and is anonymous, which is the worst of both: the caller
  // sees success and the record cannot say what was measured.
  body: JSON.stringify({
    agent: { name: agent },
    mode: "transcript",
    email,
    transcript: [transcript],
  }),
});

// A non-2xx is not an empty result. Printing "no findings" for an HTTP 429 is
// the single most repeated defect we grade other agents on; this client is not
// going to ship it.
const body = await res.text();
if (!res.ok) {
  console.error(`api-scan returned HTTP ${res.status}`);
  console.error(body);
  process.exit(1);
}
console.log(body);
console.log("\nYour report is emailed when the battery finishes. History: https://leevar.live/clinic/history");
