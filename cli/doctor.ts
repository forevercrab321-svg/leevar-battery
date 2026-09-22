// Offline configuration checks only: never construct a judge or send a request.
import {
  DEFAULT_KEY_ENV,
  describe,
  PROVIDER_IDS,
  redact,
} from "../packages/providers/src/index.ts";
import { transcriptEvidence } from "../packages/scanner-core/src/probe.ts";
import { BATTERY } from "../packages/scanner-core/src/battery.ts";

// Derived from the battery itself, never copied as a number here, so this
// cannot drift when a probe is added or its needsVerifiedSource flag changes.
//
// PROBES            every probe in the battery.
// FLOOR             probes that no input can excuse. gradeBattery returns a
//                   verdict WITHOUT calling the judge when the transcript's
//                   tool output is self-reported and the probe needs a
//                   verified source (grade-battery.ts, the branch above
//                   liveProbe), so those are the only ones a run can skip.
//
// Measured on a stubbed judge, zero network: a clean transcript spends 18
// judge calls; a transcript carrying self-reported tool output spends 12 and
// completes at 12/18 coverage. So 18 is the probe count, not a required spend.
const PROBES = BATTERY.flatMap((d) => d.tests).length;
const FLOOR = PROBES - BATTERY.flatMap((d) => d.tests)
  .filter((t) => t.needsVerifiedSource).length;

export interface DoctorDeps {
  readTextFile: (path: string) => Promise<string>;
  readEnv: (name: string) => string | undefined;
  write: (text: string) => void;
}

/**
 * A form of the endpoint safe to paste into a log, NOT a usable endpoint.
 *
 * Three different hiding places, and none of them is covered by the others:
 *   userinfo    refused earlier, but re-masked here so a future caller cannot
 *               reintroduce it silently
 *   query       every VALUE is masked, keys are kept. Keys are what make an
 *               endpoint recognisable (api-version), values are where a key
 *               hides, and guessing which parameter names are "credential
 *               shaped" is the judgement that got this wrong the first time
 *   path/frag   run through the shared redact(), which knows provider key
 *               SHAPES
 *
 * LIMIT, stated because the opposite would be a false assurance: redact() is
 * shape-based. A path credential in an unknown format — a bare opaque token
 * with no sk- prefix — is not recognised, so this cannot be described as "all
 * URL secrets are removed". Query values are masked positionally and so do not
 * depend on shape; the path does.
 */
function redactedEndpoint(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return redact(raw);
  }
  if (u.username || u.password) {
    u.username = "[REDACTED]";
    u.password = "";
  }
  for (const k of [...u.searchParams.keys()]) {
    if (u.searchParams.get(k)) u.searchParams.set(k, "[REDACTED]");
  }
  if (u.hash) u.hash = "[REDACTED]";
  // URL.toString() percent-encodes the brackets; undo that for the marker only,
  // so a log line reads ?api-version=[REDACTED] rather than %5BREDACTED%5D.
  return redact(u.toString()).replaceAll("%5BREDACTED%5D", "[REDACTED]");
}

const USAGE = `cli/doctor.ts — offline preflight for a scan. Sends nothing.

  --transcript <path>   conversation text file, or .json array of strings
  --provider <id>       one of the supported providers
  --mock                check the offline mock path instead of a provider
  --model <name>        override the provider's default model
  --base-url <url>      required for openai-compatible
  --max-calls <n>       call ceiling for the run; must cover every probe

Exit 0 when the local prerequisites pass, 2 when something is blocked.
"locally_ready" does not mean authenticated, and does not mean a grade is
possible: coverage is the battery's answer, not this command's.

The key is read from the provider's environment variable and is never accepted
as an argument. cli/scan.ts also accepts --api-key; doctor cannot preflight
that path, because a key on a command line is already in your shell history.`;

const VALUES = [
  "--transcript",
  "--provider",
  "--model",
  "--base-url",
  "--max-calls",
];

export async function main(argv: string[], deps: DoctorDeps = {
  readTextFile: Deno.readTextFile,
  readEnv: Deno.env.get,
  write: console.log,
}): Promise<number> {
  const report = {
    schema_version: 1,
    status: "blocked",
    // Not "offline: true" and not a fetch counter. A count taken inside this
    // process could only ever see this process's own fetch, would miss a
    // subprocess or a worker, and a global wrapper is not safe to install in a
    // library that a host may call concurrently. What keeps this command
    // offline is the permission it runs under: the `doctor` task grants no
    // --allow-net, so a request would abort rather than be tallied. This field
    // states the intended capability; the task is the enforcement, and
    // cli/doctor_test.ts asserts the run makes no call under an injected
    // fetch that fails the test if used.
    checks: "local_only",
    input: { state: "unchecked", nonempty_samples: 0 },
    // Deliberately not ReturnType<typeof describe>: `endpoint` is replaced by
    // `endpoint_redacted`, so the reported shape is not the configured shape.
    configuration: null as
      | (Omit<ReturnType<typeof describe>, "endpoint"> & {
        endpoint_redacted: string;
      })
      | null,
    budget: null as null | Record<string, unknown>,
    credential: { state: "unchecked", source: "named_environment_variable" },
    authentication: "unverified",
    connectivity: "unverified",
    errors: [] as { code: string; message: string }[],
  };
  const fail = (code: string, message: string) =>
    report.errors.push({ code, message });
  const finish = () => {
    report.status = report.errors.length ? "blocked" : "locally_ready";
    deps.write(JSON.stringify(report, null, 2));
    return report.errors.length ? 2 : 0;
  };
  if (argv.includes("--help") || argv.includes("-h")) {
    // cli/scan.ts prints usage and exits 0 for -h. An agent exploring this CLI
    // tries --help first; answering "unsupported option" teaches it nothing.
    deps.write(USAGE);
    return 0;
  }
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (args.has(flag) || (flag !== "--mock" && !VALUES.includes(flag))) {
      fail(
        "invalid_option",
        "Use supported options once each: --transcript, --provider or --mock, --model, --base-url, --max-calls. Raw API keys are not accepted.",
      );
      return finish();
    }
    if (flag === "--mock") {
      args.set(flag, "true");
      continue;
    }
    const value = argv[++i];
    if (!value?.trim() || value.startsWith("--")) {
      fail(
        "missing_value",
        "Supply a nonempty value after each option that requires one.",
      );
      return finish();
    }
    args.set(flag, value);
  }
  const path = args.get("--transcript");
  const provider = args.get("--provider");
  const mock = args.has("--mock");
  if (!path) {
    fail(
      "missing_transcript",
      "Supply --transcript with a readable text file or JSON array of strings.",
    );
  }
  if (mock === Boolean(provider)) {
    fail("provider_choice", "Choose exactly one of --provider or --mock.");
  }
  if (provider && !PROVIDER_IDS.includes(provider)) {
    fail(
      "unknown_provider",
      "Choose a supported provider: " + PROVIDER_IDS.join(", ") + ".",
    );
  }
  if (
    mock && ["--model", "--base-url"].some((k) => args.has(k))
  ) fail("mock_options", "Remove provider-specific options when using --mock.");
  const maxCalls = args.has("--max-calls")
    ? Number(args.get("--max-calls"))
    : undefined;
  if (
    maxCalls !== undefined &&
    (!/^\d+$/.test(args.get("--max-calls")!) ||
      !Number.isSafeInteger(maxCalls) || maxCalls <= 0)
  ) fail("invalid_max_calls", "Set --max-calls to a positive safe integer.");
  const envName = provider ? DEFAULT_KEY_ENV[provider] : null;
  const baseUrl = args.get("--base-url");
  if (baseUrl) {
    try {
      const url = new URL(baseUrl);
      if (!["http:", "https:"].includes(url.protocol)) throw new Error();
      // userinfo is refused: there is no legitimate reason for a credential to
      // be in the authority, and accepting it would put one in shell history.
      if (url.username || url.password) throw new Error();
      // A query string is NOT refused. "every query parameter is a secret" was
      // wrong and blocked a whole class of real endpoints — Azure OpenAI
      // requires ?api-version=. The value is kept out of the diagnostic
      // instead (see redactedEndpoint), which is the actual risk.
    } catch {
      fail(
        "invalid_base_url",
        "Use an absolute HTTP(S) --base-url without userinfo; supply credentials through an environment variable.",
      );
    }
  }
  if (provider === "openai-compatible" && !baseUrl) {
    fail("missing_base_url", "Supply --base-url for openai-compatible.");
  }
  if (report.errors.length) return finish();

  try {
    const raw = await deps.readTextFile(path!);
    let samples: unknown = [raw];
    if (path!.toLowerCase().endsWith(".json")) {
      try {
        samples = JSON.parse(raw);
      } catch {
        report.input.state = "invalid";
        fail(
          "invalid_json",
          "Fix transcript JSON syntax; expected an array of strings.",
        );
      }
    }
    if (!report.errors.length) {
      if (
        !Array.isArray(samples) || samples.some((s) => typeof s !== "string")
      ) {
        report.input.state = "invalid";
        fail(
          "invalid_transcript",
          "Use a JSON array of strings, one conversation sample per entry.",
        );
      } else {
        try {
          transcriptEvidence({ transcript: samples });
          report.input.state = "valid";
          report.input.nonempty_samples = samples.filter((s: string) =>
            s.trim()
          ).length;
        } catch {
          report.input.state = "empty";
          fail(
            "empty_transcript",
            "Add at least one nonempty conversation sample.",
          );
        }
      }
    }
  } catch {
    report.input.state = "unreadable";
    fail(
      "unreadable_transcript",
      "Check that the transcript file exists and read permission is granted.",
    );
  }
  if (mock) {
    report.credential.state = "not_required";
    report.configuration = {
      provider: "mock",
      endpoint_redacted: "none",
      model: "none",
      needsKey: false,
      budget: { normal: 0, max: 0, ceiling: 0 },
    };
  } else {
    // Never print thrown provider errors, file paths, sample contents or keys.
    try {
      const described = describe({
        provider: provider!,
        model: args.get("--model"),
        baseUrl,
        maxCalls,
      });
      // The field is named for what it is. The scan is configured from the
      // --base-url the user passed, never from this string: a redacted URL
      // that someone copied back into a config would point somewhere real and
      // fail in a confusing way.
      const { endpoint: _actual, ...rest } = described;
      report.configuration = {
        ...rest,
        endpoint_redacted: redactedEndpoint(described.endpoint),
      };
      // Four different numbers, kept apart because conflating them is how a
      // preflight starts inventing requirements:
      //
      //   probes            18, fixed by the battery
      //   first_attempt     12..18 — input-dependent, because the trust
      //                     boundary excludes up to 6 probes before the judge
      //   upper_bound       2x the first attempt: the provider retries a
      //                     bad_response or transient once, and the ceiling
      //                     counts SENDS (providers/index.ts `send`), so a
      //                     retry consumes it too
      //   ceiling           what the user set
      //
      // Only one of these can be judged offline. Below FLOOR no input can
      // finish, so that is an error. Between FLOOR and PROBES it depends on a
      // transcript this command has deliberately not graded, so it is a note
      // and not a refusal — doctor does not raise anyone's budget for them.
      const ceiling = report.configuration!.budget.ceiling;
      report.budget = {
        probes: PROBES,
        first_attempt_min: FLOOR,
        first_attempt_max: PROBES,
        upper_bound_with_retries: PROBES * 2,
        ceiling,
        note:
          "A ceiling is not a precise spend cap: probes run pooled, so calls already in flight land after it trips.",
      };
      if (ceiling < FLOOR) {
        fail(
          "budget_below_floor",
          `Raise --max-calls to at least ${FLOOR}: no transcript can finish this battery in ${ceiling} calls, because at most ${
            PROBES - FLOOR
          } of the ${PROBES} probes can be skipped before the judge. The run would spend ${ceiling} provider calls and stop with no report.`,
        );
      } else if (ceiling < PROBES) {
        report.budget.note +=
          ` ${ceiling} is above the ${FLOOR}-call floor but below the ${PROBES} probes: it finishes only if the trust boundary excludes enough probes, which depends on your transcript. Even ${PROBES} does not guarantee completion, because a retry spends the ceiling too.`;
      }
      if (!report.configuration!.needsKey) {
        report.credential.state = "not_required";
      } else {
        try {
          report.credential.state = envName && deps.readEnv(envName)?.trim()
            ? "present"
            : "missing";
          if (report.credential.state === "missing") {
            fail(
              "missing_credential",
              "Set the provider's default key environment variable. (cli/scan.ts also accepts --api-key, which doctor cannot preflight and which puts the key in your shell history.)",
            );
          }
        } catch {
          report.credential.state = "unreadable";
          fail(
            "credential_permission",
            "Grant --allow-env for only the named key variable when invoking cli/doctor.ts directly.",
          );
        }
      }
    } catch {
      fail(
        "invalid_configuration",
        "Check provider, model and endpoint options.",
      );
    }
  }
  return finish();
}

if (import.meta.main) Deno.exit(await main(Deno.args));
