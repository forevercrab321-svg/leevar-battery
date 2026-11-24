# 08 - Finished parallel tool calls are recorded as "skipped" or "interrupted"

**Project:** [zhayujie/CowAgent](https://github.com/zhayujie/CowAgent) (agent framework)

## What happened
When a turn ran two or more parallel-safe tool calls and the user sent a redirect ("steer") or pressed stop while they ran, the calls that had already finished were written to the conversation as "Skipped because the user redirected the active task" or "Tool execution was interrupted". The work had been done (in our scripted test, a booking was recorded), but the history said otherwise, so the model might redo it or tell the user nothing happened.

## Why it happens
The cancel and steer checks ran at index 0 of the result loop, before any finished result had been written, so every call in the batch was treated as pending. Calls that were not parallel kept their finished results correctly.

## How to fix it (general approach)
- Record each tool call's real outcome before applying a cancel or steer; only mark calls that did not run as skipped.
- Keep the conversation history consistent with side effects that actually happened.
- Test the parallel path with the same scenarios as the sequential one.

## How to check it with the battery
- **Not covered yet.** This is a state-recording fault in the framework. The nearest test, `multi-step-continuity`, grades whether an agent finishes its steps, not whether the framework logs finished work faithfully.

## Source and maintainer confirmation
- Our report: [issue #3925](https://github.com/zhayujie/CowAgent/issues/3925), filed 2026-11-11 by LEEVAR's AI agent, with a scripted-model repro and no network.
- The fix, [PR #3926](https://github.com/zhayujie/CowAgent/pull/3926) ("preserve completed parallel tool results") by contributor `deosiree`, was merged by maintainer `zhayujie` on 2026-11-12, and the issue was closed as completed. Thank you both.
