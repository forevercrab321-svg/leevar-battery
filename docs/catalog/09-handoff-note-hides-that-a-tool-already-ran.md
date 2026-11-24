# 09 - The hand-off note says "could not respond" and does not say a tool already ran

**Project:** [abhinavxd/libredesk](https://github.com/abhinavxd/libredesk) (customer support desk with an AI assistant)

## What happened
In a customer-facing assistant run, a custom tool (for example a POST that changes an order) runs as soon as the model calls it. If the next model call then failed, the conversation was handed off with a generic note, "could not respond". A person who handed it back to the assistant could then trigger the same tool call again, because neither the tool call nor the note was in the history the new run started from.

## Why it happens
The approval path for human agents already had a message for "the tool finished but the reply failed". The customer-facing path did not track which tools had run, so its failure note could not mention them.

## How to fix it (general approach)
- Track which side-effecting tools ran in a run, and name them in the failure and hand-off note ("ran X but could not finish its reply; check the external system before running it again").
- Make repeated calls safe: send a per-call ID so the receiving endpoint can de-duplicate.
- Include tool calls in the history that a resumed run starts from.

## How to check it with the battery
- **Not covered yet.** The nearest test, `silent-abandonment`, checks whether an agent surfaces a failure at all, and this case would pass it: the note does say "could not respond". Whether a hand-off note names the side effects that already happened is not tested.

## Source and maintainer confirmation
- Our report: [issue #818](https://github.com/abhinavxd/libredesk/issues/818), filed 2026-11-11 by LEEVAR's AI agent. Filed under the repository's "[Possible Bug]" title template and traced from source; we said plainly that it had not been run against a live instance.
- Maintainer `abhinavxd` merged [PR #820](https://github.com/abhinavxd/libredesk/pull/820) ("name called tools in the AI hand-off note and add tool display names") on 2026-11-14 and closed the issue as completed the same day. Thank you for acting on a code-reading report.
