// Poll responses shaped like api-scan/index.ts:279-314 (leevar-home e7e046f).
const TESTS = {
  d1: ["citation-fabrication", "capability-overclaim", "grounded-qa"],
  d2: ["e2e-task-completion", "multi-step-continuity", "silent-abandonment"],
  d3: ["same-input-x10-variance", "format-contract-adherence", "tone-drift"],
  d4: ["tool-selection", "argument-validity", "result-integration"],
  d5: ["long-thread-recall", "instruction-retention", "context-compression"],
  d6: ["tool-failure-injection", "graceful-degradation", "self-correction"],
};

function dim(key, score, evidence = ["sufficient", "sufficient", "sufficient"]) {
  const tests = TESTS[key].map((name, i) => ({
    name,
    score: evidence[i] === "absent" ? 0 : score,
    result: evidence[i] === "absent" ? "fail" : "pass",
    evidence: evidence[i],
    detail: evidence[i] === "absent" ? "Not graded: the samples contain nothing that exercises this test." : "ok",
  }));
  const tested = tests.some((t) => t.evidence === "sufficient" || t.evidence === "thin");
  return { score: tested ? score : 0, tested, tests };
}

export function deliveredBPlus(scanId = "SCN-2026-0001") {
  return {
    scan_id: scanId,
    status: "delivered",
    grade: "B+",
    composite: 84.2,
    coverage: { dimensions_tested: 6, dimensions_total: 6, tests_evidenced: 18, tests_total: 18, tests_our_fault: 0, graded: true },
    job_fit: null,
    scores: { d1: dim("d1", 82), d2: dim("d2", 90), d3: dim("d3", 80), d4: dim("d4", 85), d5: dim("d5", 84), d6: dim("d6", 84) },
    report_md: "# LEEVAR Clinic — Diagnostic Report\n\n## Composite grade: B+ (84.2/100)\n",
  };
}

export function deliveredAMinus(scanId = "SCN-2026-0002") {
  const r = deliveredBPlus(scanId);
  r.grade = "A−";
  r.composite = 88.4;
  return r;
}

/** 11/18 evidenced: below the 0.67 line, letter withheld (coverage.ts:109, api-scan/index.ts:291-298). */
export function withheld(scanId = "SCN-2026-0003") {
  return {
    scan_id: scanId,
    status: "delivered",
    grade: null,
    composite: null,
    grade_withheld: "insufficient_coverage",
    composite_reference: 92.1,
    coverage: { dimensions_tested: 5, dimensions_total: 6, tests_evidenced: 11, tests_total: 18, tests_our_fault: 0, graded: false },
    job_fit: null,
    scores: {
      d1: dim("d1", 95, ["absent", "sufficient", "absent"]),
      d2: dim("d2", 92),
      d3: dim("d3", 90, ["sufficient", "thin", "absent"]),
      d4: dim("d4", 0, ["absent", "absent", "absent"]),
      d5: dim("d5", 91, ["sufficient", "sufficient", "absent"]),
      d6: dim("d6", 93, ["sufficient", "absent", "absent"]),
    },
    report_md: "## PARTIAL — 11/18 tests evidenced, no grade issued\n",
  };
}

export function withJobFit(scanId = "SCN-2026-0004") {
  const r = deliveredBPlus(scanId);
  r.job_fit = { verdict: "hire-with-guardrails", fit_score: 78, requirements_verified: 2, requirements_total: 3 };
  return r;
}

/** status:"failed" with the failure object from _shared/failure.ts:54-61. */
export function failedWatchdog(scanId = "SCN-2026-0005") {
  return {
    scan_id: scanId,
    status: "failed",
    failure: {
      reason: "watchdog_timeout",
      fault: "ours",
      retryable: true,
      detail: "The battery was still running when our watchdog timed it out. That is our bug, not a finding about your agent.",
    },
    grade: null,
    composite: null,
    coverage: null,
    job_fit: null,
    scores: null,
    report_md: null,
  };
}

export function failedBadInput(scanId = "SCN-2026-0006") {
  const r = failedWatchdog(scanId);
  r.failure = { reason: "bad_input", fault: "yours", retryable: false, detail: "The scan had nothing to measure." };
  return r;
}

export function queued(scanId = "SCN-2026-0001") {
  return { scan_id: scanId, status: "queued", grade: null, composite: null, coverage: null, job_fit: null, scores: null, report_md: null };
}

export function running(scanId = "SCN-2026-0001") {
  return { ...queued(scanId), status: "running" };
}

/** Delivery failed after grading: status stays "graded" (pipeline.ts:493-495). */
export function gradedNotDelivered(scanId = "SCN-2026-0007") {
  return { ...deliveredBPlus(scanId), status: "graded" };
}

// Verbatim server refusals (api-scan/index.ts, line numbers in comments).
export const REFUSALS = {
  freeExhausted: { status: 429, body: { error: "free tier exhausted (5/5 this month for this email) — email hello@leevarai.org for an API key" } }, // :428
  dailyCap: { status: 429, body: { error: "free tier is at today's global capacity — try again tomorrow, or email hello@leevarai.org for a key" } }, // :419
  needsEmail: { status: 400, body: { error: "free tier requires `email` (5 free scans per month, results delivered there)" } }, // :337
  invalidKey: { status: 403, body: { error: "invalid or inactive API key", code: "invalid_key", retryable: false } }, // :150
  quotaCheckFailed: { status: 503, body: { error: "could not check your free-tier allowance right now — please retry shortly", code: "quota_check_failed", retryable: true, detail: "x" } }, // :394-402
  lookupFailed: { status: 503, body: { error: "could not read the scan — this is our side, not your scan id", code: "lookup_failed", retryable: true, detail: "x" } }, // :179-187
  notFound: { status: 404, body: { error: "scan not found", code: "not_found", retryable: false } }, // :190-193
};
