# The GitHub Action

Runs the battery against your agent and turns the result into a build outcome.
It is a thin wrapper around `scan.mjs`; every rule about flags, exit codes and
masking lives in the client, so CI and the terminal cannot drift apart.

## Read this before you schedule it

Without an API key the action uses the free tier: **five scans per calendar
month per email address**, plus a per-network daily cap and a platform-wide
daily cap. A workflow that runs on every push exhausts five scans in a week and
then fails with a 429 — a red build that says nothing about your agent. For
anything on a schedule or on every push, use an API key
(`hello@leevarai.org`); for a monthly or release-gated run, the free tier is
enough.

A transcript that contains tool output the agent wrote about itself can evidence
at most 12 of 18 probes. The line for a letter is 13 of 18, so such a scan comes
back **withheld** — not failed. That is why `fail-on-withheld` defaults to
`false`: a withheld letter is a statement about the evidence you supplied. For
tool-using agents, use `live-endpoint`.

## Gate a release on the grade

```yaml
name: agent reliability
on:
  release:
    types: [published]

jobs:
  battery:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - uses: forevercrab321-svg/leevar-battery@main
        with:
          name: support-bot
          transcript: samples/refund.txt
          api-key: ${{ secrets.LEEVAR_API_KEY }}
          fail-below: B+
```

The step fails when the grade is below B+. The run's summary carries the
per-dimension table; the email address, if you used one, is masked there,
because run pages can be public.

## Live mode, for an agent that calls tools

```yaml
      - uses: forevercrab321-svg/leevar-battery@main
        with:
          name: support-bot
          live-endpoint: https://staging.example.com/agent
          live-headers: |
            x-api-key=${{ secrets.BOT_KEY }}
          api-key: ${{ secrets.LEEVAR_API_KEY }}
          fail-below: '88'
          fail-on-withheld: 'true'
```

Header values never appear in the log or the summary. `fail-below` accepts a
letter or a composite number.

## Report instead of gate

```yaml
      - uses: forevercrab321-svg/leevar-battery@main
        id: battery
        continue-on-error: true
        with:
          name: support-bot
          transcript: samples/refund.txt
          email: you@example.com

      - name: Comment the result
        if: always()
        run: |
          echo "grade=${{ steps.battery.outputs.grade }}"
          echo "withheld=${{ steps.battery.outputs.withheld }}"
          echo "exit=${{ steps.battery.outputs['exit-code'] }}"
          echo "report=${{ steps.battery.outputs['report-url'] }}"
```

Outputs are written before the client exits, so they are readable on every
outcome — including the failures.

## Inputs

| Input | Required | Notes |
|---|---|---|
| `name` | yes | Agent name on the report |
| `transcript` | one of | Path; newline-separated for several samples |
| `live-endpoint` | one of | URL we POST each probe to |
| `live-headers` | no | `name=value` per line; values never printed |
| `email` | unless `api-key` | Report recipient; the free tier is keyed on it |
| `api-key` | no | From a secret. Without it: free tier |
| `fail-below` | no | Letter or composite number |
| `fail-on-withheld` | no | Default `false` |
| `job` | no | Hire Check job file |
| `tier` | no | `scan` or `full`; `full` needs a key |
| `source` | no | Recorded locally only — the API has no field for it yet |
| `timeout` | no | Seconds; default 1500. The scan keeps running after |
| `api-url` | no | Base URL override, for a stub |
| `working-directory` | no | Where the paths resolve |

## Outputs

`grade` · `composite` · `withheld` · `report-url` · `scan-id` · `status` ·
`verdict` · `exit-code`.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Pass, or no gate requested |
| 1 | Below `fail-below` |
| 2 | Grade withheld, and `fail-on-withheld` was set |
| 3 | The server refused the request; its message is printed |
| 4 | Usage error |
| 5 | The scan ran and failed server-side. When the fault is ours, the free scan is credited back |
| 6 | Timed out waiting. Resume with `--scan-id` |
| 7 | Could not reach the API |

## Resuming a timed-out run

`timeout` stops the wait, not the scan. The scan id is in the outputs and in the
summary:

```bash
node scan.mjs --scan-id SCN-2026-1234 --email you@example.com
```
