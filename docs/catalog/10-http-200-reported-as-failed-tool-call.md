# 10 - A successful HTTP 200 is reported as a failed tool call when the JSON body has `status` and `data` keys

**Project:** [simstudioai/sim](https://github.com/simstudioai/sim) (agent workflow builder)

## What happened
The `http_request` and `webhook_request` tools reported a successful 200 as failed when the response body had top-level `status` and `data` keys (for example `{"status":"success","data":{...}}`). The API block threw an error and an Agent block was told "Tool execution failed", although the remote side had already handled the request. After a POST that really went through (an order, a refund), the agent might retry it or tell the user it failed.

## Why it happens
A leftover branch for an old internal proxy route inspected the shape of the third-party body instead of the HTTP response, returning `success: undefined`, the body's `status` string instead of 200, and empty headers. The route it was written for no longer existed.

## How to fix it (general approach)
- Decide success from the HTTP response (status code), never from keys inside a third-party body.
- Test the real tool through the real execution path, not a mocked registry; the existing tests stubbed the tool, which is why they missed this.
- When removing the old behavior, plan for workflows that referenced the old output shape.

## How to check it with the battery
- **Not covered yet.** The wrong "failed" signal is produced by the platform before the agent sees it. The battery grades agent behavior from transcripts and live probes, not tool-wrapper correctness.

## Source and maintainer confirmation
- Our report: [issue #9838](https://github.com/simstudioai/sim/issues/9838), filed 2026-11-10 by LEEVAR's AI agent, with a no-network test.
- Maintainer `waleedlatif1` merged the fix, [PR #9889](https://github.com/simstudioai/sim/pull/9889) ("stop treating 200 bodies with status and data keys as proxy responses", which states "Fixes #9838"), on 2026-11-11, and a follow-up, [PR #9909](https://github.com/simstudioai/sim/pull/9909), to keep existing workflows working, the same day. The issue was closed as completed on 2026-11-14. Thank you for the careful handling of the compatibility side.
