// The seven. Each one is a URL, a body shape and where the text comes back.
//
// Defaults here are GENERAL-PURPOSE, chosen for a stranger with their own key:
// a cheap, fast, widely-available model per vendor. They are deliberately not
// LEEVAR's production choices, which are tuned against LEEVAR's prompt set and
// its own cost position, and copying them would publish an operating decision
// while pretending to publish a default.

import { PUBLIC_DEFAULTS, type Provider, type ProviderCall, type ProviderConfig } from "./types.ts";
import { postJson } from "./http.ts";
import { ProviderError } from "./redact.ts";

type Body = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/* ----------------------------- OpenAI shape ------------------------------ */
/** Shared by OpenAI, DeepSeek, OpenRouter, Ollama and any compatible endpoint. */
function openAiLike(
  id: string, label: string, endpoint: string, model: string,
  opts: { needsKey?: boolean; extraHeaders?: Record<string, string> } = {},
): Provider {
  return {
    id, label, endpoint, model, needsKey: opts.needsKey !== false,
    async send(call: Omit<ProviderCall, "apiKey">, apiKey: string | null) {
      const body: Body = {
        model: call.model,
        temperature: PUBLIC_DEFAULTS.temperature,
        max_tokens: call.maxOutputTokens,
        messages: [
          { role: "system", content: call.system },
          { role: "user", content: call.user },
        ],
      };
      const json = await postJson({
        provider: id, url: call.baseUrl, timeoutMs: call.timeoutMs, apiKey, body,
        headers: {
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
          ...(opts.extraHeaders ?? {}),
        },
      }) as { choices?: { message?: { content?: unknown } }[] };
      const text = str(json?.choices?.[0]?.message?.content);
      if (!text) {
        // HTTP AND THE NETWORK BOTH SUCCEEDED. Without an explicit code this
        // fell to codeForStatus(null) === "network", and a 200 carrying an
        // empty `choices` array was reported to the user as "could not reach
        // the provider — check connectivity, proxy and baseUrl". Every word of
        // that was wrong, and it sent them to look at their network.
        throw new ProviderError(id, "HTTP 200 with no message content", 200, apiKey, "bad_response");
      }
      return text;
    },
  };
}

/* ------------------------------- Anthropic ------------------------------- */
function anthropic(endpoint: string, model: string): Provider {
  return {
    id: "anthropic", label: "Anthropic", endpoint, model, needsKey: true,
    async send(call, apiKey) {
      const json = await postJson({
        provider: "anthropic", url: call.baseUrl, timeoutMs: call.timeoutMs, apiKey,
        headers: {
          "x-api-key": apiKey ?? "",
          "anthropic-version": "2023-06-01",
        },
        body: {
          model: call.model,
          max_tokens: call.maxOutputTokens,
          temperature: PUBLIC_DEFAULTS.temperature,
          system: call.system,
          messages: [{ role: "user", content: call.user }],
        },
      }) as { content?: { text?: unknown }[] };
      const text = str(json?.content?.[0]?.text);
      if (!text) {
        throw new ProviderError("anthropic", "HTTP 200 with no content block", 200, apiKey, "bad_response");
      }
      return text;
    },
  };
}

/* -------------------------------- Gemini --------------------------------- */
function gemini(endpoint: string, model: string): Provider {
  return {
    id: "gemini", label: "Google Gemini", endpoint, model, needsKey: true,
    async send(call, apiKey) {
      // The key goes in a header, not the query string. Google accepts both, and
      // the query form writes the key into every proxy log and error URL between
      // here and there.
      const url = `${call.baseUrl.replace(/\/$/, "")}/models/${encodeURIComponent(call.model)}:generateContent`;
      const json = await postJson({
        provider: "gemini", url, timeoutMs: call.timeoutMs, apiKey,
        headers: { "x-goog-api-key": apiKey ?? "" },
        body: {
          systemInstruction: { parts: [{ text: call.system }] },
          contents: [{ role: "user", parts: [{ text: call.user }] }],
          generationConfig: {
            temperature: PUBLIC_DEFAULTS.temperature,
            maxOutputTokens: call.maxOutputTokens,
          },
        },
      }) as { candidates?: { content?: { parts?: { text?: unknown }[] } }[] };
      const text = str(json?.candidates?.[0]?.content?.parts?.[0]?.text);
      if (!text) {
        // A Gemini 200 with no candidate usually means the response was filtered
        // rather than that anything failed to arrive.
        throw new ProviderError("gemini", "HTTP 200 with no candidate text", 200, apiKey, "bad_response");
      }
      return text;
    },
  };
}

/* ------------------------------- registry -------------------------------- */
export const PROVIDERS: Record<string, (c: ProviderConfig) => Provider> = {
  openai: (c) => openAiLike("openai", "OpenAI",
    c.baseUrl ?? "https://api.openai.com/v1/chat/completions", c.model ?? "gpt-4o-mini"),

  // deepseek-v4-flash, not deepseek-chat. DeepSeek's own documentation calls
  // deepseek-chat a legacy alias scheduled for removal on 2026-07-24; it
  // answered a smoke test on 2026-08-25, which shows the alias still resolves
  // and shows nothing about it being a supported model. A default that works
  // because a deprecation has not been enforced yet is a default with a date on
  // it, and the date has already passed.
  deepseek: (c) => openAiLike("deepseek", "DeepSeek",
    c.baseUrl ?? "https://api.deepseek.com/chat/completions", c.model ?? "deepseek-v4-flash"),

  openrouter: (c) => openAiLike("openrouter", "OpenRouter",
    c.baseUrl ?? "https://openrouter.ai/api/v1/chat/completions",
    c.model ?? "openai/gpt-4o-mini"),

  // No key, no cloud. This is the one that makes "try it" cost nothing, and it
  // is why the README's first example uses it: a reader can run the full
  // battery before deciding whether to spend anything at all.
  ollama: (c) => openAiLike("ollama", "Ollama (local)",
    c.baseUrl ?? "http://127.0.0.1:11434/v1/chat/completions",
    c.model ?? "llama3.1", { needsKey: false }),

  "openai-compatible": (c) => {
    if (!c.baseUrl) {
      throw new ProviderError("openai-compatible",
        "baseUrl is required — this provider has no default endpoint by design",
        null, null, "misconfigured");
    }
    return openAiLike("openai-compatible", "OpenAI-compatible endpoint",
      c.baseUrl, c.model ?? "gpt-4o-mini");
  },

  anthropic: (c) => anthropic(
    c.baseUrl ?? "https://api.anthropic.com/v1/messages", c.model ?? "claude-3-5-haiku-latest"),

  gemini: (c) => gemini(
    c.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta", c.model ?? "gemini-2.0-flash"),
};

/** Conventional environment variable per provider. */
export const DEFAULT_KEY_ENV: Record<string, string | null> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  gemini: "GEMINI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  ollama: null,
  "openai-compatible": "LLM_API_KEY",
};

export const PROVIDER_IDS = Object.keys(PROVIDERS);
