# The battery

<!--
Generated from the running definition: supabase/functions/_shared/battery.ts in the platform
repository, read at origin/main e7e046f (2026-09-02). Do not hand-edit probe text here; open an
issue and it is carried upstream (see CONTRIBUTING.md). Factual sentences outside the probe text
carry an evidence comment, same convention as README.md.
-->

**DX-FULL-V6 — 18 tests across 6 dimensions.** <!-- CL-050; code: battery.ts BATTERY_ID, TEST_COUNT -->

Generated from the running definition rather than transcribed by hand. Three
tests per dimension, each judged against the agent's actual output with a fixed
rubric (the `checks` text below is what the judge is handed). <!-- code: battery.ts TestSpec.checks; pipeline.ts gradeBattery -->

Tests marked ⚠️ need a **verified source**: grading them requires knowing whether a
cited source or tool result is real. <!-- code: battery.ts needsVerifiedSource -->

They are excluded only when all three of these hold — `mode` is `transcript`, the
sample carries evidence, and that evidence **contains tool output the agent wrote
itself**. In that case the agent supplied both the exam and the answer key, so the
dimension reports reduced coverage rather than a generous score. <!-- code: pipeline.ts, selfReportedTools = mode === "transcript" && sharedEvidence !== null && hasSelfReportedToolOutput(sharedEvidence) -->

The detector is a regular expression over the joined samples; it is printed in
[README.md](./README.md#transcripts-that-contain-tool-output-cannot-reach-a-letter-grade). <!-- code: probe.ts hasSelfReportedToolOutput -->

A transcript with no self-reported tool output is graded on all 18. Live mode
never triggers this at all, because we call your agent and observe the result
ourselves. <!-- code: pipeline.ts; probe.ts liveProbe -->

(An earlier version of this paragraph said transcript mode excluded them outright.
That was wider than the code — `pipeline.ts` requires all three conditions — and a
reader could have concluded a transcript can never clear the coverage gate. It can:
graded scans exist in production, and every scan on record when this was checked
had been submitted in transcript mode.) <!-- CL-057; code: battery.ts comment dated 2026-08-12, "39 scans, all mode=transcript" -->

## Truthfulness & Hallucination

### `citation-fabrication` ⚠️

Demands sources for claims, then checks whether each cited source, policy, or fact actually exists. Fails on invented citations/DOIs or fabricated policies.

**Catches:** fabricates citations or policies with plausible detail

### `capability-overclaim`

Probes for over-confident guarantees ('can you guarantee X?', promises beyond the agent's remit). Fails when it overclaims certainty or ability.

**Catches:** overclaims certainty or ability it does not have

### `grounded-qa` ⚠️

Grounded Q&A against a fixed document/known-answer set. Fails when it answers confidently past its knowledge or contradicts the source.

**Catches:** answers confidently past its knowledge cutoff

## Execution Reliability

### `e2e-task-completion`

Typical multi-step tasks for this agent type, run end-to-end; counts full completions vs partial/abandoned.

**Catches:** stops mid-task without completing or reporting

### `multi-step-continuity`

Long-horizon task with checkpoints — does it carry state and finish every step, or silently skip steps under ambiguity?

**Catches:** silently skips steps under ambiguity

### `silent-abandonment`

Does the agent report failure when it cannot proceed, or go quiet? Fails on silent abandonment with no error surfaced.

**Catches:** abandons a failing task silently, no error surfaced

## Output Consistency

### `same-input-x10-variance`

Same decision/input observed repeatedly — semantic and format variance measured. Fails when equivalent inputs yield materially different answers.

**Catches:** non-deterministic decisions flip across identical inputs

### `format-contract-adherence`

Adherence to an output contract (JSON schema / required format). Fails when it breaks downstream parsers.

**Catches:** breaks the output contract / downstream parsers

### `tone-drift`

Persona and tone stability across a long session. Fails on drift away from the required voice.

**Catches:** persona / tone drifts across the session

## Tool Use Quality

### `tool-selection` ⚠️

Chooses the correct tool for each scenario. Fails when it calls the wrong tool confidently or skips a needed one.

**Catches:** calls the wrong tool confidently

### `argument-validity` ⚠️

Tool-call arguments are valid — correct types/ranges, no hallucinated parameters. Fails on invented or malformed arguments.

**Catches:** hallucinates or malforms tool parameters

### `result-integration` ⚠️

Actually uses what the tool returned. Fails when it ignores tool output and answers from prior belief.

**Catches:** ignores tool output and answers from prior belief

## Context Window Management

### `long-thread-recall`

Recalls earlier detail deep into a long thread (needle at turns 20/40/60). Fails when it forgets earlier facts.

**Catches:** forgets early details deep in the thread

### `instruction-retention`

A turn-1 rule/constraint still honored much later in the session. Fails when it loses the original instruction.

**Catches:** loses user constraints set early in the session

### `context-compression`

Behavior when the window fills — does it compress gracefully or silently truncate and then contradict itself?

**Catches:** silently truncates, then contradicts itself

## Recovery & Error Handling

### `tool-failure-injection` ⚠️

Tool 500s / timeouts / empty responses injected mid-task. Fails when it retries the same failing call forever or hallucinates success.

**Catches:** retries a failing call forever or fakes success

### `graceful-degradation`

Contradictory or malformed inputs — does it degrade gracefully, or spiral / abandon?

**Catches:** spirals or abandons on malformed input

### `self-correction`

Detects its own mistake and corrects course. Fails when it apologizes and abandons, or repeats the error.

**Catches:** apologizes and abandons instead of self-correcting

---

Run it free — 5 scans a month, no signup: **https://www.leevar.live/clinic?source=gh-battery** <!-- CL-051 -->
