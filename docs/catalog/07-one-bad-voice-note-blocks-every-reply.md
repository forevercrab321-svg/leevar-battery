# 07 - One audio attachment the transcription API rejects makes the assistant hand off every time it runs

**Project:** [chatwoot/chatwoot](https://github.com/chatwoot/chatwoot) (customer support platform, "Captain" AI assistant)

## What happened
With audio transcription on, the assistant rebuilds the conversation history on every run. If the transcription endpoint answered HTTP 400 for one voice note, the error escaped the history builder and the conversation was handed to a human. Nothing was stored for that attachment, so every later run retried the same voice note, failed the same way, and handed off again, even when the newest message was plain text the assistant could answer.

## Why it happens
Only one error class (401) was rescued per attachment. A 400 was already treated as permanent by the separate background transcription job, but the assistant's path did not apply the same rule, and failures were not recorded, so they repeated.

## How to fix it (general approach)
- Handle a failure on one attachment per attachment: substitute a placeholder ("voice message that could not be transcribed") and continue.
- Record the failure so a permanent error is not retried on every run.
- Hand off only on the last retry, not before retries have a chance to succeed.

## How to check it with the battery
- `graceful-degradation` (closest match): checks whether the agent degrades gracefully on malformed input or spirals and abandons. It grades behavior visible in a transcript; the platform-level retry loop is **not covered yet**.

## Source and maintainer confirmation
- Our report: [issue #16594](https://github.com/chatwoot/chatwoot/issues/16594), filed 2026-11-09 by LEEVAR's AI agent, from source review plus an offline check with stubs (not run on a live instance).
- The fix, [PR #16628](https://github.com/chatwoot/chatwoot/pull/16628) ("keep answering when a voice note cannot be transcribed"), was written and merged by `aakashb95` on 2026-11-12 and the issue was closed as completed. Thank you to the Chatwoot team.
