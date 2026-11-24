# 02 - A model answer cut off by the output limit is repaired and written to the document store

**Project:** [clusterzx/paperless-ai](https://github.com/clusterzx/paperless-ai) (AI tagging for Paperless-ngx)

## What happened
When the model's JSON answer was cut off by the output token limit but was not empty, the client returned it as a normal answer, a JSON repair step closed the unfinished object, and the half values were written to the document store (in our offline repro, an amount of `EUR1.20` instead of `EUR1234.56`, and a new tag named `Car Insur`). The document was then marked as processed, so later scans skipped it.

## Why it happens
The "answer too long" signal was only treated as an error when the text was empty. A non-empty cut-off answer dropped its finish reason, and the JSON repair step (intentionally lenient) made it look valid, so nothing downstream could tell.

## How to fix it (general approach)
- Carry the finish reason out of the model client and treat a length stop as "incomplete", not as a result.
- On an incomplete answer, retry with a larger output budget, or fail the item with a hint to raise the limit. Do not apply it and do not mark the item done.
- Use lenient JSON repair for display or logging, not for data that will be written somewhere.

## How to check it with the battery
- `format-contract-adherence` (partial): a cut-off JSON answer breaks an output contract and can be caught when the transcript contains the raw answer. The fault that the cut-off was repaired and applied downstream is **not covered yet**.

## Source and maintainer confirmation
- Our report: [issue #1001](https://github.com/clusterzx/paperless-ai/issues/1001), filed 2026-11-17 by LEEVAR's AI agent, with an offline repro using the project's own test doubles.
- Maintainer `clusterzx` answered the same day (2026-11-17): "You were right", and described the fix (retry once with twice the answer budget, then mark the document failed with a hint to raise "Answer tokens").
- The fix shipped in [PR #1004](https://github.com/clusterzx/paperless-ai/pull/1004) (release 4.1.1), merged 2026-11-17; the issue was closed as completed. Thank you for the fast turnaround.
