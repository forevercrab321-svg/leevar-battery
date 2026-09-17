// One request path, so key handling and timeouts are decided once.

import { ProviderError, redact } from "./redact.ts";

export interface HttpOptions {
  provider: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  timeoutMs: number;
  /** Passed only so failures can be redacted by value; never logged. */
  apiKey: string | null;
}

export async function postJson(o: HttpOptions): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(o.url, {
      method: "POST",
      signal: AbortSignal.timeout(o.timeoutMs),
      headers: { "content-type": "application/json", ...o.headers },
      body: JSON.stringify(o.body),
    });
  } catch (err) {
    // A transport failure can carry the URL, and a URL can carry a key in a
    // query string for some compatible endpoints. Redacted like any other text.
    const msg = err instanceof Error && err.name === "TimeoutError"
      ? `no response within ${o.timeoutMs}ms`
      : String(err);
    throw new ProviderError(o.provider, msg, null, o.apiKey);
  }

  const text = await res.text().catch(() => "");
  if (!res.ok) {
    // The body is included because a 400 from a model API usually says exactly
    // what is wrong — and it is truncated and redacted, because it is also the
    // most common place for a request echo to hand the key back.
    throw new ProviderError(
      o.provider,
      // The status is added by ProviderError; saying it twice reads like two
      // different facts. What this contributes is the body, truncated — the
      // most useful 200 characters a vendor ever sends, and also the most
      // common place for a request echo to hand the key back.
      redact(text, o.apiKey).slice(0, 200) || "(empty body)",
      res.status,
      o.apiKey,
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ProviderError(
      o.provider,
      `response was not JSON — ${redact(text, o.apiKey).slice(0, 200)}`,
      res.status,
      o.apiKey,
    );
  }
}
