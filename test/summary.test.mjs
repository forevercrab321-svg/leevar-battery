import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  classifyRefusal,
  classifyResult,
  classifyTimeout,
  githubOutputLines,
  maskEmail,
  normalizeOptions,
  parseArgs,
  renderSummary,
} from "../scan.mjs";
import { startStub } from "./helpers/stub-server.mjs";
import { baseArgs, runCli, tempDir, writeTranscript } from "./helpers/cli.mjs";
import * as F from "./helpers/fixtures.mjs";

const opts = (extra = []) => normalizeOptions(parseArgs(["--email", "dev@example.com", "--name", "support-bot", "--transcript", "t.txt", ...extra]), {});
const resultOf = (fixture, extra = []) => classifyResult(opts(extra), { httpStatus: 200, ok: true, json: fixture, text: "" }, { scanId: fixture.scan_id, elapsedMs: 192_000, freeRemaining: 4 });

test("maskEmail never shows the local part", () => {
  assert.equal(maskEmail("dev@example.com"), "d***@example.com");
  assert.equal(maskEmail("a@b.c"), "a***@b.c");
  assert.equal(maskEmail("nope"), "***");
  assert.equal(maskEmail(""), "");
});

test("summary: a graded pass has the headline, coverage, the six dimensions and a masked email", () => {
  const md = renderSummary(resultOf(F.deliveredBPlus(), ["--fail-below", "B"]));
  assert.match(md, /^## LEEVAR reliability battery — `support-bot`/);
  assert.match(md, /\*\*Grade: B\+\*\* \(composite 84\.2\) · verdict: \*\*pass\*\* \(exit 0\)/);
  assert.match(md, /Coverage: 18\/18 tests evidenced · 6\/6 dimensions/);
  assert.match(md, /\| Dimension \| Score \| Evidenced \|/);
  for (const name of ["Truthfulness & Hallucination", "Execution Reliability", "Output Consistency", "Tool Use Quality", "Context Window Management", "Recovery & Error Handling"]) {
    assert.ok(md.includes(`| ${name} |`), `missing row for ${name}`);
  }
  assert.match(md, /\| Truthfulness & Hallucination \| 82 \| 3\/3 \|/);
  assert.match(md, /Scan `SCN-2026-0001` · transcript mode · \[report\]\(https:\/\/www\.leevar\.live\/clinic\/r\/SCN-2026-0001\) \(opens with the email used\) · emailed to d\*\*\*@example\.com · 4 of 5 free scans left this month/);
  assert.equal(md.includes("dev@example.com"), false, "run pages can be public: the address is masked");
  assert.match(md, /source `gh-battery` \(recorded here only; the API has no attribution field yet\)/);
});

test("summary: withheld names the line and the reference number's status", () => {
  const md = renderSummary(resultOf(F.withheld(), ["--fail-on-withheld"]));
  assert.match(md, /\*\*Grade: withheld\*\* \(insufficient coverage\) · verdict: \*\*grade withheld\*\* \(exit 2\)/);
  assert.match(md, /11\/18 tests evidenced, 13 needed/);
  assert.match(md, /Reference average over the evidenced tests: 92\.1 — not a grade; do not gate on it/);
  assert.match(md, /\| Tool Use Quality \| NOT TESTED \| 0\/3 \|/);
  assert.match(md, /\| Truthfulness & Hallucination \| 95 \| 1\/3 \|/);
});

test("summary: failed, refused and timed-out runs still produce a useful page", () => {
  const failed = renderSummary(resultOf(F.failedWatchdog()));
  assert.match(failed, /\*\*Scan failed\*\* \(exit 5\) — watchdog_timeout \(fault: ours, retryable: yes\)/);
  assert.match(failed, /does not count against the free allowance/);

  const refused = renderSummary(classifyRefusal(opts(), { httpStatus: 429, ok: false, json: F.REFUSALS.freeExhausted.body, text: "" }));
  assert.match(refused, /\*\*Request refused\*\* \(exit 3\) — HTTP 429 on submit: free tier exhausted \(5\/5 this month for this email\)/);
  assert.match(refused, /use an API key \(LEEVAR_API_KEY\)/);
  assert.equal(refused.includes("Scan `"), false, "no scan id was issued");

  const timeout = renderSummary(classifyTimeout(opts(), "SCN-2026-0001", { httpStatus: 200, json: F.running() }, 1_500_000));
  assert.match(timeout, /\*\*Timed out\*\* \(exit 6\) — no result after 25m00s waiting for SCN-2026-0001 \(last status: running\)/);
  assert.match(timeout, /resume with --scan-id SCN-2026-0001 --email dev@example\.com/);
});

test("summary: job-fit line when the server returns one", () => {
  const md = renderSummary(resultOf(F.withJobFit()));
  assert.match(md, /Job-Fit: \*\*hire-with-guardrails\*\* · fit 78 · 2\/3 requirements verified/);
});

test("githubOutputLines: one key=value per line, empty when absent", () => {
  assert.equal(
    githubOutputLines(resultOf(F.deliveredBPlus(), ["--fail-below", "B"])),
    "grade=B+\ncomposite=84.2\nwithheld=false\nreport-url=https://www.leevar.live/clinic/r/SCN-2026-0001\nscan-id=SCN-2026-0001\nstatus=delivered\nverdict=pass\nexit-code=0\n",
  );
  const w = githubOutputLines(resultOf(F.withheld(), ["--fail-on-withheld"]));
  assert.match(w, /^grade=\ncomposite=\nwithheld=true\n/);
  assert.match(w, /exit-code=2\n$/);
  const refused = githubOutputLines(classifyRefusal(opts(), { httpStatus: 429, ok: false, json: F.REFUSALS.freeExhausted.body, text: "" }));
  assert.match(refused, /^grade=\ncomposite=\nwithheld=false\nreport-url=\nscan-id=\nstatus=\nverdict=refused\nexit-code=3\n$/);
});

test("--summary and --github-output append to their files (GITHUB_STEP_SUMMARY semantics)", async () => {
  const stub = await startStub({ polls: [{ status: 200, body: F.deliveredBPlus() }] });
  const dir = await tempDir();
  const t = await writeTranscript(dir);
  const summary = path.join(dir, "summary.md");
  const output = path.join(dir, "output.txt");
  try {
    for (let i = 0; i < 2; i++) {
      const r = await runCli(baseArgs(stub.url, t, ["--summary", summary, "--github-output", output, "--fail-below", "B"]));
      assert.equal(r.code, 0, r.all);
    }
    const md = await readFile(summary, "utf8");
    assert.equal(md.split("## LEEVAR reliability battery").length - 1, 2, "appended, not overwritten");
    const out = await readFile(output, "utf8");
    assert.equal(out.split("grade=B+\n").length - 1, 2);
  } finally {
    await stub.close();
  }
});

test("--summary is written on refusal too, so CI shows the reason on the run page", async () => {
  const stub = await startStub({ submit: F.REFUSALS.freeExhausted });
  const dir = await tempDir();
  const t = await writeTranscript(dir);
  const summary = path.join(dir, "summary.md");
  try {
    const r = await runCli(baseArgs(stub.url, t, ["--summary", summary]));
    assert.equal(r.code, 3);
    assert.match(await readFile(summary, "utf8"), /\*\*Request refused\*\* \(exit 3\)/);
  } finally {
    await stub.close();
  }
});
