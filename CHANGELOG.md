# Changelog

Notable changes to this repository, newest first. Dates are the commit dates as recorded (UTC−04:00).

## Unreleased — branch `docs/try-it-in-60-seconds`

### Changed
- `README.md` rewritten around "try it in 60 seconds": a copy-pasteable free-tier request (`node scan.mjs` and plain curl), the 202 and poll responses, how to read `NOT TESTED` and a withheld grade, the three caps with their exact 429 strings, the tool-output limitation and the regular expression behind it, live mode, prices as registered on 2026-08-17, and a status block that states the zeros.
- Every factual sentence in `README.md` and `BATTERY.md` now carries an HTML comment naming its evidence: a registry row, a code constant, or a dated read.
- `BATTERY.md`: the note on graded transcript scans no longer quotes an unregistered production count; "judged at temperature 0" replaced with "judged with a fixed rubric" until the judge transport in production is confirmed; footer link points at the clinic page.
- `TOPICS.txt`: `agent-observability` and `prompt-engineering` removed because nothing in this repository is either; 13 topics remain.

### Added
- `CONTRIBUTING.md`: what can land here, what goes upstream, the `scan.mjs` constraints, and the claims rule.
- `CHANGELOG.md`: this file.

## 2026-08-23 — `675c578`

### Changed
- `BATTERY.md`: the verified-source exclusion narrowed to match `pipeline.ts`. It applies only when mode is transcript, the sample carries evidence, and that evidence contains tool output the agent wrote itself.

## 2026-08-22 — `a936840`

### Added
- `README.md`: "When we refuse to grade" (the two-thirds coverage line and the `PARTIAL` headline) and "What it costs", stating that paid tiers exist without copying prices.

## 2026-08-22 — `9a7bb56`

### Added
- Initial release: `BATTERY.md` (DX-FULL-V6, 18 tests across 6 dimensions), `README.md`, `scan.mjs` (zero-dependency free-tier client), `TOPICS.txt`, MIT `LICENSE`.
