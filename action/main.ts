#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env --allow-net
// The GitHub Action's entry point. action.yml runs this file; everything it
// touches outside itself — environment, network, clock, files — comes in
// through `ActionIo`, so the tests can drive all of it from memory.
//
// WHEN THIS STEP FAILS
// --------------------
//   - Wrong inputs (no transcript, a transcript that resolves outside the
//     workspace or is not a regular file under 5 MiB, an unknown mode, a
//     fail-on the scale does not have, local mode with no provider): always.
//     A setting that silently does nothing is worse than a red step.
//   - The result does not clear `fail-on`: only when `fail-on` gates.
//   - No result at all (LEEVAR refused, was unreachable, timed out, or failed
//     the scan; a provider failed mid-run): only when `fail-on` gates — a gate
//     cannot pass on a result that does not exist. Under `never` it is a
//     warning, and the summary says plainly what happened.
//
// A PARTIAL result is a result. Under `never` it does not fail the step, for
// the same reason the CLI exits 0 on it: a step that went red on a refusal
// would teach everyone to retry until the gate gave up.

import { readSamples } from "../cli/scan.ts";
import { mockJudge } from "../cli/mock-judge.ts";
import { gradeBattery } from "../packages/scanner-core/src/grade-battery.ts";
import { ProbeError } from "../packages/scanner-core/src/probe.ts";
import type { Judge } from "../packages/scanner-core/src/judge-types.ts";
import {
  type JudgeOptions,
  makeJudge,
  PROVIDER_IDS,
  ProviderError,
} from "../packages/providers/src/index.ts";
import { DEFAULT_API_URL, runHosted } from "./hosted.ts";
import {
  type Engine,
  type FailOn,
  gate,
  gradeOutput,
  InputError,
  noResult,
  type Outcome,
  outcomeFromLocal,
  parseFailOn,
  renderSummary,
  testedOutput,
} from "./outcome.ts";

export interface ActionIo {
  env: (name: string) => string | undefined;
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  stdout: (line: string) => void;
  appendFile: (path: string, data: string) => Promise<void>;
  writeFile: (path: string, data: string) => Promise<void>;
  /** Injected by tests; the real one otherwise. */
  makeJudge?: (o: JudgeOptions) => Judge;
}

interface Inputs {
  transcript: string;
  mode: "hosted" | "local";
  failOn: FailOn;
  email?: string;
  agentName: string;
  agentType?: string;
  provider?: string;
  model?: string;
  baseUrl?: string;
  timeoutMs: number;
}

function readInputs(env: (n: string) => string | undefined): Inputs {
  const get = (n: string) => (env(n) ?? "").trim();
  const transcript = get("INPUT_TRANSCRIPT");
  if (!transcript) {
    throw new InputError(
      "transcript: required — the path to a .txt or .json transcript in your repository.",
    );
  }

  const mode = get("INPUT_MODE") || "hosted";
  if (mode !== "hosted" && mode !== "local") {
    throw new InputError(`mode: "${mode}" is not hosted or local.`);
  }
  const failOn = parseFailOn(get("INPUT_FAIL_ON"));

  const minutesRaw = get("INPUT_POLL_TIMEOUT_MINUTES") || "20";
  const minutes = Number(minutesRaw);
  if (!/^\d+(\.\d+)?$/.test(minutesRaw) || minutes <= 0 || minutes > 360) {
    throw new InputError(
      `poll-timeout-minutes: "${minutesRaw}" is not a number of minutes between 0 and 360.`,
    );
  }

  const provider = get("INPUT_PROVIDER") || undefined;
  if (mode === "local") {
    if (!provider) {
      throw new InputError(
        `provider: local mode needs one — ${
          [...PROVIDER_IDS, "mock"].join(", ")
        }.`,
      );
    }
    if (provider !== "mock" && !PROVIDER_IDS.includes(provider)) {
      throw new InputError(
        `provider: "${provider}" is not one of ${
          [...PROVIDER_IDS, "mock"].join(", ")
        }.`,
      );
    }
  }

  const repo = get("GITHUB_REPOSITORY");
  return {
    transcript,
    mode,
    failOn,
    email: get("INPUT_EMAIL") || undefined,
    agentName: get("INPUT_AGENT_NAME") || repo.split("/").pop() ||
      "agent under test",
    agentType: get("INPUT_AGENT_TYPE") || undefined,
    provider,
    model: get("INPUT_MODEL") || undefined,
    baseUrl: get("INPUT_BASE_URL") || undefined,
    timeoutMs: minutes * 60_000,
  };
}

/**
 * The largest transcript this step reads: 5 MiB. Far above any real set of
 * conversation samples, and far below what would stall a runner or post a
 * runaway body to LEEVAR.
 */
export const MAX_TRANSCRIPT_BYTES = 5 * 1024 * 1024;

const isPermissionError = (err: unknown) =>
  err instanceof Deno.errors.NotCapable ||
  err instanceof Deno.errors.PermissionDenied;

/**
 * Refuse a transcript this step must not read, before anything reads it.
 *
 * A pull request can commit a symlink, and `--allow-read` does not follow one:
 * Deno checks the path it is handed, not where the link points. So the path is
 * resolved here and must land inside the workspace, links included. Then it
 * must be a regular file under `maxBytes`, so a device such as /dev/zero, a
 * FIFO or a directory is refused instead of read forever.
 *
 * A relative path is joined to the workspace, as documented ("relative to the
 * repository root"), not to the working directory. Returns the path to read:
 * that joined path, not the resolved one, because when the workspace path
 * itself runs through a symlink the resolved path is outside the
 * `--allow-read` scope even though it is the same file.
 */
export async function checkTranscript(
  transcript: string,
  workspace: string,
  maxBytes: number = MAX_TRANSCRIPT_BYTES,
): Promise<string> {
  const windows = Deno.build.os === "windows";
  const sep = windows ? "\\" : "/";
  const absolute = windows
    ? /^([A-Za-z]:)?[\\/]/.test(transcript)
    : transcript.startsWith("/");
  const path = absolute
    ? transcript
    : (workspace.endsWith(sep) ? workspace : workspace + sep) + transcript;
  let ws: string;
  try {
    ws = await Deno.realPath(workspace);
  } catch (err) {
    throw new InputError(
      `GITHUB_WORKSPACE: ${workspace} cannot be read (${
        err instanceof Error ? err.message : String(err)
      }).`,
    );
  }
  let real: string;
  try {
    real = await Deno.realPath(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      throw new InputError(
        `transcript: ${transcript} does not exist (paths are relative to the repository root).`,
      );
    }
    if (isPermissionError(err)) {
      throw new InputError(
        `transcript: ${transcript} is outside the repository (${ws}); this step reads only the workspace.`,
      );
    }
    throw new InputError(
      `transcript: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const root = ws.endsWith(sep) ? ws : ws + sep;
  if (real !== ws && !real.startsWith(root)) {
    throw new InputError(
      `transcript: ${transcript} resolves outside the repository (${real}); links out of the workspace are refused.`,
    );
  }
  const info = await Deno.stat(path);
  if (!info.isFile) {
    throw new InputError(
      `transcript: ${transcript} is not a regular file.`,
    );
  }
  if (info.size > maxBytes) {
    throw new InputError(
      `transcript: ${transcript} is ${info.size} bytes; this step reads at most ${maxBytes}.`,
    );
  }
  return path;
}

/** Workflow-command data escaping, so a message cannot end its own line. */
const escapeData = (s: string) =>
  s.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
/** Output values are single-line; anything else could write a second output. */
const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ");

async function runLocal(
  inputs: Inputs,
  samples: string[],
  io: ActionIo,
): Promise<Outcome> {
  const scanId = `local-${new Date(io.now()).toISOString().slice(0, 10)}`;
  const engine = inputs.provider === "mock" ? "mock" : "local";
  let judge: Judge;
  try {
    judge = engine === "mock" ? mockJudge() : (io.makeJudge ?? makeJudge)({
      provider: inputs.provider!,
      model: inputs.model,
      baseUrl: inputs.baseUrl,
      readEnv: io.env,
    });
  } catch (err) {
    // A missing key or base URL is a setting, not a finding about the agent.
    throw new InputError(err instanceof Error ? err.message : String(err));
  }
  try {
    const result = await gradeBattery({
      scanId,
      agent: {
        name: inputs.agentName,
        model: "",
        type: inputs.agentType ?? "",
        description: "",
      },
      mode: "transcript",
      tier: "local",
      access: { mode: "transcript", transcript: samples },
    }, { judge });
    return outcomeFromLocal(result, scanId, engine);
  } catch (err) {
    if (err instanceof ProbeError) throw new InputError(err.message);
    // Not a finding about the agent: the run stopped, so there is no result.
    const why = err instanceof Error ? err.message : String(err);
    return noResult(
      "error",
      engine,
      scanId,
      err instanceof ProviderError
        ? `the model provider failed before the battery finished: ${why}`
        : `the local run stopped before the battery finished: ${why}`,
    );
  }
}

export async function runAction(io: ActionIo): Promise<number> {
  let failOn: FailOn = { kind: "never" };
  let engine: Engine = (io.env("INPUT_MODE") ?? "").trim() === "local"
    ? "local"
    : "hosted";
  let outcome: Outcome;
  let configError = false;

  try {
    const inputs = readInputs(io.env);
    failOn = inputs.failOn;
    if (inputs.provider === "mock") engine = "mock";

    const transcriptPath = await checkTranscript(
      inputs.transcript,
      io.env("GITHUB_WORKSPACE") || Deno.cwd(),
    );
    let samples: string[];
    try {
      samples = await readSamples(transcriptPath);
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) {
        throw new InputError(
          `transcript: ${inputs.transcript} does not exist (paths are relative to the repository root).`,
        );
      }
      throw new InputError(
        `transcript: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (samples.every((s) => !s.trim())) {
      throw new InputError(`transcript: ${inputs.transcript} is empty.`);
    }

    if (inputs.mode === "hosted") {
      // Fixed, not configurable: an environment variable that could redirect
      // the transcript is one any earlier step could set. Tests inject `fetch`.
      const apiUrl = DEFAULT_API_URL;
      const chars = samples.reduce((n, s) => n + s.length, 0);
      io.stdout(
        `Sending ${samples.length} sample${
          samples.length === 1 ? "" : "s"
        } (${chars} characters) to ${apiUrl}. ` +
          "LEEVAR grades them with third-party language models and deletes them 30 days after the scan.",
      );
      outcome = await runHosted({
        apiUrl,
        agent: {
          name: inputs.agentName,
          ...(inputs.agentType ? { type: inputs.agentType } : {}),
        },
        samples,
        email: inputs.email,
        timeoutMs: inputs.timeoutMs,
      }, { fetch: io.fetch, sleep: io.sleep, now: io.now, log: io.stdout });
    } else {
      if (inputs.email) {
        io.stdout(
          "::notice::email is used only in hosted mode; this local run ignores it.",
        );
      }
      outcome = await runLocal(inputs, samples, io);
    }
  } catch (err) {
    if (!(err instanceof InputError)) throw err;
    configError = true;
    outcome = noResult("error", engine, null, err.message);
  }

  const verdict = configError
    ? { fail: true, reason: outcome.message }
    : gate(outcome, failOn);
  const summary = renderSummary(outcome, { failOn, gate: verdict });

  const reportPath = `${io.env("RUNNER_TEMP") || "."}/leevar-battery-${
    (io.env("GITHUB_ACTION") || "report").replace(/[^A-Za-z0-9_.-]/g, "_")
  }.md`;
  await io.writeFile(reportPath, summary);
  const summaryFile = io.env("GITHUB_STEP_SUMMARY");
  if (summaryFile) await io.appendFile(summaryFile, summary);

  const outputs: Record<string, string> = {
    "scan-id": outcome.scanId ?? "",
    "grade": gradeOutput(outcome),
    "tested": testedOutput(outcome),
    "report": reportPath,
    "status": outcome.status,
  };
  const outputFile = io.env("GITHUB_OUTPUT");
  const lines = Object.entries(outputs).map(([k, v]) => `${k}=${oneLine(v)}\n`)
    .join("");
  if (outputFile) await io.appendFile(outputFile, lines);
  else io.stdout(lines.trimEnd());

  // One annotation, saying the thing a reader of the run page needs first.
  if (outcome.status === "complete") {
    const what = outcome.grade
      ? `grade ${outcome.grade}, ${testedOutput(outcome)} tests evidenced`
      : `PARTIAL, ${
        testedOutput(outcome) || "unknown"
      } tests evidenced, no grade issued`;
    io.stdout(
      verdict.fail
        ? `::error::LEEVAR Battery: ${
          escapeData(`${what} — ${verdict.reason}`)
        }`
        : `::notice::LEEVAR Battery: ${escapeData(what)}`,
    );
  } else {
    const what = `no result (${outcome.status}): ${outcome.message ?? ""}`;
    io.stdout(
      `${verdict.fail ? "::error::" : "::warning::"}LEEVAR Battery: ${
        escapeData(what)
      }`,
    );
  }
  return verdict.fail ? 1 : 0;
}

if (import.meta.main) {
  Deno.exit(
    await runAction({
      env: (n) => Deno.env.get(n),
      fetch: globalThis.fetch,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      now: () => Date.now(),
      stdout: (l) => console.log(l),
      appendFile: (p, d) => Deno.writeTextFile(p, d, { append: true }),
      writeFile: (p, d) => Deno.writeTextFile(p, d),
    }),
  );
}
