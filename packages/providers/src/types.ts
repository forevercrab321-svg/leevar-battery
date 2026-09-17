// What a provider is, and what a caller must supply to use one.
//
// KEYS COME FROM THE CALLER OR THE ENVIRONMENT. NOWHERE ELSE.
//
// This package must never learn how LEEVAR stores credentials. It imports no
// credential store, reaches no database, and has no notion of a "default
// account". A key arrives as a string the caller passed in, or as
// a named environment variable the caller chose — and if neither is present the
// provider says so and stops, rather than falling back to something that
// happens to work on our machines and nowhere else.
//
// The consequence is the point of the whole layer: a scan run by a stranger
// spends the stranger's money at the stranger's provider, and LEEVAR pays for
// no inference it did not ask for.

export interface ProviderConfig {
  /** The key itself. Takes precedence over `apiKeyEnv`. */
  apiKey?: string;
  /**
   * Name of an environment variable to read the key from.
   *
   * Each provider has a conventional default (OPENAI_API_KEY and so on). Given
   * as a name rather than read implicitly so that a reader of the calling code
   * can see which variable is in play.
   */
  apiKeyEnv?: string;
  /** Override the model. Every provider ships a general-purpose default. */
  model?: string;
  /** Override the endpoint — required for openai-compatible, optional elsewhere. */
  baseUrl?: string;
  /** Per-call timeout in ms. Public default is 60s; slow local models need more. */
  timeoutMs?: number;
  /**
   * Hard ceiling on calls for one scan. Undefined means no ceiling.
   *
   * A full battery is 18 calls. This exists so a BYOK user can bound their own
   * spend, not because anything here bills them — nothing in this package can.
   */
  maxCalls?: number;
  /** Max output tokens. Public default is 1024; the verdict is one JSON object. */
  maxOutputTokens?: number;
}

/** One call to a model: prompts in, raw text out. Everything else is shared. */
export interface ProviderCall {
  system: string;
  user: string;
  model: string;
  baseUrl: string;
  apiKey: string | null;
  timeoutMs: number;
  maxOutputTokens: number;
}

export interface Provider {
  /** Stable id, used in errors and in the (optional, off) telemetry counter. */
  readonly id: string;
  /** Human label for logs. Never contains a key. */
  readonly label: string;
  /** False for local runtimes like Ollama, which need no credential at all. */
  readonly needsKey: boolean;
  /** Resolved endpoint, so a caller can see where its data is about to go. */
  readonly endpoint: string;
  /** Resolved model. */
  readonly model: string;
  send(call: Omit<ProviderCall, "apiKey">, apiKey: string | null): Promise<string>;
}

/** Public defaults. Deliberately NOT LEEVAR's production numbers. */
export const PUBLIC_DEFAULTS = {
  /** LEEVAR runs 75s because its judge is a slow thinking model on a paid tier.
   *  60s is the general-purpose figure; Ollama overrides it upward. */
  timeoutMs: 60_000,
  /** A verdict is one small JSON object. A hosted operator may run a far larger
   *  ceiling to suit its own prompt set; that is its number, not this one. */
  maxOutputTokens: 1024,
  /** Deterministic grading. Re-running a scan must not move the scores — the
   *  battery grades consistency, so the judge cannot itself be random. */
  temperature: 0,
} as const;
