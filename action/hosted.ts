// The hosted run: one submission to LEEVAR's free tier, then polling.
//
// THE FREE LIMITS ARE RESPECTED BY NOT RESUBMITTING. Every submission can spend
// a free scan — 20 a day per network, inside a daily capacity shared by
// everyone, and 5 a month for an email address. So this client submits exactly
// once per run. A refusal (429 included) is reported and the step ends; an
// outage on submit is reported and the step ends. Only polls are retried,
// because reading a result costs nothing.
//
// Polls back off from POLL_FIRST_MS by POLL_FACTOR up to POLL_MAX_MS and stop at
// the caller's deadline. The grant that reads the result is masked in the log
// before anything else is printed: in a public repository's Actions log it
// would let anyone read the scan.

import {
  type Failure,
  noResult,
  type Outcome,
  outcomeFromPoll,
} from "./outcome.ts";

export const DEFAULT_API_URL = "https://www.leevar.live/api/scan";
export const USER_AGENT = "leevar-battery-action/0.1.0";
export const POLL_FIRST_MS = 15_000;
export const POLL_FACTOR = 1.5;
export const POLL_MAX_MS = 60_000;
const REQUEST_TIMEOUT_MS = 30_000;

export interface HostedRequest {
  apiUrl: string;
  agent: { name: string; type?: string };
  samples: string[];
  email?: string;
  timeoutMs: number;
}

export interface HostedDeps {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  log: (line: string) => void;
}

interface Answer {
  ok: boolean;
  /** 0 when nothing came back at all. */
  status: number;
  body: Record<string, unknown>;
  networkError?: string;
  /** The request ran out of REQUEST_TIMEOUT_MS: sent, perhaps acted on, unanswered. */
  timedOut?: boolean;
}

/** One POST. Never throws: a dead network and a non-JSON page are answers too. */
async function post(
  deps: HostedDeps,
  url: string,
  body: unknown,
): Promise<Answer> {
  let res: Response;
  try {
    // /api/scan answers 307 to the API host; fetch follows it with the body.
    res = await deps.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": USER_AGENT },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    return {
      ok: false,
      status: 0,
      body: {},
      networkError: err instanceof Error ? err.message : String(err),
      timedOut: (err as { name?: unknown } | null)?.name === "TimeoutError",
    };
  }
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  const parsed = json && typeof json === "object" && !Array.isArray(json)
    ? json as Record<string, unknown>
    : {};
  return { ok: res.ok, status: res.status, body: parsed };
}

function describe(a: Answer): string {
  if (a.status === 0) {
    return `no response (${a.networkError ?? "network error"})`;
  }
  const parts = [`HTTP ${a.status}`];
  if (a.body.code) parts.push(`code ${a.body.code}`);
  if (a.body.error) parts.push(String(a.body.error));
  if (a.body.correlation_id) {
    parts.push(`correlation id ${a.body.correlation_id}`);
  }
  return parts.join(" — ");
}

const transient = (a: Answer) =>
  a.status === 0 || a.status === 429 || a.status >= 500 ||
  a.body.retryable === true;

/** What a scan id looks like. Anything else is not echoed into the log or an output. */
const SCAN_ID = /^[A-Za-z0-9_-]{1,64}$/;

export async function runHosted(
  req: HostedRequest,
  deps: HostedDeps,
): Promise<Outcome> {
  // Server text reaches the log; a newline in it would start a workflow command.
  const say = (line: string) => deps.log(line.replace(/[\r\n]+/g, " "));
  const created = await post(deps, req.apiUrl, {
    agent: req.agent,
    mode: "transcript",
    transcript: req.samples,
    ...(req.email ? { email: req.email } : {}),
    // Counted, never trusted: api-scan stores it only to say where scans came from.
    acq: "github-action",
  });

  if (created.timedOut) {
    // Not "could not reach": the request went out, and the scan may be queued
    // with its free scan spent. Saying otherwise invites a rerun that spends
    // another.
    return noResult(
      "error",
      "hosted",
      null,
      `LEEVAR at ${req.apiUrl} gave no answer within ${
        REQUEST_TIMEOUT_MS / 1000
      } s; the scan may have been queued and counted. This step does not resubmit.`,
    );
  }
  if (created.status === 0) {
    return noResult(
      "error",
      "hosted",
      null,
      `could not reach LEEVAR at ${req.apiUrl}: ${describe(created)}.`,
    );
  }
  if (!created.ok) {
    return noResult(
      "error",
      "hosted",
      null,
      `LEEVAR did not queue the scan: ${describe(created)}. ` +
        "This step does not resubmit — each submission can spend one of the free scans.",
    );
  }

  const scanId = typeof created.body.scan_id === "string" &&
      SCAN_ID.test(created.body.scan_id)
    ? created.body.scan_id
    : null;
  const grant =
    typeof created.body.grant === "string" && /^\S+$/.test(created.body.grant)
      ? created.body.grant
      : null;
  if (!scanId) {
    return noResult(
      "error",
      "hosted",
      null,
      `LEEVAR answered HTTP ${created.status} without a usable scan id.`,
    );
  }
  if (!grant) {
    return noResult(
      "error",
      "hosted",
      scanId,
      `LEEVAR queued ${scanId} but issued no poll ticket, so this step cannot read the result.` +
        (req.email
          ? ` If the scan finishes, the report is emailed to ${req.email}.`
          : ""),
    );
  }
  deps.log(`::add-mask::${grant}`);
  say(
    `Queued ${scanId}. Polling for the result (up to ${
      Math.round(req.timeoutMs / 60_000)
    } minutes).`,
  );

  const start = deps.now();
  let delay = POLL_FIRST_MS;
  let polls = 0;
  while (true) {
    const remaining = req.timeoutMs - (deps.now() - start);
    if (remaining <= 0) break;
    await deps.sleep(Math.min(delay, remaining));
    delay = Math.min(delay * POLL_FACTOR, POLL_MAX_MS);

    const r = await post(deps, req.apiUrl, { scan_id: scanId, grant });
    polls++;
    if (transient(r)) {
      say(`${scanId}: poll ${polls} got ${describe(r)} — trying again.`);
      continue;
    }
    if (!r.ok) {
      return noResult(
        "error",
        "hosted",
        scanId,
        `polling ${scanId} failed: ${describe(r)}.`,
      );
    }
    if (r.body.found === false) {
      return noResult(
        "error",
        "hosted",
        scanId,
        `LEEVAR did not accept the poll ticket for ${scanId}.`,
      );
    }
    const status = String(r.body.status ?? "");
    if (status === "graded" || status === "delivered") {
      try {
        return outcomeFromPoll(r.body, scanId);
      } catch {
        return noResult(
          "error",
          "hosted",
          scanId,
          "LEEVAR answered with a result this step could not read.",
        );
      }
    }
    if (status === "failed") {
      const failure = (r.body.failure ?? null) as Failure | null;
      return noResult(
        "failed",
        "hosted",
        scanId,
        failure?.retryable
          ? "LEEVAR marked this retryable. If the fault is LEEVAR's, the free scan is credited back."
          : "Not retryable as sent — fix the input first.",
        failure,
      );
    }
    say(`${scanId}: ${status || "no status yet"}.`);
  }

  return noResult(
    "timeout",
    "hosted",
    scanId,
    `no result after ${
      Math.round(req.timeoutMs / 60_000)
    } minutes (${polls} polls). ${scanId} may still finish` +
      (req.email
        ? `; if it does, the report is emailed to ${req.email}.`
        : ". This step gave no email, and the poll ticket is not kept after the step ends, so the result cannot be read from here."),
  );
}
