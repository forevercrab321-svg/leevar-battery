# Code check

`deno task check-code <path>` reads an agent project's Python and TypeScript / JavaScript code and points at places shaped like five faults that maintainers of real open-source projects confirmed. It runs offline: no model, no API key, no network. It reads your files and never executes or changes them.

```bash
deno task check-code ./my-agent                     # Markdown report
deno task check-code ./my-agent --exclude tests     # leave a folder out (repeatable)
deno task check-code ./my-agent --json              # machine-readable result
deno task check-code ./my-agent --fail-on-findings  # exit 3 on any match, for CI
```

Exit codes: `0` the check ran (with or without matches), `1` the path could not be read, `2` wrong arguments, `3` `--fail-on-findings` was given and something matched.

## What a match means

Every match is a **possible issue for a person to confirm**. The rules are line-level pattern matches scoped to the enclosing function, not a parser or a data-flow analysis. They are written to stay quiet when unsure, so they miss some real cases; and a match can still be a false alarm when the protection lives somewhere the rule does not look (another function, a wrapper, a server). No match is not proof the fault is absent.

Skipped: `node_modules`, `.git`, virtualenvs, `dist` / `build` / `out`, `vendor`, caches, `.d.ts` files, files over 1 MB and minified files (any line over 2,000 characters). Symlinks are not followed.

## The five rules

### `tool-call-after-truncation`

**Catalog:** [01](catalog/01-truncated-tool-call-runs-with-empty-arguments.md), [03](catalog/03-truncated-tool-call-completed-by-json-repair.md), [04](catalog/04-truncated-tool-call-in-agent-loop.md)

**Looks for:** a function that reads the model's stop reason (`finish_reason`, `finishReason`, `stop_reason`, `stopReason`, or a variable assigned from one) and runs the turn's tool calls (a loop or `.map` over `tool_calls` / `toolCalls` that calls something, or a call like `execute_tool_calls(...)`), with no earlier branch that compares the stop reason with a length value (`length`, `max_tokens`, `MAX_TOKENS`, `max_output_tokens`, `incomplete`) and leaves the turn (`return`, `raise`, `throw`, `break`, `continue`).

**Not flagged:** a length check that exits first; a flag such as `truncated = finish_reason == "length"` checked and exited on; an allow-list such as `if reason != "tool_calls": return`; tool calls run inside `if finish_reason == "tool_calls":`.

**Known limits:** code that never reads a stop reason is out of scope, so case 01's exact shape (no stop-reason check at all) is only caught when the same function reads the reason for something else. A guard in a different function (the caller) is not seen and the match is a false alarm.

### `repaired-json-applied`

**Catalog:** [02](catalog/02-truncated-answer-repaired-and-applied.md), [03](catalog/03-truncated-tool-call-completed-by-json-repair.md)

**Looks for:** a call into a lenient JSON repair library (`json_repair` / `repair_json`, `partial_json_parser`, `dirtyjson`, `jsonrepair`, `partial-json`, `best-effort-json-parser`, `untruncate-json`, `parsePartialJson`, including names imported from those modules) in a function that never mentions a stop reason, `truncated`, `incomplete`, `is_complete`, or the repaired-parse state.

**Not flagged:** repair inside a logging or print call (display only); a function that checks the stop reason or a truncation flag; the names inside strings or comments.

**Known limits:** a hand-written repair (closing brackets yourself) is not recognised. A check made in the caller is not seen. The rule does not follow where the repaired value goes, so a repair used only for a preview that is not a log call is still flagged.

### `stream-error-ignored`

**Catalog:** [05](catalog/05-workflow-error-chunk-reported-as-completed.md)

**Looks for:** a function that parses a stream itself (a stream marker such as `iter_lines`, `getReader()`, `for await`, `"data:"`, `split("\n")`, together with `json.loads` / `JSON.parse`) and branches on an event type (`if chunk["type"] == ...`, `elif`, `switch (evt.type)`, `match`) over two or more values, none of which is an error value, with no `else` / `default` that raises or throws and no other mention of an `error` key.

**Not flagged:** a branch for `error` / `failed`; an `if "error" in chunk` check; a default that raises; typed SDK streams that are not parsed by hand (the SDK raises on error events itself).

**Known limits:** dispatch through a dictionary of handlers, or a parser split over several functions, is not followed. Any mention of an `error` key in the function counts as handling it, even when the handling is wrong.

### `success-as-error`

**Catalog:** [06](catalog/06-structured-mcp-result-reported-as-tool-error.md), [10](catalog/10-http-200-reported-as-failed-tool-call.md)

**Looks for two shapes:**

1. (06) A `try` that runs a tool call and then, in the same block, a strict serialization (`json.dumps` without `default=`, or `JSON.stringify`), whose broad `except Exception` / `catch` produces an error result (an error string, `is_error=True`, `success=False`) without re-raising.
2. (10) A condition that sniffs a parsed response body for a `status` key together with `data` / `result` / `error` / `success` (`"status" in data and "data" in data`, `data.status && data.data`), where that body came from `.json()` / `json.loads` / `JSON.parse`, and the branch takes success or status from the body.

**Not flagged:** a tool call and its logging in separate `try` blocks; `json.dumps(..., default=str)`; a handler that re-raises; success taken from `response.ok` / the status code.

**Known limits:** falsy results (`0`, `False`, `{}`) treated as failure are not checked. A tool call the rule does not recognise by name (`call_tool`, `run_tool`, `tool.invoke`, `tools[name](...)` and similar) is missed.

### `retry-non-idempotent-write`

**Catalog:** pattern, not yet in catalog. No maintainer-confirmed case of ours for this one is in `docs/catalog/` yet; the rule is here because the shape is a well-known cause of duplicate orders, emails and charges.

**Looks for:** a write (`.post(` / `.patch(`, `method: "POST"`, `send_email(` and similar, `create_order(` and similar, `charges.create(` / `refunds.create(` and similar payment objects) inside an automatic retry: a `@retry` / `@tenacity.retry` / `@backoff.on_exception` decorated function, a loop whose header mentions `retry` / `attempt` / `tries`, or a wrapper such as `pRetry(async () => ...)`. Also a urllib3 `Retry(...)` whose `allowed_methods` is `None` / `False` or includes `POST` / `PATCH`. Only flagged when the file mentions no idempotency key (`idempot...`, `dedup..._key`, `client_token`, `clientRequestToken`).

**Not flagged:** retries of model calls (`chat.completions.create`, `messages.create`, `/v1/chat/...`, embeddings), reads (`GET`), `PUT`, and any file that mentions an idempotency key.

**Known limits:** a key set somewhere else (a shared client, a different file) is not seen and the match is a false alarm. A write inside a helper called from the retried function is missed. Retries configured in an HTTP client (axios-retry, a requests `Session` adapter in another file) are only seen for the urllib3 form above.

## Adding a rule

Rules live in `packages/code-check/src/rules.ts`. Each one needs a hit fixture and a false-positive control in `packages/code-check/testdata/<rule-id>/`, written as a minimal example of the shape (not copied from another project), and a test in `rules_test.ts`. If the pattern comes from a real case, add the case to `docs/catalog/` first and link it from the rule.
