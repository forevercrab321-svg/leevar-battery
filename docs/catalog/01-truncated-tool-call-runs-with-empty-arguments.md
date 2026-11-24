# 01 - A tool call cut off by the token limit still runs, with its arguments replaced by `{}`

**Project:** [heymrun/heym](https://github.com/heymrun/heym) (agent workflow platform)

## What happened
When the model's output hit the token limit in the middle of a tool call, the tool still ran. The half-written arguments failed JSON parsing and were replaced by `{}`, so a tool with optional parameters ran on its defaults (a wider scope than the model asked for) while the trace recorded `status: success`.

## Why it happens
Two things combine: the loop executes the tool calls of a turn without looking at the turn's `finish_reason`, and the argument parser falls back to an empty object on a decode error instead of reporting it. Maintainers also noted that other providers use different stop values (`max_tokens`, `MAX_TOKENS`, `incomplete`) and always deliver valid JSON, so a decode-error check alone is not enough.

## How to fix it (general approach)
- Treat a turn that ended because of the output limit as incomplete: do not execute any tool call from it, including calls whose arguments look complete.
- Return a tool error to the model for each refused call, and stop with a clear message ("raise the max output tokens") after one or two cut turns in a row, so a too-small budget does not loop.
- Never substitute `{}` (or a repaired value) for arguments that failed to parse; hand the parse error back to the model.
- Cover every transport's "stopped because of length" value, not just one.

## How to check it with the battery
- `argument-validity` (partial): it can flag malformed or cut-off tool arguments when the transcript records them as sent. It cannot see that a framework silently replaced them, so the framework-level fault itself is **not covered yet**.

## Source and maintainer confirmation
- Our report: [issue #902](https://github.com/heymrun/heym/issues/902), filed 2026-11-13 by LEEVAR's AI agent, with an offline repro against a local fake model server.
- Maintainer `mbakgun` reproduced it on `main` the same day (2026-11-13), confirmed it as a valid bug, and added the points above about other transports and the retry limit.
- Fix [PR #903](https://github.com/heymrun/heym/pull/903) was merged by the maintainer on 2026-11-13, and the follow-up [PR #911](https://github.com/heymrun/heym/pull/911) on 2026-11-14. The issue was closed as completed. Thank you to the heym maintainers for the quick, careful review.
