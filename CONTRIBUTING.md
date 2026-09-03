# Contributing

This repository holds three things: a published rubric (`BATTERY.md`), a zero-dependency client for the free tier (`scan.mjs`), and the documentation around them. The grader itself runs on leevar.live and is not in this repository, so some contributions land here and some have to go upstream.

## What belongs here

- Fixes and improvements to `scan.mjs` (constraints below).
- Documentation: anything in `README.md` that is wrong, unclear or stale.
- Reports that the API contract documented here does not match what the endpoint does: a field that differs, a cap that behaves differently, an error string that changed.
- Disagreement with a probe design, as an issue. The rubric text is generated upstream and is carried there.

## What cannot be merged here

- Edits to the probe text in `BATTERY.md`. It is generated from the running battery definition; a hand edit would make this file disagree with what actually grades you. Open an issue titled `battery: ...` instead.
- Any sentence that states a number, a customer, a comparison or a superlative without an evidence pointer. Claims in this project are checked against a registry before they ship; `README.md` shows the convention (an HTML comment after each factual sentence naming a registry row, a code constant, or a dated read). A PR that adds a claim without one will be asked to add the pointer or drop the sentence. Words this project does not use: verified (unqualified), certified, guaranteed, trusted by, industry-leading, "the only", "first".
- Grader changes. The grader is not here.

## `scan.mjs` constraints

- Zero dependencies. Node 18 or newer (global `fetch`, top-level `await`).
- A non-2xx response must exit non-zero and print the body. Printing "no findings" for an HTTP 429 is the defect this battery grades other agents on.
- `agent` is sent as an object. The API accepts a bare string with a 202 and files the scan as "Unnamed agent"; the client must not let that happen.
- No telemetry, no extra network calls, no writes outside the working directory.
- Keep the usage line accurate: `node scan.mjs <email> <agent-name> <transcript-file>`, exit code 2 when arguments are missing.

## Reporting a grade you disagree with

Open an issue with the `scan_id`, the `coverage` block from the poll response, and the probe names you dispute. Do not paste transcripts that contain customer data, credentials or anything you cannot publish; describe them instead, or say so and we will arrange a private channel.

## Process

1. Fork, branch, one change per pull request.
2. Run `node scan.mjs` with no arguments; it must print the usage line and exit 2.
3. If you touched the request shape, check it against the endpoint's validation before spending a free scan: a POST without `email` returns 400, a POST with an empty `transcript` returns 400, and neither creates a scan.
4. In the PR, say what changed, why, what evidence you checked, and what is not claimed.
5. There is no CLA. By contributing you agree that your contribution is licensed under this repository's MIT license.

## Contact

Issues here are the primary channel. For anything you cannot post publicly: hello@leevarai.org.

## Conduct

Be specific, cite evidence, assume good faith. A one-line correction with a pointer is worth more than a paragraph of opinion.
