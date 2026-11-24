# Code check

`deno task check-code <path>` reads an agent project's Python and TypeScript / JavaScript code and points at places shaped like five faults that maintainers of real open-source projects confirmed. It runs offline: no model, no API key, no network. It reads your files and never executes or changes them.

```bash
deno task check-code ./my-agent                     # Markdown report
deno task check-code ./my-agent --exclude scripts   # leave a folder out (repeatable)
deno task check-code ./my-agent --include-tests     # also check test files
deno task check-code ./my-agent --json              # machine-readable result, with the same caveat
deno task check-code ./my-agent --fail-on-findings  # exit 3 on any match, for CI
```

Exit codes: `0` the check ran (with or without matches), `1` the path could not be read, `2` wrong arguments, `3` `--fail-on-findings` was given and something matched.

## What a match means

Every match is a **possible issue for a person to confirm**. The rules are line-level pattern matches scoped to the enclosing function, not a parser or a data-flow analysis. They are written to stay quiet when unsure, so they miss some real cases; and a match can still be a false alarm when the protection lives somewhere the rule does not look (another function, the caller, another file, a server). For the same reason **code that has been fixed can still match** when the fix went into a different function or file: in the catalog, cases 02 and 03 were fixed by passing a "truncated" flag up to the caller, and the repair call the rule points at did not change. No match is not proof the fault is absent.

Code at the top level of a file (outside any function) is not judged by the rules that need a function scope (`tool-call-after-truncation`, `stream-error-ignored`), because without a scope the rule would mix unrelated lines from the whole file.

In the Markdown report, several matches of one rule in one file are grouped, since they are usually the same issue in several code paths. The JSON keeps one entry per match and carries the same caveat (`disclaimer`) and a `rulesVersion`.

Skipped: `node_modules`, `.git`, virtualenvs, `dist` / `build` / `out`, `vendor`, caches, `.d.ts` files, files over 1 MB and minified files (any line over 2,000 characters). Symlinks are not followed. A file that cannot be read is listed in the report and the scan goes on.

**Test files are skipped by default** (`test/`, `tests/`, `__tests__/`, `*.test.*`, `*.spec.*`, `test_*.py`, `*_test.*`, `conftest.py`), because tests build these shapes on purpose; the report says how many were skipped. `--include-tests` checks them too. A test file named directly on the command line is always checked.

## The five rules

### `tool-call-after-truncation`

**Catalog:** [01](catalog/01-truncated-tool-call-runs-with-empty-arguments.md), [03](catalog/03-truncated-tool-call-completed-by-json-repair.md), [04](catalog/04-truncated-tool-call-in-agent-loop.md)

**Looks for:** a function that reads the model's stop reason (`finish_reason`, `finishReason`, `stop_reason`, `stopReason`, or a variable assigned from one) **before** it runs the turn's tool calls, with no branch in between that compares the stop reason with a length value (`length`, `max_tokens`, `MAX_TOKENS`, `max_output_tokens`, `incomplete`) and leaves the turn (`return`, `raise`, `throw`, `break`, `continue`).

"Runs the tool calls" means a loop or `.map` over `tool_calls` / `toolCalls` / `function_calls` whose body calls something whose name starts with a run verb (`execute`, `run`, `call`, `invoke`, `dispatch`, `handle`, `apply`) and either names a tool or function or takes the loop variable; or indexes a tool table (`tools[name](...)`); or a direct call such as `execute_tool_calls(...)` or `_handle_tool_execution(...)`.

Not counted as reading the stop reason: a type or interface field (`finishReason?: string`), an object key or keyword argument being written (`stopReason: ...`, `stop_reason=...` on the left), a stop reason destructured from the result of a tool run (`const { finish_reason } = await runToolCall(...)`, on one line or several), and any read after the tool calls.

Not counted as running a tool: accumulating streamed fragments (a loop over `delta.tool_calls`, `chunk...`), predicates (`isToolCallParamsAllowed(call)`, `validate...`, `get...`), and builders whose name merely contains a verb (`_function_call_item(...)`).

**Not flagged:** a length check that exits first; a flag such as `truncated = finish_reason == "length"` checked and exited on; an allow-list such as `if reason != "tool_calls": return`; tool calls run inside `if finish_reason == "tool_calls":`.

**Known limits:** code that never reads a stop reason is out of scope, so case 01's exact shape (no stop-reason check at all) is missed, and so is case 03's execution site, which was in a different function from the one that read the stop reason. A guard in a different function or file is not seen and the match is a false alarm. A loop nested inside a callback (`batches.map(async (b) => { for (const c of b.toolCalls) ... })`) is judged within the callback only, so a stop-reason read outside it is not connected.

### `repaired-json-applied`

**Catalog:** [02](catalog/02-truncated-answer-repaired-and-applied.md), [03](catalog/03-truncated-tool-call-completed-by-json-repair.md)

**Looks for:** a call into a lenient JSON repair library in a function that never mentions a stop reason, `truncated`, `incomplete`, `is_complete`, or the repaired-parse state. A call counts only when its name was imported from a known repair module (`json_repair`, `partial_json_parser`, `dirtyjson`, `jsonrepair`, `partial-json`, `best-effort-json-parser`, `untruncate-json`, `json-repair`, and `parsePartialJson` from `ai` / `@ai-sdk/*`), including aliases and `import *`, or is written module-qualified (`json_repair.loads(...)`).

**Not flagged:** repair inside a logging or print call (display only); a function that checks the stop reason or a truncation flag; the names inside strings or comments; a function of your own that happens to be called `repairJson` (not imported from a repair library); the line that defines such a function.

**Known limits:** a hand-written repair (closing brackets yourself, or a helper of your own with any name) is not recognised. This is why catalog case 02 (paperless-ai) is **not** caught: its repair function is its own `repairJson`, not an imported library. A check made in the caller is not seen, so fixed code can still match (cases 02 and 03 were fixed in the caller). The rule does not follow where the repaired value goes, so a repair used only for a preview that is not a log call is still flagged.

### `stream-error-ignored`

**Catalog:** [05](catalog/05-workflow-error-chunk-reported-as-completed.md)

**Looks for:** a function that parses a stream itself and branches on the type of each parsed event, over two or more values, none of which is an error value, with no `else` / `default` that raises or throws and no other mention of an `error` key. "Parses a stream itself" means a stream marker (`iter_lines`, `readline`, `getReader()`, `for await`, `async for`, `"data:"`, `split("\n")`, `EventSource`, NDJSON / event-stream) and that the variable whose type is compared (`chunk["type"]`, `evt.type`, `switch (evt.type)`, `match`) was assigned from `json.loads` / `JSON.parse` inside a loop in that function.

**Not flagged:** a branch for `error` / `failed`; an `if "error" in chunk` check; a default that raises; typed SDK streams that are not parsed by hand (the SDK raises on error events itself); plain type switches that do not compare a JSON-parsed value (schema mappers, message-part handlers).

**Known limits:** dispatch through a dictionary of handlers, or a parser split over several functions, is not followed. Any mention of an `error` key in the function counts as handling it, even when the handling is wrong.

### `success-as-error`

**Catalog:** [06](catalog/06-structured-mcp-result-reported-as-tool-error.md), [10](catalog/10-http-200-reported-as-failed-tool-call.md)

**Looks for two shapes:**

1. (06, Python only) A `try` that runs a tool call and then, in the same block, a strict `json.dumps` (no `default=` or `cls=`), whose broad `except Exception` produces an error result (an error string, `is_error=True`, `success=False`) without re-raising. JavaScript is left out: `JSON.stringify` on plain data does not throw in practice, and every match on real code was noise.
2. (10) A condition that sniffs a parsed response body for a `status` key together with `data` / `result` / `error` / `success` (`"status" in data and "data" in data`, `data.status && data.data`), where that body came from `.json()` / `json.loads` / `JSON.parse`, and the branch takes success or status from the body.

**Not flagged:** a tool call and its logging in separate `try` blocks; `json.dumps(..., default=str)`; a handler that re-raises; success taken from `response.ok` / the status code.

**Known limits:** falsy results (`0`, `False`, `{}`) treated as failure are not checked. A tool call the rule does not recognise by name (`call_tool`, `run_tool`, `tool.invoke`, `tools[name](...)` and similar) is missed.

### `retry-non-idempotent-write`

**Catalog:** pattern, not yet in catalog. No maintainer-confirmed case of ours for this one is in `docs/catalog/` yet; the rule is here because the shape is a well-known cause of duplicate orders, emails and charges.

**Looks for:** a write (`.post(` / `.patch(`, `method: "POST"`, `send_email(` and similar, `create_order(` and similar, `charges.create(` / `refunds.create(` and similar payment objects) inside an automatic retry: a `@retry` / `@tenacity.retry` / `@backoff.on_exception` decorated function, a loop whose header mentions `retry` / `attempt` / `tries`, or a wrapper such as `pRetry(async () => ...)`. Also a urllib3 `Retry(...)` whose `allowed_methods` is `None` / `False` or includes `POST` / `PATCH`. Only flagged when the file mentions no idempotency key (`idempot...`, `dedup..._key`, `client_token`, `clientRequestToken`).

**Not flagged:** retries of model and speech calls (`chat.completions.create`, `messages.create`, `/v1/chat/...`, embeddings, Ollama `/api/chat` and `/api/generate`, TTS / speech); reads (`GET`), `PUT`; POSTs that authenticate or look things up (a write line or enclosing function name mentioning token, oauth, auth, search, query, lookup, match, graphql, login, verify, validate, screen); loops that retry only on HTTP 429 (never on 5xx or timeouts) and re-raise network errors; and any file that mentions an idempotency key.

**Known limits:** a key set somewhere else (a shared client, a different file) is not seen and the match is a false alarm. A generic request helper with a retry (`makeRequest(endpoint, payload)`) is flagged even when every caller sends a harmless request, because the endpoint is not visible in the helper. A write inside a helper called from the retried function is missed. The read-only word list is a heuristic: a POST to a URL containing "search" that does change state would be missed. Retries configured in an HTTP client (axios-retry, a requests `Session` adapter in another file) are only seen for the urllib3 form above.

## Adding a rule

Rules live in `packages/code-check/src/rules.ts`. Each one needs a hit fixture and a false-positive control in `packages/code-check/testdata/<rule-id>/`, written as a minimal example of the shape (not copied from another project), and a test in `rules_test.ts`. If the pattern comes from a real case, add the case to `docs/catalog/` first and link it from the rule.
