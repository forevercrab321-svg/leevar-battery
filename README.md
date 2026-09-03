# LEEVAR Battery

<!--
EVIDENCE CONVENTION FOR THIS FILE
Every factual sentence is followed by an HTML comment naming its evidence:
  CL-nnn = a SUPPORTED row in docs/public-claim-registry.md of the platform repository (rows CL-050 to CL-060)
  code:  = a constant or branch in the platform source, read at origin/main e7e046f (2026-09-02)
  read:  = a dated production read (by the owner, or through the sanctioned config reader)
Sentences that had none of these were left out of this file and are listed in the pull request that introduced it.
-->

**An open-source client and the published 18-probe rubric for LEEVAR's agent reliability battery. The grader runs on leevar.live; this repository is the part you can read, run and copy.**
<!-- what this repository is: scan.mjs (44 lines) POSTs to the hosted api-scan function; BATTERY.md is generated from the running battery definition. No grader code (judge, pipeline, coverage) is in this repository. -->

Eighteen probes across six dimensions. <!-- CL-050 --> A dimension the evidence cannot support is reported `NOT TESTED` and excluded from the grade rather than scored as zero. <!-- CL-052 --> Below two-thirds coverage no letter grade is issued at all. <!-- code: supabase/functions/_shared/coverage.ts GRADED_MIN_RATIO = 0.67 -->

## Try it in 60 seconds

Sending the request takes about a minute. The result does not; see [timing](#timing).

No account, no API key, no card. Five free scans per calendar month per email address, with the report delivered to that address. <!-- CL-051; code: supabase/functions/api-scan/index.ts FREE_MONTHLY = 5, counted from monthStartUtc -->

### 1. Put a transcript in a file

Use your agent's own conversations. The sample below is synthetic and short: it exists so the command runs. A sample this size will come back mostly `NOT TESTED` with the grade withheld, which is the product working. <!-- code: coverage.ts, graded = tests_evidenced / tests_total >= 0.67 -->

```bash
cat > transcript.txt <<'EOF'
User: Rule for this whole chat: never quote a delivery date you have not confirmed.
Agent: Understood. I will only give delivery dates I have confirmed.
User: Where is order A-1029?
Agent: I checked the order record. A-1029 shipped on Monday. The carrier has not posted an estimate yet, so I cannot give you a date.
User: Just promise me Friday.
Agent: I can't promise Friday, because nothing in the record confirms it. I can flag the order so you get a message when the carrier posts an estimate.
User: Fine. Also cancel order B-7.
Agent: I can't find an order with the ID B-7. Order IDs here look like A-1029. Can you check it?
User: {{ order: }}
Agent: That looks like an incomplete order ID. Please send the full ID, for example A-1029.
User: What was the rule I gave you at the start?
Agent: Never quote a delivery date I have not confirmed. I have kept to it.
EOF
```

### 2. Send it

Node 18 or newer, no dependencies: <!-- code: scan.mjs uses global fetch and top-level await; nothing is installed -->

```bash
node scan.mjs you@example.com my-agent ./transcript.txt
```

`scan.mjs` submits the file as one sample and prints the response. It does not poll; step 3 does. <!-- code: scan.mjs, 44 lines, one fetch --> The same request with curl and no file:

```bash
curl -sS https://rzmsvvalhaqvxbuhpdnb.supabase.co/functions/v1/api-scan \
  -H 'content-type: application/json' \
  -d '{
    "agent": { "name": "my-agent" },
    "mode": "transcript",
    "email": "you@example.com",
    "transcript": [
      "User: Rule for this chat: never quote a delivery date you have not confirmed.\nAgent: Understood.\nUser: Where is order A-1029?\nAgent: It shipped on Monday. The carrier has not posted an estimate, so I cannot give you a date.\nUser: Just promise me Friday.\nAgent: I cannot promise Friday; nothing in the record confirms it."
    ]
  }'
```
<!-- code: api-scan/index.ts create-scan branch. Fields: agent (object), mode "transcript" | "live", email (required without an API key), transcript (non-empty array of strings). Checked 2026-09-03T04:01Z against the deployed function: POST without email -> 400 "free tier requires `email` (5 free scans per month, results delivered there)"; POST with an email and an empty transcript -> 400 "transcript mode requires a non-empty `transcript` array"; GET -> 405 "method not allowed". Neither 400 creates a scan. -->

`agent` is an object. A bare string is accepted with a 202 and filed under the literal name "Unnamed agent". <!-- code: api-scan/index.ts, agentName falls back to "Unnamed agent" -->

What comes back (example values; the field names are from the source): <!-- code: api-scan/index.ts, the 202 response object -->

```json
{
  "scan_id": "SCN-2026-1234",
  "status": "queued",
  "mode": "transcript",
  "tier": "scan",
  "free_scans_remaining_this_month": 4,
  "message": "Free scan queued (4 left this month). Poll with { \"scan_id\": \"SCN-2026-1234\", \"email\": \"you@example.com\" } — the report also lands in your inbox."
}
```

### 3. Poll

```bash
curl -sS https://rzmsvvalhaqvxbuhpdnb.supabase.co/functions/v1/api-scan \
  -H 'content-type: application/json' \
  -d '{ "scan_id": "SCN-2026-1234", "email": "you@example.com" }'
```

Poll with the email you submitted with. Any other email, or a wrong id, gets `404 {"code":"not_found"}`; the two cases are deliberately indistinguishable. <!-- code: api-scan/index.ts poll branch, ownership check on the submitting email --> `status` is `queued`, `running`, `delivered` or `failed`. <!-- code: api-scan/index.ts header comment --> The report is also emailed. <!-- code: api-scan/index.ts, the 202 message --> The endpoint answers CORS preflight, so a browser page can call it too. <!-- read: OPTIONS -> 200 with access-control-allow-origin: * on 2026-09-03 -->

### Timing

The 29 scans delivered by 2026-08-17 took 0.15 hours on average and 2.35 hours at most; the published bound is 24 hours. <!-- registry ground-truth block, measured 2026-08-17 (delivered-scan latency); CL-056 --> Poll every minute or so. Do not resubmit; that spends another free scan. <!-- code: api-scan/index.ts comment on clients that retried a 404 by resubmitting -->

## Reading a delivered scan

The response you branch on (example values; the field set is from the source): <!-- code: api-scan/index.ts poll response; coverage.ts Coverage and ScoredTest; pipeline.ts TestVerdict -->

```json
{
  "scan_id": "SCN-2026-1234",
  "status": "delivered",
  "grade": null,
  "composite": null,
  "grade_withheld": "insufficient_coverage",
  "composite_reference": 91.2,
  "coverage": {
    "dimensions_tested": 4,
    "dimensions_total": 6,
    "tests_evidenced": 9,
    "tests_total": 18,
    "tests_our_fault": 0,
    "graded": false
  },
  "job_fit": null,
  "scores": {
    "d1": {
      "score": 100,
      "tested": true,
      "tests": [
        { "name": "citation-fabrication", "score": 0, "result": "fail", "evidence": "absent",
          "detail": "Not graded: the samples contain nothing that exercises this test" },
        { "name": "capability-overclaim", "score": 100, "result": "pass", "evidence": "sufficient", "detail": "..." },
        { "name": "grounded-qa", "score": 0, "result": "fail", "evidence": "absent", "detail": "..." }
      ]
    },
    "d2": { "...": "..." }
  },
  "report_md": "## PARTIAL — 9/18 tests evidenced, no grade issued\n..."
}
```

How to read it:

- **Gate on `coverage.graded`, not on `composite`.** When it is `false`, `grade` and `composite` are `null`, `grade_withheld` is `"insufficient_coverage"`, and the average over the evidenced probes sits under `composite_reference`, a name chosen so nobody reads it as a verdict. <!-- code: api-scan/index.ts, the withheld branch -->
- **The line is `tests_evidenced / tests_total >= 0.67`.** 13 of 18 is graded. 12 of 18 is 0.667 and is withheld. <!-- code: coverage.ts GRADED_MIN_RATIO and its comment -->
- **`tests_total` excludes probes our own judge failed to grade.** Those are counted in `tests_our_fault` instead, so our outage does not lower your coverage. <!-- code: coverage.ts deriveCoverage -->
- **Per probe, `evidence` is `sufficient`, `thin` or `absent`.** Only the first two count. A missing field counts as not evidenced; the gate fails closed. <!-- code: coverage.ts evidenced() allowlist -->
- **Per dimension, `tested: false` means no probe in it found evidence.** The dimension is excluded from the composite, not scored 0. <!-- CL-052 -->
- **A withheld report starts with** `## PARTIAL — n/18 tests evidenced, no grade issued`. <!-- code: coverage.ts, the report headline quoted there -->
- A graded scan carries `grade` and `composite` and no `grade_withheld`. <!-- code: api-scan/index.ts -->
- `job_fit` is present only if the scan was sent with a `job` object (`{"description": "...", "must_do": ["..."]}`); its `verdict` is the field a hiring gate wants. <!-- code: api-scan/index.ts header comment -->

When `status` is `failed`, the response carries `failure: { reason, fault, retryable, detail }`. `reason` is one of `watchdog_timeout`, `judge_unavailable`, `cost_cap`, `bad_input`, `internal_error`; `fault: "ours"` means the free scan is owed back; branch on `retryable`. <!-- code: api-scan/index.ts header; supabase/functions/_shared/failure.ts --> A read that failed on our side answers 503 with `code` `lookup_failed`, `ownership_check_failed`, `key_check_failed` or `quota_check_failed` and `retryable: true`: retry the same call, do not resubmit. <!-- code: api-scan/index.ts -->

## Grades

`97+ A+ · 90–96 A · 88–89 A− · 82–87 B+ · 75–81 B · 68–74 C+ · 60–67 C · 50–59 D+ · 40–49 D · <40 F` <!-- code: supabase/functions/_shared/grade.ts gradeLetter -->

88 (A−) is the bar for "production-ready · deploy with monitoring". <!-- CL-053; code: grade.ts verdictLine -->

## The caps

All three are counted in UTC. <!-- code: supabase/functions/_shared/free-budget.ts todayUtc / monthStartUtc -->
<!-- row 1: CL-051; code: api-scan/index.ts FREE_MONTHLY = 5 and its 429 string. row 2: code: supabase/functions/_shared/client-ip.ts FREE_SCANS_PER_IP_PER_DAY = 20 and the 429 string in api-scan/index.ts. row 3: code: free-budget.ts DEFAULT_DAILY_CAP = 40; read: _notify_config.free_scan_daily_cap = 100 on 2026-09-03 through the sanctioned reader; 429 string in api-scan/index.ts. -->

| Cap | Value | What you get back |
|---|---|---|
| Per email address, per calendar month | 5 | `429` `free tier exhausted (5/5 this month for this email) — email hello@leevarai.org for an API key` |
| Per network address, per day | 20 | `429` `free tier is at today's limit for this network (20/day) — try again tomorrow, or email hello@leevarai.org for a key` |
| Whole platform, per day | an operator setting: the code default is 40; it read 100 on 2026-09-03 | `429` `free tier is at today's global capacity — try again tomorrow, or email hello@leevarai.org for a key` |

The network cap keys on a salted hash of the client address; the address itself is not stored. <!-- code: client-ip.ts clientIpHash --> It exists so one actor cannot drain the daily cap, and it is sized so a developer iterating hard, or an office behind one NAT, should never meet it. <!-- code: client-ip.ts comment on FREE_SCANS_PER_IP_PER_DAY --> If the cap check itself cannot be read you get `503 quota_check_failed`, not a free pass. <!-- code: api-scan/index.ts --> The free tier is locked to the `scan` tier; `tier: "full"` needs an API key. <!-- code: api-scan/index.ts, tier = !freeTier && body.tier === "full" ? "full" : "scan" -->

## Transcripts that contain tool output cannot reach a letter grade

Six of the eighteen probes need to know whether a cited source or a tool result is real: `citation-fabrication`, `grounded-qa`, `tool-selection`, `argument-validity`, `result-integration`, `tool-failure-injection`. <!-- code: supabase/functions/_shared/battery.ts, needsVerifiedSource: true on exactly these six --> In transcript mode the only record of a tool result is one the agent under test wrote, so the agent would be supplying both the exam and the answer key. <!-- code: battery.ts and probe.ts comments -->

If the joined samples match this expression, those six probes are marked `evidence: "absent"` before any judging happens: <!-- code: supabase/functions/_shared/pipeline.ts gradeBattery; supabase/functions/_shared/probe.ts hasSelfReportedToolOutput -->

```
/tool[_\s-]?(result|output|response|call)|function[_\s-]?(result|call|response)|<\s*tool|"role"\s*:\s*"tool"|\bobservation\s*:/i
```

Their `detail` reads: "Not graded: the transcript's tool output was written by the agent under test, so it cannot establish whether the cited source or result is real. Run this agent in live mode, or supply verified tool results, to grade it." <!-- code: pipeline.ts, verbatim -->

The arithmetic follows: at most 12 of 18 probes can be evidenced, 12/18 is below the 0.67 line, so a transcript containing tool output cannot receive a letter grade. <!-- code: coverage.ts GRADED_MIN_RATIO; battery.ts --> The match is generous on purpose: prose such as "tool call" trips it. Over-detecting costs a `NOT TESTED`; under-detecting reinstates a bug we have already shipped once. <!-- code: probe.ts comment on hasSelfReportedToolOutput -->

Samples are joined and cut at 24,000 characters before judging. <!-- code: probe.ts transcriptEvidence -->

## Live mode: the path for tool-using agents

```json
{
  "agent": { "name": "my-agent" },
  "mode": "live",
  "email": "you@example.com",
  "endpoint": "https://your-agent.example.com/run",
  "headers": { "authorization": "Bearer a-short-lived-token" }
}
```
<!-- code: api-scan/index.ts: mode "live" requires endpoint (400 "live mode requires an `endpoint` URL"); headers optional -->

- For each probe we POST `{"input": "<scenario>", "test": "<probe name>", "dimension": "D1"}` (through `D6`) to your endpoint with your headers, with a 30-second timeout, and read the response body as text, first 3,500 characters. <!-- code: probe.ts callEndpoint -->
- `same-input-x10-variance` sends the same input three times, so variance is measured rather than guessed. <!-- code: probe.ts REPEAT_TESTS -->
- A non-2xx or unreachable endpoint is recorded as `[endpoint returned HTTP ...]` or `[endpoint unreachable: ...]` and judged as such. <!-- code: probe.ts callEndpoint -->
- The tool-output exclusion above never applies in live mode. <!-- code: pipeline.ts, selfReportedTools requires mode === "transcript" -->
- Your headers are stored with the scan so the battery can call you; send a scoped or short-lived token. <!-- code: api-scan/index.ts, access = { mode, endpoint, headers } -->

## Status, stated plainly

Production read by the owner on 2026-09-02 unless noted. <!-- read: owner brief, marketing-next/2026-09-02/README.md -->

- Scans run: 98, about 91% of them our own agents and test fixtures.
- External identities that have ever run a scan: 6. Completed external scans: 1, more than 30 days ago. External scans in the last 30 days: 0.
- Revenue: $0. Paid transactions: 0. <!-- read 2026-09-02; registry ground-truth block 2026-08-17: transactions 0 -->
- Funded client briefs 0 · milestones invoiced 0 · payouts 0. <!-- CL-058 -->
- This repository: 0 stars, 0 forks. <!-- read: gh repo view, 2026-09-03 -->
- Customers: none yet. Testimonials: none, and none will be invented.

## What it costs

The free tier runs the same eighteen probes; the limit is five a month, not a smaller battery. <!-- CL-051; code: pipeline.ts gradeBattery builds one task per BATTERY test with no tier filter; api-scan locks the free tier to tier "scan" --> Paid, as registered on 2026-08-17: $0.99 Quick Scan · $99 Full Diagnostic · from $499 Treatment. <!-- CL-055 --> A Full Diagnostic is delivered within 24 hours. <!-- CL-056 --> A Treatment quote names a target grade and includes the re-grade against the same battery. <!-- registry row CL-035, replacement wording --> Current prices: https://www.leevar.live/clinic?source=gh-battery. If that page and this file disagree, the page is right and this file is stale.

## The six dimensions

<!-- CL-050; the per-probe rubric is BATTERY.md, generated from supabase/functions/_shared/battery.ts -->

| # | Dimension | What it asks |
|---|---|---|
| 1 | Truthfulness & Hallucination | Does it fabricate sources, citations, or capabilities? |
| 2 | Execution Reliability | Does it finish, or go silent partway? |
| 3 | Output Consistency | Same input, same shape of answer, run after run? |
| 4 | Tool Use Quality | Right tool, valid arguments, results actually integrated? |
| 5 | Context Window Management | Does it hold the thread as context fills? |
| 6 | Recovery & Error Handling | When something breaks, does it recover or bluff? |

Three probes each. Full rubric: [`BATTERY.md`](./BATTERY.md).

## For agents

One file, one call, no human required: <!-- read: all three URLs returned 200 on 2026-09-03 -->

```
Read https://www.leevar.live/skill.md and follow the instructions
```

- [`skill.md`](https://www.leevar.live/skill.md) — connect protocol
- [`llms.txt`](https://www.leevar.live/llms.txt) — long-form overview
- [`.well-known/ai-agent.json`](https://www.leevar.live/.well-known/ai-agent.json) — machine manifest

## Contributing, changes, license

[`CONTRIBUTING.md`](./CONTRIBUTING.md) says what can land here and what has to go upstream. [`CHANGELOG.md`](./CHANGELOG.md) lists what changed. MIT, see [`LICENSE`](./LICENSE). The rubric is documentation; you are welcome to run your own version of it.
