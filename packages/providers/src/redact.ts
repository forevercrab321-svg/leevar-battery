// A key must not survive contact with an error.
//
// The failure this prevents is ordinary and common: a request fails, the code
// throws `HTTP 401: ${JSON.stringify({ headers, body })}`, and a bearer token
// lands in a terminal, a CI log, a bug report and a screenshot. Nobody decided
// to publish it; the error message did.
//
// So keys never enter a message in the first place — no error in this package
// interpolates a header or a config object — and this is the second line: every
// throw goes through `redact`, which removes anything key-shaped from whatever
// the provider happened to say back.

/** Shapes a credential takes across the providers this package speaks to. */
const KEY_SHAPES: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{8,}/g,           // OpenAI, DeepSeek, many compatibles
  /\bsk-ant-[A-Za-z0-9_-]{8,}/g,       // Anthropic
  /\bsk-or-[A-Za-z0-9_-]{8,}/g,        // OpenRouter
  /\bAIza[A-Za-z0-9_-]{20,}/g,         // Google AI
  /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi,
  /\b(x-api-key|api-key|authorization)\s*[:=]\s*\S+/gi,
];

/**
 * Remove anything key-shaped from a string.
 *
 * `exact` is the key currently in use, redacted by value as well as by shape:
 * a provider that invents its own prefix would slip past every pattern above,
 * and the one string we are certain is a secret is the one we were just handed.
 */
export function redact(text: string, exact?: string | null): string {
  let out = text;
  // SHAPES FIRST, THEN THE EXACT VALUE.
  //
  // The other order leaves debris. Replacing the key by value turns
  // `Bearer <key>` into `Bearer [REDACTED]`, and the bearer-token pattern then
  // cannot match its own body because brackets are not in the character class —
  // so the header name survives. Caught by a test asserting no Authorization
  // header reaches an error message.
  for (const re of KEY_SHAPES) out = out.replace(re, "[REDACTED]");
  if (exact && exact.length >= 8) {
    out = out.split(exact).join("[REDACTED]");
  }
  // Whatever the order, a header name with nothing behind it is noise that
  // reads like a leak. Collapse it.
  out = out.replace(/\b(Bearer|x-api-key|api-key|authorization)\s*[:=]?\s*\[REDACTED\]/gi, "[REDACTED]");
  return out;
}

/**
 * Stable machine codes. A caller branches on these, not on prose.
 *
 * Split by WHO HAS TO ACT, because that is the only distinction that changes
 * what anyone does next:
 *
 *   the caller       unauthorized · forbidden · not_found · invalid_request
 *                    · call_ceiling · misconfigured — a key, a model name,
 *                    an endpoint, a limit, or a flag never typed
 *   the provider     rate_limited · provider_unavailable
 *   the network      network
 *
 * None of them is a finding about the agent under test.
 */
export type ProviderErrorCode =
  | "unauthorized"          // 401
  | "forbidden"             // 403
  | "not_found"             // 404 — endpoint or model
  | "invalid_request"       // 400
  | "rate_limited"          // 429
  | "provider_unavailable"  // 5xx
  | "network"               // DNS, connection, timeout
  | "call_ceiling"          // our own limit, not theirs
  | "bad_response"          // HTTP 200 that was not usable
  | "misconfigured";        // nothing was sent — a flag or variable is missing

/** Codes that end the scan. A retry cannot change any of them. */
export const FATAL_CODES: ReadonlySet<ProviderErrorCode> = new Set([
  "unauthorized", "forbidden", "not_found", "invalid_request",
  "rate_limited", "call_ceiling", "misconfigured",
]);

/** What the caller should do, in one line. Never mentions a key's value. */
const ADVICE: Record<ProviderErrorCode, string> = {
  unauthorized: "the API key was rejected — check it is correct and active for this provider",
  forbidden: "the key is valid but not permitted here — check the model and the account's access",
  not_found: "the endpoint or model was not found — check `model` and `baseUrl`",
  invalid_request: "the provider rejected the request shape — check `model` and any baseUrl override",
  rate_limited: "rate limited or out of quota — wait, or use a different key or provider",
  provider_unavailable: "the provider returned a server error twice — try again later",
  network: "could not reach the provider — check connectivity, proxy and baseUrl",
  call_ceiling: "the run hit its own call ceiling — raise `maxCalls` if this was expected",
  bad_response: "the provider answered but the reply could not be read as a verdict",
  // NOTHING WAS SENT, SO NOTHING FAILED TO ARRIVE.
  //
  // A missing key, an unknown provider id and a missing baseUrl all used to
  // reach `codeForStatus(null)` — which is "network" — and were therefore
  // reported as "could not reach the provider — check connectivity, proxy and
  // baseUrl". Every word of that was wrong, and it sent the reader to look at
  // their network for a flag they had not typed. The same mistake is already
  // written down in providers.ts for the HTTP-200 case — "every word of that
  // was wrong, and it sent them to look at their network". This is the other
  // half of it, on the path a first-time user hits first.
  misconfigured: "nothing was sent — supply what the message above names, then re-run",
};

/**
 * A provider, config or network failure.
 *
 * NOT a verdict, and deliberately not convertible into one. Turning it into
 * `evidence: "absent"` is what this class exists to stop: an invalid key used
 * to produce a low-coverage report about the customer's agent, when the true
 * subject of the failure was the customer's own configuration.
 */
export class ProviderError extends Error {
  readonly provider: string;
  readonly status: number | null;
  readonly code: ProviderErrorCode;
  readonly advice: string;
  readonly fatal: boolean;

  constructor(
    provider: string, message: string, status: number | null,
    apiKey?: string | null, code?: ProviderErrorCode,
  ) {
    const resolved = code ?? codeForStatus(status);
    super(redact(`[${provider}] ${resolved}${status ? ` (HTTP ${status})` : ""}: ${message} — ${ADVICE[resolved]}`, apiKey));
    this.name = "ProviderError";
    this.provider = provider;
    this.status = status;
    this.code = resolved;
    this.advice = ADVICE[resolved];
    this.fatal = FATAL_CODES.has(resolved);
  }

  /** Serialisable, and carrying nothing that could be a credential. */
  toJSON(): Record<string, unknown> {
    return {
      error: "provider_error", provider: this.provider, code: this.code,
      status: this.status, advice: this.advice, message: this.message,
    };
  }
}

export function codeForStatus(status: number | null): ProviderErrorCode {
  if (status === null) return "network";
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "provider_unavailable";
  if (status >= 400) return "invalid_request";
  return "bad_response";
}
