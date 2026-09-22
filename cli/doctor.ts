// Offline configuration checks only: never construct a judge or send a request.
import {
  DEFAULT_KEY_ENV,
  describe,
  PROVIDER_IDS,
} from "../packages/providers/src/index.ts";
import { transcriptEvidence } from "../packages/scanner-core/src/probe.ts";

export interface DoctorDeps {
  readTextFile: (path: string) => Promise<string>;
  readEnv: (name: string) => string | undefined;
  write: (text: string) => void;
}

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
    deps.write(JSON.stringify(report, null, 2));
    return report.errors.length ? 2 : 0;
  };
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
      report.configuration = describe({
        provider: provider!,
        model: args.get("--model"),
        baseUrl,
        maxCalls,
      });
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
              "Set the provider's default key environment variable before running doctor or scan.",
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
