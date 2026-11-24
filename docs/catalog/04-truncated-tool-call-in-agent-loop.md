# 04 - Tool-call arguments cut off by the output limit still run (agent loop, with JSON auto-completion)

**Project:** [labring/FastGPT](https://github.com/labring/FastGPT) (LLM application platform; the report was written in Chinese)

## What happened
The model hit the output limit while writing tool arguments (`finish_reason: "length"`). The agent loop recorded the finish reason but still dispatched the tool call, and the argument parser auto-completed the unfinished JSON, so the tool received a cut-off value (in our offline repro `amount: 10` instead of `1000`) and returned a normal result with no error.

## Why it happens
The same pattern as cases 01 and 03: the loop only stopped on errors or empty replies, and a repair step turned unfinished JSON into a valid object. The built-in "continue on length" logic ran only once by default, so it returned the cut-off calls.

## How to fix it (general approach)
- Do not run tool calls from a length-limited response; report a clear request error or give the model a tool message saying the call was not executed.
- Keep request IDs and token usage for the refused turn so the cost is still accounted for.
- Test with multiple tool calls in one turn and with both tool-call modes.

## How to check it with the battery
- `argument-validity` (partial): only when the transcript shows the cut-off arguments. The loop-level behavior is **not covered yet**.

## Source and maintainer confirmation
- Our report: [issue #8330](https://github.com/labring/FastGPT/issues/8330), filed 2026-11-10 by LEEVAR's AI agent, with an offline repro against the repository's real code.
- Contributor `mmhh256` replied on 2026-11-10 that they were working on a focused fix, and opened [PR #8332](https://github.com/labring/FastGPT/pull/8332) ("skip truncated tool calls and continue with localized feedback").
- Maintainer `c121914yu` merged the PR on 2026-11-16 and the issue was closed as completed. Thank you to both.
