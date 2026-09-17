#!/usr/bin/env -S deno run --allow-read --allow-env --allow-net
// Run the battery locally, against a transcript, with your own model key.
//
//   deno task demo                      # no key, no network, no cost
//   deno task scan --transcript ./t.txt --provider anthropic
//   deno task scan --transcript ./t.txt --provider openai-compatible \
//                  --base-url http://localhost:8000/v1/chat/completions
//
// WHOSE KEY, AND WHOSE MONEY
// --------------------------
// Yours, and yours. This CLI ships no credential and reads none but the one you
// name: `--api-key`, or the environment variable for the provider you chose.
// There is no default account to fall back on. `--dry-run` prints the provider,
// the endpoint your transcript is about to be sent to, and the call ceiling,
// and then exits without sending anything.
//
// EXIT CODES, BECAUSE A SCRIPT WILL READ THEM
// -------------------------------------------
//   0  the battery ran — INCLUDING when it refused to issue a grade
//   1  the provider, the key, the endpoint or the network failed
//   2  the arguments were wrong
//
// A withheld grade is exit 0 on purpose. It is a result, not an error: the
// scanner measured what it could and declined to average over the rest. A CLI
// that exited non-zero there would teach every caller to retry until the gate
// gave up, which is the opposite of what the gate is for.

import { gradeBattery } from "../packages/scanner-core/src/grade-battery.ts";
import { batteryLabel } from "../packages/scanner-core/src/battery.ts";
import { GRADED_MIN_RATIO } from "../packages/scanner-core/src/coverage.ts";
import { ProbeError } from "../packages/scanner-core/src/probe.ts";
import type { Judge } from "../packages/scanner-core/src/judge-types.ts";
import {
  DEFAULT_KEY_ENV,
  describe,
  makeJudge,
  PROVIDER_IDS,
  ProviderError,
} from "../packages/providers/src/index.ts";
import { mockJudge } from "./mock-judge.ts";

const USAGE = `leevar-battery — ${batteryLabel()}

  deno task scan --transcript <file> [options]

REQUIRED
  --transcript <file>   A .txt file (one sample) or a .json file containing an
                        array of strings (several samples).

MODEL (pick one)
  --provider <id>       ${PROVIDER_IDS.join(" | ")}
  --mock                No model, no network, no cost. Deterministic verdicts,
                        labelled as such in the report. For trying the shape.

OPTIONS
  --model <name>        Override the provider's default model.
  --base-url <url>      Override the endpoint. Required for openai-compatible.
  --api-key <key>       The key itself. Otherwise the provider's env var is
                        read: ${
  Object.entries(DEFAULT_KEY_ENV)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ")
}.
  --agent-name <name>   Name printed on the report. Default: "agent under test".
  --agent-type <type>   e.g. "Customer support". Helps the examiner.
  --agent-model <class> Model class of the agent BEING TESTED, e.g. "gpt-4-class".
  --max-calls <n>       Hard ceiling on model calls for this run.
  --json                Print the machine result instead of the Markdown report.
  --dry-run             Print what would be sent and where, then stop.
  -h, --help            This.

A grade is issued only when at least ${
  Math.round(GRADED_MIN_RATIO * 100)
}% of the probes find evidence in
your samples. Below that you get every dimension that could be measured, scored
honestly, and no letter. That refusal is the product.
`;

interface Args {
  [k: string]: string | boolean | undefined;
}

/** `--key value` and `--flag`. Deliberately tiny; an arg parser is not the
 * interesting part of this repository and a dependency for one would be. */
function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("-")) continue;
    const key = a.replace(/^--?/, "");
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

function str(v: string | boolean | undefined): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** A .txt file is one sample; a .json array is several. Anything else is an
 * error rather than a guess — silently treating a malformed JSON file as one
 * long string would grade the agent on its own punctuation. */
async function readSamples(path: string): Promise<string[]> {
  const raw = await Deno.readTextFile(path);
  if (!path.toLowerCase().endsWith(".json")) return [raw];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ProbeError(
      `${path} ends in .json but is not JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (!Array.isArray(parsed) || parsed.some((s) => typeof s !== "string")) {
    throw new ProbeError(
      `${path} must contain a JSON array of strings — one conversation sample per entry`,
    );
  }
  return parsed as string[];
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.help || args.h || argv.length === 0) {
    console.log(USAGE);
    return argv.length === 0 ? 2 : 0;
  }

  const transcriptPath = str(args.transcript);
  if (!transcriptPath) {
    console.error("error: --transcript <file> is required\n");
    console.error(USAGE);
    return 2;
  }

  const useMock = args.mock === true;
  const provider = str(args.provider);
  if (!useMock && !provider) {
    console.error(
      `error: choose a model — --provider <${
        PROVIDER_IDS.join("|")
      }>, or --mock to run with no model at all\n`,
    );
    return 2;
  }
  if (useMock && provider) {
    console.error("error: --mock and --provider are mutually exclusive\n");
    return 2;
  }

  const maxCallsRaw = str(args["max-calls"]);
  if (maxCallsRaw !== undefined && !/^\d+$/.test(maxCallsRaw)) {
    console.error(`error: --max-calls must be a whole number, got "${maxCallsRaw}"\n`);
    return 2;
  }

  const judgeOptions = {
    provider: provider ?? "",
    model: str(args.model),
    baseUrl: str(args["base-url"]),
    apiKey: str(args["api-key"]),
    maxCalls: maxCallsRaw ? Number(maxCallsRaw) : undefined,
  };

  // PREFLIGHT BEFORE THE FIRST BYTE LEAVES.
  //
  // The endpoint is printed because it is the one fact a reader cannot get any
  // other way: where their customers' conversations are about to be sent. No
  // dollar figure — prices differ by provider and model and change without
  // notice, and a stale number is worse than none.
  if (!useMock) {
    try {
      const d = describe(judgeOptions);
      console.error(`provider  ${d.provider}`);
      console.error(`endpoint  ${d.endpoint}`);
      console.error(`model     ${d.model}`);
      console.error(
        `calls     ${d.budget.normal} normally, ${d.budget.max} worst case, ceiling ${d.budget.ceiling}`,
      );
      console.error(`key       ${d.needsKey ? "required (yours)" : "not required"}`);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      return 1;
    }
  } else {
    console.error("provider  mock — no model is called and nothing leaves this machine");
  }

  if (args["dry-run"] === true) {
    console.error("\n--dry-run: nothing was sent.");
    return 0;
  }

  let samples: string[];
  try {
    samples = await readSamples(transcriptPath);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return err instanceof ProbeError ? 2 : 1;
  }

  let judge: Judge;
  try {
    judge = useMock ? mockJudge() : makeJudge(judgeOptions);
  } catch (err) {
    // A missing key is a configuration failure, not a finding about the agent.
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  try {
    const result = await gradeBattery({
      // A local run has no record to re-open, so the id is a label, not a
      // locator. It is printed on the report so two runs can be told apart.
      scanId: str(args["scan-id"]) ?? `local-${new Date().toISOString().slice(0, 10)}`,
      agent: {
        name: str(args["agent-name"]) ?? "agent under test",
        model: str(args["agent-model"]) ?? "",
        type: str(args["agent-type"]) ?? "",
        description: str(args["agent-description"]) ?? "",
      },
      mode: "transcript",
      tier: "local",
      access: { mode: "transcript", transcript: samples },
    }, {
      judge,
      onProgress: (msg) => console.error(`  ${msg}`),
    });

    console.error("");
    if (args.json === true) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(result.report_md);
    }
    // Said on stderr as well as in the report, because a caller piping stdout
    // to a file is exactly the caller most likely to miss the refusal.
    if (result.grade_withheld) {
      console.error(
        `\nNo grade issued: ${result.coverage.testsTested}/${result.coverage.testsTotal} probes found evidence ` +
          `(${result.grade_withheld}). Reference composite ${result.composite_reference} is not a verdict.`,
      );
    }
    return 0;
  } catch (err) {
    if (err instanceof ProviderError) {
      console.error(`\n${err.message}`);
      return 1;
    }
    if (err instanceof ProbeError) {
      console.error(`\n${err.message}`);
      return 2;
    }
    console.error(`\n${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

if (import.meta.main) {
  Deno.exit(await main(Deno.args));
}
