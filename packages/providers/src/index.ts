// Turn a provider choice into a Judge the scanner can run.
//
// WHERE A KEY COMES FROM, AND WHERE IT DOES NOT
// ---------------------------------------------
// Two sources, both named by the caller:
//
//   makeJudge({ provider: "openai", apiKey: "sk-…" })      explicit
//   makeJudge({ provider: "openai", apiKeyEnv: "MY_VAR" }) named env var
//
// and nothing else. This package reads no credential store, reaches no
// database, and has no default account to fall back on. If neither source
// yields a key for a provider that needs one, it throws — a scanner that
// quietly finds credentials of its own is a scanner nobody can reason about
// the cost of.
//
// (Naming the store we do not read would have put its name in a public
// package, which is the same mistake as writing an address down in order to
// assert it is absent. The leak gate caught this comment doing exactly that.)
//
// The key is held in a closure for the life of the judge, passed to the
// provider on each call, and never written anywhere: not to a file, not to a
// log line, not into an error. `redact.ts` is the second line for the last of
// those.

import type { Judge } from "../../scanner-core/src/judge-types.ts";
import type { JudgeContext } from "../../scanner-core/src/prompts/types.ts";
import type { JudgePrompts } from "../../scanner-core/src/prompts/types.ts";
import { DEFAULT_PROMPTS } from "../../scanner-core/src/prompts/default.ts";
import { notGraded, parseVerdict } from "../../scanner-core/src/verdict.ts";
import { PROVIDERS, DEFAULT_KEY_ENV, PROVIDER_IDS } from "./providers.ts";
import { TEST_COUNT } from "../../scanner-core/src/battery.ts";
import { PUBLIC_DEFAULTS, type ProviderConfig } from "./types.ts";
import { ProviderError } from "./redact.ts";

export type { ProviderConfig } from "./types.ts";
export { PROVIDER_IDS, DEFAULT_KEY_ENV } from "./providers.ts";
export { ProviderError, redact, FATAL_CODES } from "./redact.ts";
export type { ProviderErrorCode } from "./redact.ts";

/**
 * The ceiling a run gets when the caller names none.
 *
 * Derived, not chosen: one full battery is TEST_COUNT tests, and the retry
 * policy allows at most one extra attempt per test, so TEST_COUNT * 2 is the
 * theoretical maximum a correct run can reach. A default of Infinity — which is
 * what this had — means a misconfigured loop spends the user's money until they
 * notice, and the user is the only person who can notice, because nothing here
 * bills them and nothing here can see their bill.
 */
export const DEFAULT_MAX_CALLS = TEST_COUNT * 2;

/** What a battery costs, so a caller can show it before spending anything. */
export interface CallBudget {
  /** One call per test, everything answering first time. */
  normal: number;
  /** Every test taking its one retry. */
  max: number;
  /** The ceiling in force for this run. */
  ceiling: number;
}

export interface JudgeOptions extends ProviderConfig {
  provider: string;
  prompts?: JudgePrompts;
  /** Reads an env var. Injected so tests need no ambient environment. */
  readEnv?: (name: string) => string | undefined;
}

function defaultReadEnv(name: string): string | undefined {
  // deno-lint-ignore no-explicit-any
  const g = globalThis as any;
  if (g.Deno?.env?.get) { try { return g.Deno.env.get(name); } catch { return undefined; } }
  if (g.process?.env) return g.process.env[name];
  return undefined;
}

export function makeJudge(o: JudgeOptions): Judge {
  const make = PROVIDERS[o.provider];
  if (!make) {
    throw new ProviderError("providers",
      `unknown provider "${o.provider}" — known: ${PROVIDER_IDS.join(", ")}`,
      null, null, "misconfigured");
  }
  const provider = make(o);
  const readEnv = o.readEnv ?? defaultReadEnv;

  let apiKey: string | null = null;
  if (provider.needsKey) {
    const envName = o.apiKeyEnv ?? DEFAULT_KEY_ENV[o.provider] ?? null;
    apiKey = (o.apiKey ?? (envName ? readEnv(envName) : undefined) ?? "").trim() || null;
    if (!apiKey) {
      // Names the variable rather than the value, which is the only useful half.
      throw new ProviderError(o.provider,
        `no API key. Pass apiKey, or set ${envName ?? "an API key variable"}. ` +
        `This scanner never supplies a key of its own.`,
        null, null, "misconfigured");
    }
  }

  const prompts = o.prompts ?? DEFAULT_PROMPTS;
  const maxCalls = o.maxCalls ?? DEFAULT_MAX_CALLS;
  const timeoutMs = o.timeoutMs ??
    (o.provider === "ollama" ? 180_000 : PUBLIC_DEFAULTS.timeoutMs);
  const maxOutputTokens = o.maxOutputTokens ?? PUBLIC_DEFAULTS.maxOutputTokens;
  let calls = 0;

  const send = async (ctx: JudgeContext): Promise<string> => {
    if (calls >= maxCalls) {
      throw new ProviderError(o.provider,
        `stopped after ${calls} calls`, null, null, "call_ceiling");
    }
    calls++;
    return await provider.send({
      system: prompts.system,
      user: prompts.buildUser(ctx),
      model: provider.model,
      baseUrl: provider.endpoint,
      timeoutMs,
      maxOutputTokens,
    }, apiKey);
  };

  return {
    mode: provider.id,
    calls: () => calls,
    async score(ctx: JudgeContext) {
      // WHOSE FAULT IT WAS DECIDES WHETHER THE SCAN CONTINUES.
      //
      // This function used to catch every ProviderError and return
      // `evidence: "absent"`. An invalid key therefore produced a low-coverage
      // report ABOUT THE CUSTOMER'S AGENT, when the thing that had failed was
      // the customer's own configuration — and it retried the 401 first, so it
      // did it twice. Reproduced before this change: two HTTP calls, verdict
      // `evidence: "absent", fault: "judge"`.
      //
      // A provider, config or network failure is not a finding, is not a
      // coverage gap, and cannot be made into one. It throws, the pool
      // abandons the battery, and the caller is told which of the three it was.
      //
      // The one thing that IS a judge fault, and the only survivor of the old
      // behaviour: HTTP succeeded twice and neither reply could be read as a
      // verdict. That is ours, it is counted separately from the customer's
      // thin evidence, and it stays `no-response`.
      // Three outcomes, and which one you get depends on WHO failed:
      //
      //   fatal          config or quota. Throw at once; a retry changes nothing.
      //   bad_response   the provider answered and the answer was unusable.
      //                  Retry once; if it happens twice that is OUR judge
      //                  failing to read a reply, which is a verdict, not an
      //                  outage — and must never be reported as connectivity.
      //   transient      5xx, DNS, timeout. Retry once, then throw.
      let lastError: ProviderError | null = null;

      for (let attempt = 0; attempt < 2; attempt++) {
        let text: string;
        try {
          text = await send(ctx);
        } catch (err) {
          const pe = err instanceof ProviderError
            ? err
            : new ProviderError(provider.id, String(err), null, apiKey, "network");
          if (pe.fatal) throw pe;
          lastError = pe;
          if (attempt === 0) continue;
          // Exhausted. A bad_response is not an outage: HTTP and the network
          // both worked, so saying "could not reach the provider" would send
          // the user to look at the wrong thing entirely.
          if (pe.code === "bad_response") break;
          throw pe;
        }

        const v = parseVerdict(ctx, text);
        if (v) return v;
        // HTTP fine, body not a verdict — same class as an empty choices array,
        // and it lands in the same place.
        lastError = new ProviderError(provider.id, "reply was not a verdict", 200, apiKey, "bad_response");
      }

      // Two HTTP successes we could not read. Ours, and counted apart from the
      // customer's thin evidence.
      if (lastError && lastError.code !== "bad_response") throw lastError;
      return notGraded(ctx, "no-response");
    },
  };
}

/**
 * What a run is about to do, before it does any of it. Carries no key.
 *
 * This is the preflight a CLI prints: which provider, which model, which host
 * the transcript is about to be sent to, and how many calls that can cost. No
 * dollar figure — prices differ by provider and model and change without
 * notice, and a number that goes stale is worse than no number.
 */
export function describe(o: JudgeOptions): {
  provider: string; endpoint: string; model: string; needsKey: boolean; budget: CallBudget;
} {
  const p = PROVIDERS[o.provider]?.(o);
  if (!p) throw new ProviderError("providers", `unknown provider "${o.provider}"`, null, null, "invalid_request");
  return {
    provider: p.id, endpoint: p.endpoint, model: p.model, needsKey: p.needsKey,
    budget: { normal: TEST_COUNT, max: TEST_COUNT * 2, ceiling: o.maxCalls ?? DEFAULT_MAX_CALLS },
  };
}
