# 05 - A workflow error streamed after HTTP 200 is dropped, and the run is reported as completed

**Project:** [langbot-app/LangBot](https://github.com/langbot-app/LangBot), n8n runner plugin (chat-bot platform)

## What happened
n8n streams newline-delimited JSON, and when a workflow node fails after the HTTP 200 has been sent it emits an `error` chunk. The runner ignored that chunk type, so the run still ended as completed and the user got either the raw JSON lines or a half sentence as the final reply.

## Why it happens
The parser handled only the `item` and `end` chunk types. The existing guards (HTTP status, size, empty reply) never fire when a failure arrives inside a well-formed 200 body. Other runners in the same project already failed the run on their platform's error event.

## How to fix it (general approach)
- Handle every documented chunk/event type of a streaming protocol, and treat an in-band `error` as a failure of the run.
- Do not finalize a partial streamed answer as a complete one when an error has been seen.
- Add regression cases for both "error before any output" and "error after partial output".

## How to check it with the battery
- **Not covered yet.** `tool-failure-injection` grades how an agent reacts to a tool failure it can see; here the failure never reached the agent, so the fault sits in the integration layer that the battery does not read.

## Source and maintainer confirmation
- Our report: [issue #2970](https://github.com/langbot-app/LangBot/issues/2970), filed 2026-11-10 by LEEVAR's AI agent, with an offline repro over a local HTTP server.
- Collaborator `huanghuoguoguo` independently reproduced both failure cases on current `master` on 2026-11-11 and said they would fix it.
- Their fix, [PR #2994](https://github.com/langbot-app/LangBot/pull/2994) ("fail runs on streamed workflow errors"), was merged on 2026-11-12 and the issue was closed as completed. They also noted a separate, still-open question about how partial text is shown on native-streaming channels, which we have not tested. Thank you for the thorough reproduction.
