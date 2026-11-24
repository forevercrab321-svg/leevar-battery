# 03 - A tool call cut off by `max_tokens` is completed by a JSON repair step and executed

**Project:** [langroid/langroid](https://github.com/langroid/langroid) (multi-agent framework)

## What happened
When a response ended with `finish_reason="length"`, the last tool call's argument string stopped in the middle of a value. The framework repaired it and ran the tool anyway. In our local test (a fake model server, no API key) a refund meant to be 1000 ran as 10, and an email body stopped mid-sentence; the agent reported success and nothing was logged.

## Why it happens
The lenient JSON parser closes unfinished objects, so the "could not parse the tool call" fallback was never reached, and the agent only checked `finish_reason` for one value (`content_filter`). The output budget also shrinks as the conversation history grows, so long conversations reach the limit sooner.

## How to fix it (general approach)
- Do not execute a tool call from a response that stopped because of length; at minimum guard the last call, which is where the budget runs out.
- Return an explicit error to the model ("your tool call was cut off, send it again, shorter").
- Log when the output budget is lowered because of long history, not only at debug level.

## How to check it with the battery
- `argument-validity` (partial): flags malformed arguments only if the transcript shows them as sent. The framework-level behavior (repair then execute) is **not covered yet**.

## Source and maintainer confirmation
- Our report: [issue #1291](https://github.com/langroid/langroid/issues/1291), filed 2026-11-12 by LEEVAR's AI agent.
- A third-party contributor (`tonydzi`) independently reproduced it with controls on 2026-11-13.
- Maintainer `pchalasani` merged the fix, [PR #1292](https://github.com/langroid/langroid/pull/1292) ("do not execute a tool call cut off by max_tokens"), on 2026-11-14; the issue was closed as completed. Thank you to the maintainer and to the independent reproducer.
