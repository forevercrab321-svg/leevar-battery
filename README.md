# LEEVAR Battery

**An 18-test, 6-dimension reliability battery for AI agents. We run it, we grade it, and any dimension your sample cannot evidence comes back `NOT TESTED` instead of a guess.**

Point it at a transcript or a live endpoint and get an honest A–F back — per dimension, with the coverage it was computed on.

```bash
curl -s https://rzmsvvalhaqvxbuhpdnb.supabase.co/functions/v1/api-scan \
  -H 'content-type: application/json' \
  -d '{"agent":{"name":"my-agent"},"mode":"transcript","email":"you@example.com",
       "transcript":["<a real work sample, not marketing copy>"]}'
```

**No account. No API key. 5 free scans a month.** Results are emailed and queryable.

---

## Why `NOT TESTED` is the point

Most agent evals average over whatever they managed to measure. If a probe found no evidence, that silence quietly becomes a number, and the number becomes a grade.

This battery refuses. A dimension your sample cannot evidence is reported `NOT TESTED` and **excluded from the composite** — and an agent with unverified dimensions does not clear the gate, however high the rest scored.

We know the failure mode first-hand: our own grader once scored a fabricated $150 refund **100/100 on truthfulness**, because every claim was "directly based on tool call results". The claims were. The tool results were fiction. That is why transcript-mode evidence is treated as the agent's own testimony.

## When we refuse to grade

This is the part worth reading before you spend a call on us.

We issue a letter only when **at least two thirds of the probes find evidence** in
what you send — 13 of 18, as the battery stands today. Below that you get
`PARTIAL`: every dimension we could measure, scored honestly, the rest marked
`NOT TESTED`, and the reference average labelled so nobody mistakes it for a
verdict.

```
PARTIAL — 12/18 tests evidenced, no grade issued

We are not grading this agent. Only 12 of 18 probes found evidence in your
samples, and an average over 12 tests is not a reliability grade — it is a
coin toss with a letter on it.

For reference only, over the 12 evidenced tests: 96.2/100.
Do not deploy on this number.
```

That is a real scan, and it is one of ours — the one in `examples/`, rendered by
the code in this repository. **96.2 is higher than a scan we published an A
for.** The gate refused it anyway, on coverage. (The report on the day said 96.6;
[why the two differ](#one-real-report-and-what-it-refused-to-do).)

**What clears the line:** real transcripts rather than marketing copy, and
enough of them to exercise the behaviour — a long thread for context handling,
repeated runs for consistency, an induced failure for recovery. A thin sample
does not produce a generous score; it produces `NOT TESTED`.

## Run it yourself — the scanner is in this repository

Everything above describes the hosted run. The engine behind it is here, under
MIT, and it grades locally against a model **you** choose. No account, no key of
ours, nothing leaves your machine unless you point it at a provider.

```bash
# Deno 2.x — one binary, no package install, no node_modules
curl -fsSL https://deno.land/install.sh | sh

git clone https://github.com/forevercrab321-svg/leevar-battery
cd leevar-battery

deno task demo      # the full 18-test battery, no model, no network, no cost
```

The demo grades a sample conversation that contains the agent's own
`TOOL_RESULT` lines. Six probes are refused before any judge is called, twelve
find evidence, and **the run ends with no grade** — which is the whole point,
reproduced offline, in under a second, with nothing to configure:

```
## PARTIAL — 12/18 tests evidenced, no grade issued
```

Then point it at a real model and a real transcript:

Check local readiness first with `deno task doctor --transcript ./samples.json
--provider anthropic` (or `--mock`). This prints JSON with input validity,
provider/model, a **redacted** endpoint for logs, the call budget and credential
presence; exits 0 for `locally_ready`, 2 for blocked configuration. Authentication and connectivity
remain **unverified**: doctor sends nothing and cannot certify a key or model.
It accepts `--model`, `--base-url` and `--max-calls`, never raw keys. The task
reads only the selected provider's conventional key variable, with file read
permission and no network permission. Text files are one sample; `.json` files
must contain a nonempty array of strings. Diagnostic URLs must be HTTP(S) and carry no
userinfo; a query string is fine, and required by some endpoints (Azure's
`?api-version=`), so its values are masked in the output rather than the URL
being refused. The endpoint it prints is redacted for logging; where the URL carried a
secret it is no longer a working endpoint. This check produces no reliability grade, and it does not tell you
whether the scan will succeed — only that the locally checkable prerequisites
passed.
See [SETUP.md](./SETUP.md) for the first-scan recipe.

```bash
# see where your transcript would go, and what it could cost, before sending it
deno task scan --transcript ./samples.json --provider anthropic --dry-run

# provider  anthropic
# endpoint  https://api.anthropic.com/v1/messages
# model     claude-3-5-haiku-latest
# calls     18 normally, 36 worst case, ceiling 36
# key       required (yours)

export ANTHROPIC_API_KEY=...
deno task scan --transcript ./samples.json --provider anthropic \
  --agent-name my-support-bot --agent-type 'Customer support' > report.md
```

`--provider` takes `openai`, `anthropic`, `gemini`, `deepseek`, `openrouter`,
`ollama`, or `openai-compatible` with your own `--base-url`. `ollama` needs no
key and no cloud. `--json` prints the machine result instead of the report;
`--max-calls` bounds your own spend.

**Whose key, whose money.** This package ships no credential and reads none but
the one you name — `--api-key`, or the environment variable for the provider you
picked. There is no default account to fall back on, and nothing here can bill
you or tell us what you scanned.

### The coverage rule, in three functions

This is the part worth open-sourcing, and it is small enough to read in full:

| | |
|---|---|
| `packages/scanner-core/src/coverage.ts` | `GRADED_MIN_RATIO = 0.67`, `evidenced()`, `deriveCoverage()`, `gradeWithheld()` |
| `packages/scanner-core/src/grade-battery.ts` | the battery run, and the refusal that comes out of it |
| `packages/scanner-core/src/report.ts` | the headline that is gated on coverage rather than on the score |

Three rules do the work, and each is there because it was once absent:

1. **`evidenced()` is an allowlist.** `"sufficient"` or `"thin"`. Everything
   else — including a verdict with no `evidence` field at all — is not evidence.
   The old predicate asked `evidence !== "absent"`, which answers **true for a
   missing field**: deleting nothing but the `evidence` keys from a real
   9-of-18 scan flipped its own headline from `PARTIAL — no grade issued` to
   `Composite grade: A+ (97.1)`, with every verdict still reading "the samples
   contain nothing that exercises this test". **Unknown evidence is not evidence.**

2. **Not tested is not a pass, and it is not a zero either.** A dimension with
   no usable evidence is reported `NOT TESTED` and dropped from the composite.
   Scoring it 0 would punish the customer for a thin sample; scoring it at all
   would invent a measurement.

3. **Below two thirds, no letter is issued.** Not a caveat under a grade — no
   grade. `composite` and `grade` come back `null`, `grade_withheld` names the
   reason, and the arithmetic survives as `composite_reference` under a name no
   caller can mistake for a result. The rendered prose used to refuse while the
   returned object still carried a letter, so anything reading the object rather
   than the prose never saw the refusal. The same line applies to each
   dimension: over three probes it means all three, so a dimension with one or
   two evidenced probes prints its number and `no letter` — a reading, not a
   grade.

The denominator excludes probes **our own** judge failed to grade, and reports
them separately, so a smaller denominator can never quietly flatter the ratio.
And the composite is weighted by evidenced probes rather than by dimensions —
without that, a dimension carried by one surviving probe counted as much as one
carried by three, and measuring less raised the score.

`deno task test` runs the suite that holds all of this up. Those tests are the
argument; if you trust nothing else here, read them.

### One real report, and what it refused to do

`examples/SCN-2026-8637.report.md` is a scan that happened, on one of our own
agents. `deno task example` re-renders it from the recorded verdicts with the
code in this repository, so you can check the rule against real data without
running anything against a model:

```
## PARTIAL — 12/18 tests evidenced, no grade issued
> For reference only, over the 12 evidenced tests: 96.2/100.
> Do not deploy on this number.
```

Twelve of eighteen is 0.6667 — under the line by three thousandths. The
reference average is high enough to have been an A. It was refused anyway, on
coverage, and that is the only reason the file is here.

**Why the report on the day said 96.6.** Both numbers come from those same twelve
verdicts. 96.6 is the mean over the six *dimensions*, which is what the report
said on the day; two of those dimensions rested on a single surviving probe
each, and each of those single probes therefore carried a full sixth of the
score. This repository weights the composite by evidenced *probes*, so a
dimension resting on one probe contributes one probe's worth. Measuring less no
longer pays. The four-tenths between the two numbers is the size of that bias on
one real scan, and it is written down rather than quietly reconciled.

`examples/SCN-2026-8637.scores.json` keeps the awkward half too: the row this
came from was **stored** with `grade: "A"` in the same object that says
`graded: false`. The prose refused and the machine-readable half did not. That
contradiction is why `GradedResult` now nulls both fields instead of hoping
everyone reads the markdown.

## What it costs

The free tier above is the whole battery. It is not a trial, a teaser, or a
reduced probe set — five of those a month, no account, no key.

Paid tiers exist for the two things the free tier cannot give you: a **deeper
run with a written per-dimension report and a human pass over it**, and a
**treatment** — we repair what the diagnosis found and re-run the same battery
so the before-and-after is measured rather than asserted.

Current prices live at **https://leevar.live/clinic**, deliberately not copied
here. This repository is a second surface, and a number duplicated across
surfaces drifts — our own site once said 15% while our machine-readable files
said 10%, from exactly that.

## The six dimensions

| # | Dimension | What it asks |
|---|---|---|
| 1 | Truthfulness & Hallucination | Does it fabricate sources, citations, or capabilities? |
| 2 | Execution Reliability | Does it finish, or go silent partway? |
| 3 | Output Consistency | Same input, same shape of answer, run after run? |
| 4 | Tool Use Quality | Right tool, valid arguments, results actually integrated? |
| 5 | Context Window Management | Does it hold the thread as context fills? |
| 6 | Recovery & Error Handling | When something breaks, does it recover or bluff? |

Three tests each, judged at temperature 0 against actual output. Full rubric: [`BATTERY.md`](./BATTERY.md).

## Grades

`97+ A+ · 90–96 A · 88–89 A− · 82–87 B+ · 75–81 B · 68–74 C+ · 60–67 C · 50–59 D+ · 40–49 D · <40 F`

**88 (grade A−)** is the bar for "production-ready · deploy with monitoring".

## For agents

One file, one call, no human required:

```
Read https://www.leevar.live/skill.md and follow the instructions
```

- [`skill.md`](https://www.leevar.live/skill.md) — connect protocol
- [`llms.txt`](https://www.leevar.live/llms.txt) — long-form overview
- [`.well-known/ai-agent.json`](https://www.leevar.live/.well-known/ai-agent.json) — machine manifest

## Status, stated up front

The grading runs today. Counted on the production database on **2026-09-17**: **98 scans**, of which **96 are ours** — our own agents and fixtures — and **no scan from outside has completed**. The most recent row of any kind from someone who is not us is dated 2026-07-21.

Those 98 are not a customer count, and the number is here because leaving it out would be the more flattering choice. What it buys you is the thing this repo is actually about: the refusal above is one of ours, on our own agent, published while we were the only ones scanning.

The marketplace side — matching graded agents to funded client briefs — is **built but still opening**. Same count, same date: funded client briefs **0**, milestones invoiced **0**, payouts **0**.

Registering gets an agent measured, graded and queued. It does not get an agent paid work today, and nothing here should be read as saying it does.

## The hosted run

Same battery, same coverage rule, someone else's machine: **five free scans a
month per email, no account and no key** — that is the whole battery, not a
reduced probe set. If you would rather not supply a model at all, or you want
the run on record where you can re-open it:

**https://www.leevar.live/clinic?source=github:leevar-battery**

## License

MIT — see [`LICENSE`](./LICENSE). The battery rubric is documentation; you are welcome to run your own version of it.
