# Fault catalog: real agent faults, confirmed by their maintainers

Each entry is a fault in a real open-source agent project that we reported and that the maintainers confirmed (reproduced it, merged a fix, or closed the issue as completed). Every entry links to the original issue and records how and when the maintainers confirmed it, so you can check the facts yourself. Our reports were filed by LEEVAR's AI agent in November 2026; the entries describe what the original thread says, nothing more.

We list these to be useful, not to point at anyone. Every project below responded quickly and carefully, and the fixes are theirs. Thank you.

Each entry has the same parts: what happened, why it happens, how to fix it in general terms, which battery test (if any) can surface it, and the source with the maintainers' confirmation.

## How to read the "battery" line

The battery grades an agent from a transcript or a live probe. Many of these faults live in the framework around the model (how a tool result is recorded, how a stream is parsed), which a transcript does not show. Where no battery test fits, the entry says **not covered yet** rather than stretching a test to fit. Where a test partly fits, the entry says "partial" and what it can and cannot see.

| # | Fault | Project | Battery test | Maintainer confirmation |
|---|-------|---------|--------------|-------------------------|
| [01](01-truncated-tool-call-runs-with-empty-arguments.md) | Cut-off tool call runs with `{}` arguments | heymrun/heym | `argument-validity` (partial) | Reproduced; fix merged (2026-11-13, 2026-11-14) |
| [02](02-truncated-answer-repaired-and-applied.md) | Cut-off answer repaired and written to the store | clusterzx/paperless-ai | `format-contract-adherence` (partial) | Confirmed; fix released (2026-11-17) |
| [03](03-truncated-tool-call-completed-by-json-repair.md) | Cut-off tool call completed by JSON repair and run | langroid/langroid | `argument-validity` (partial) | Independently reproduced; fix merged (2026-11-14) |
| [04](04-truncated-tool-call-in-agent-loop.md) | Cut-off tool arguments run in the agent loop | labring/FastGPT | `argument-validity` (partial) | Fix merged (2026-11-16) |
| [05](05-workflow-error-chunk-reported-as-completed.md) | Streamed workflow error dropped, run reported completed | langbot-app/LangBot | not covered yet | Independently reproduced; fix merged (2026-11-12) |
| [06](06-structured-mcp-result-reported-as-tool-error.md) | Successful structured tool result sent to the model as an error | emcie-co/parlant | not covered yet | Fix merged (2026-11-10) |
| [07](07-one-bad-voice-note-blocks-every-reply.md) | One unreadable attachment blocks every later reply | chatwoot/chatwoot | `graceful-degradation` (closest) | Fix merged (2026-11-12) |
| [08](08-completed-parallel-tool-calls-recorded-as-skipped.md) | Finished parallel tool calls recorded as skipped | zhayujie/CowAgent | not covered yet | Fix merged (2026-11-12) |
| [09](09-handoff-note-hides-that-a-tool-already-ran.md) | Hand-off note hides that a tool already ran | abhinavxd/libredesk | `silent-abandonment` (partial) | Fix merged (2026-11-14) |
| [10](10-http-200-reported-as-failed-tool-call.md) | HTTP 200 reported as a failed tool call | simstudioai/sim | not covered yet | Fix merged (2026-11-11) |

Four entries are not covered yet, and the partial ones cover the visible symptom, not the framework fault. If you want to extend the battery to cover them, that is a welcome contribution.
