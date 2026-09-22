// Offline configuration checks only: never construct a judge or send a request.
import {
  DEFAULT_KEY_ENV,
  describe,
  PROVIDER_IDS,
  redact,
} from "../packages/providers/src/index.ts";
import { transcriptEvidence } from "../packages/scanner-core/src/probe.ts";

export interface DoctorDeps {
  readTextFile: (path: string) => Promise<string>;
  readEnv: (name: string) => string | undefined;
  write: (text: string) => void;
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
  // `network_calls` used to be the literal 0 — an assertion, not a measurement.
  // It read 0 whether or not a request had been made, so a future code path
  // that sent one would still have been reported as offline. Count instead:
  // wrap fetch for the duration of this call and report what the counter saw.
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = ((...a: Parameters<typeof fetch>) => {
    calls++;
    return realFetch(...a);
  }) as typeof fetch;
  try {
    return await run(argv, deps, () => calls);
  } finally {
    globalThis.fetch = realFetch;
  }
}

async function run(
  argv: string[],
  deps: DoctorDeps,
  networkCalls: () => number,
): Promise<number> {
  const report = {
    schema_version: 1,
    status: "blocked",
    offline: true,
    network_calls: 0,
    input: { state: "unchecked", nonempty_samples: 0 },
    configuration: null as ReturnType<typeof describe> | null,
    credential: { state: "unchecked", source: "named_environment_variable" },
    authentication: "unverified",
    connectivity: "unverified",
    errors: [] as { code: string; message: string }[],
  };
  const fail = (code: string, message: string) =>
    report.errors.push({ code, message });
  const finish = () => {
    report.status = report.errors.length ? "blocked" : "locally_ready";
    report.network_calls = networkCalls();
    report.offline = report.network_calls === 0;
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
      if (
        !["http:", "https:"].includes(url.protocol) || url.username ||
        url.password || baseUrl.includes("?") || baseUrl.includes("#")
      ) throw new Error();
    } catch {
      fail(
        "invalid_base_url",
        "Use an absolute HTTP(S) --base-url without userinfo, query or fragment; supply credentials through an environment variable.",
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
      endpoint: "none",
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
      // userinfo, query and fragment are refused above, but a key can also sit
      // in a PATH segment (…/v1/sk-…/chat). This JSON is meant to be pasted
      // into bug reports and CI logs, so the endpoint goes through the same
      // redactor the provider errors use.
      report.configuration = {
        ...described,
        endpoint: redact(described.endpoint),
      };
      // A ceiling under the probe count is not a smaller scan — it is a scan
      // that spends `ceiling` real calls and then dies on a fatal
      // `call_ceiling` with no report (FATAL_CODES in providers/redact.ts).
      // Letting that through is precisely the spend this command exists to
      // prevent, so it is an error, not a note.
      const { ceiling, normal } = report.configuration.budget;
      if (normal > 0 && ceiling < normal) {
        fail(
          "budget_below_battery",
          `Raise --max-calls to at least ${normal}: the battery has ${normal} probes, and a ceiling of ${ceiling} would spend ${ceiling} provider calls and then stop with no report.`,
        );
      }
      if (!report.configuration.needsKey) {
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
