# The client

`scan.mjs` submits a scan and, unless you tell it not to, waits for the report
and turns the result into an exit code. Node 20 or newer, no dependencies.

```bash
node scan.mjs --email you@example.com --name support-bot --transcript ./thread.txt
```

`--help` prints the full flag list, the exit codes and the caps. This file
covers the things a flag list cannot say.

## What the free tier costs you

Five scans per calendar month per email address, twenty per network address per
day, and a platform-wide daily cap the operator sets. Every one of them spends
real model calls on our side, which is why they are counted. `--dry-run` prints
the request it would send, redacted, and spends nothing — use it while you are
getting the arguments right.

## Which input to use

`--transcript` is your agent's own conversations. It is the fast path, and it
has one limit worth knowing before you spend a scan: six of the eighteen probes
have to establish whether a cited source or a tool result is real. If the
samples contain tool output, that output was written by the agent under test, so
it cannot establish anything — those six probes are marked `absent` before any
judging happens. Twelve of eighteen is below the thirteen-of-eighteen line, so
the letter is withheld. The client says so up front rather than after the wait.

`--live` is the path for a tool-using agent: we call your endpoint once per
probe with `{"input", "test", "dimension"}` and grade what comes back. Headers
you pass with `--header` are sent and never printed.

## Gating

```bash
node scan.mjs --email you@example.com --name support-bot \
  --transcript ./thread.txt --fail-below B+
```

Exit 1 when the grade is below B+. `--fail-below` also takes a composite number
(`--fail-below 88`). `--fail-on-withheld` turns a withheld letter into exit 2;
leave it off if you would rather see a withheld result as information than as a
failure.

## Reading the result yourself

```bash
node scan.mjs --email you@example.com --name support-bot \
  --transcript ./thread.txt --json | jq '{grade, composite, coverage}'
```

`--json` puts the machine-readable result on stdout and keeps progress on
stderr, so a pipe gets only the payload. Gate on `coverage.graded`, not on
`composite`: when it is false, `grade` and `composite` are null and
`grade_withheld` says why.

## Long scans

The client polls every 15 seconds and gives up after 25 minutes by default. It
gives up on waiting, not on the scan — the scan id it printed still resolves:

```bash
node scan.mjs --scan-id SCN-2026-1234 --email you@example.com
```

## An API key

`LEEVAR_API_KEY` is sent as a bearer token and never printed. With a key the
per-email monthly ceiling does not apply and `--tier full` becomes available.
Ask at hello@leevarai.org.

## Testing against a stub

`--api https://localhost:8787` (or `LEEVAR_API_URL`) points the client somewhere
else. The test suite uses this: `npm test` runs 37 tests against a local stub
server and never reaches the real API.
