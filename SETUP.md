# First local scan — for people and agents

This is the local, open-source workflow. It does not register you for a hosted
service, create an account, install an integration, or authorize a paid model
call. Read the commands before running them. Deno 2.x is required; if it is
missing, ask the operator to install it using the official Deno instructions.

## 1. Try the report without a model

From this repository:

```sh
deno task demo
```

This uses a deterministic mock judge, not a real assessment of your agent. The
shipped example produces PARTIAL, with 12 of 18 probes evidenced and no overall
grade. That is an intentional evidence boundary, not an installation failure. Do
not keep rerunning it to obtain a passing grade.

## 2. Check your input locally

Use a text file containing a conversation, or a `.json` array of conversation
strings. Use real samples you have permission to process, and remove customer
identifiers and secrets before sending samples to any provider.

```sh
deno task doctor --transcript examples/transcript-support-bot.json --mock
```

For a real provider, choose the provider you intend to use for the scan:

```sh
deno task doctor --transcript ./conversation.json --provider openai --max-calls 18
```

This reads only the selected provider's conventional key variable. Configure
that variable in your local environment; do not paste the key into a chat,
report, commit, or command-line argument. The doctor command has no network
permission and does not authenticate the key or inspect your provider balance.

| Provider            | Environment variable |
| ------------------- | -------------------- |
| `openai`            | `OPENAI_API_KEY`     |
| `anthropic`         | `ANTHROPIC_API_KEY`  |
| `gemini`            | `GEMINI_API_KEY`     |
| `deepseek`          | `DEEPSEEK_API_KEY`   |
| `openrouter`        | `OPENROUTER_API_KEY` |
| `openai-compatible` | `LLM_API_KEY`        |
| `ollama` / `--mock` | No key required      |

- `blocked`: fix the named input/configuration problem before continuing.
- `locally_ready`: the checked local prerequisites passed. Provider
  authentication, endpoint availability, model availability and quota are
  **unverified**. No scan has run and no grade exists yet.

The diagnostic is JSON. It does not include your transcript or API key —
measured on both of its own streams: stdout and stderr.

One stream is not doctor's to control. `deno task` prints the command it is
about to run, so anything you typed on the command line is already in your
terminal and your shell history before doctor starts. Doctor refuses a
`--base-url` carrying userinfo (`invalid_base_url`, exit 2), but that refusal
happens after the echo. Keep credentials in environment variables, and if one
did reach a command line, treat it as exposed and rotate it. `--dry-run` on the
existing scan command is a configuration preview, not a replacement for the
doctor input/key-presence check.

## 3. Run only when the destination and cost boundary are acceptable

The next command sends your transcript to your selected provider. That provider
may charge your account. Local readiness alone is not authorization to run it.
An agent must stay within the user's existing scope and budget; if these do not
cover the call, stop and ask.

```sh
deno task scan --transcript ./conversation.json --provider openai --max-calls 18 --json
```

Use the same provider, model, endpoint and call ceiling you checked. The call
ceiling bounds attempts, not dollars or tokens. Eighteen calls allow one attempt
per probe; retries may exhaust that ceiling and terminate the run. You can
choose another explicit ceiling. An Ollama configuration needs no API key but
requires your own running server and installed model; an offline check cannot
verify those.

## 4. Interpret the result before taking another action

- A provider/configuration error is not a defect in the agent being assessed.
- `grade_withheld` means insufficient or unusable evidence, not a zero or a
  passing grade. `composite_reference` must not be advertised as a formal grade.
- A successful scan process may legitimately produce no overall grade.
- Tool output written inside an agent's own transcript is not independently
  verified tool evidence. Do not fabricate additional samples to raise coverage.
- Keep stdout if you want a local result file; review the report's contents
  before sharing it. There is no automatic upload or hosted history for this
  local workflow.

## 5. Recover deliberately

If a process or connection fails, inspect the error and any existing output
before rerunning. The present CLI does not offer durable resume or provider-side
idempotency: another scan may repeat paid model calls. Do not retry
automatically on the assumption that a timeout means nothing ran.

The existing provider adapter already retries some transient failures once
inside a scan, subject to its call ceiling. This warning concerns starting an
additional scan; the doctor upgrade does not change that internal retry policy.
Even an internal retry can repeat a request whose remote outcome is unknown.

Fixing your agent yourself is a valid next step. Paid treatment or marketplace
registration is optional and is not required to run or read a local scan.

## Evidence to provide when asking for help

Include the repository revision, Deno version, provider name, diagnostic error
code, and whether the command was demo, doctor or scan. Remove secrets and
customer data. Key presence, a completed HTTP request, a usable verdict and a
verified improvement are different claims; report only what you observed.
