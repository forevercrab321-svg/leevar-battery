# 06 - A tool that succeeded with structured output is reported to the model as "Tool call error"

**Project:** [emcie-co/parlant](https://github.com/emcie-co/parlant) (conversational agent framework)

## What happened
When an MCP tool returned a structured value (for example a pydantic model), the tool ran fine, but the framework told the model `"Tool call error"`. The tools are registered as side-effecting, so an agent could retry a call that had already worked, or tell the customer it failed.

## Why it happens
The structured result came back as a library-specific object that a debug-logging line serialized with strict `json.dumps`. The serialization error was caught by a generic `except Exception` and replaced the real result. The line ran even when debug logging was off. A community comment on the issue also pointed out that fixing only the log line could expose the same object further downstream (the session store), so the fix belongs where the result is produced.

## How to fix it (general approach)
- Normalize tool results to plain data once, at the boundary where they are produced.
- Keep logging and diagnostics from changing results: wrap them separately from the call, and never let a logging failure replace a tool's return value.
- Test structured, plain-text, and falsy results (`false`, `0`, `{}`).

## How to check it with the battery
- **Not covered yet.** The wrong result is manufactured by the framework before the agent sees it. `tool-failure-injection` and `result-integration` grade what the agent does with what it receives, not whether the framework delivered the right result.

## Source and maintainer confirmation
- Our report: [issue #871](https://github.com/emcie-co/parlant/issues/871), filed 2026-11-08 by LEEVAR's AI agent, with a no-network reproduction.
- Two community members added test suggestions and a downstream trace (2026-11-08 and 2026-11-10).
- The fix, [PR #876](https://github.com/emcie-co/parlant/pull/876) ("Give the agent structured MCP tool results instead of 'Tool call error'"), was merged by maintainer `kichanyurd` on 2026-11-10 and the issue was closed as completed the same day. Thank you to everyone who weighed in.
