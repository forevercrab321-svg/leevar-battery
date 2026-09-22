import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { main } from "./doctor.ts";

const SECRET = "secret-must-never-appear";
async function run(
  options: string[] = [],
  raw = '["hello"]',
  key: string | null | undefined = SECRET,
  readError = false,
  envError = false,
) {
  let output = "", fetches = 0;
  const envReads: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = () => {
    fetches++;
    throw new Error(SECRET);
  };
  try {
    const code = await main(options, {
      readTextFile: () =>
        readError ? Promise.reject(new Error(SECRET)) : Promise.resolve(raw),
      readEnv: (name) => {
        envReads.push(name);
        if (envError) throw new Error(SECRET);
        return key ?? undefined;
      },
      write: (text) => {
        output = text;
      },
    });
    assertEquals(fetches, 0);
    assert(!output.includes(SECRET));
    return { code, report: JSON.parse(output), envReads };
  } finally {
    globalThis.fetch = original;
  }
}
const base = [
  "--transcript",
  `/private/${SECRET}.json`,
  "--provider",
  "openai",
];

Deno.test("doctor checks local input and only selected key; auth and network remain unverified", async () => {
  const r = await run(base);
  assertEquals(r.code, 0);
  assertEquals(r.report.status, "locally_ready");
  assertEquals(r.report.input, { state: "valid", nonempty_samples: 1 });
  assertEquals(r.report.credential.state, "present");
  assertEquals(r.envReads, ["OPENAI_API_KEY"]);
  assertEquals(r.report.authentication, "unverified");
  assertEquals(r.report.connectivity, "unverified");
  assertEquals(r.report.configuration.budget.ceiling, 36);
});
Deno.test("doctor mock and Ollama need no environment or calls", async () => {
  for (const mode of [["--mock"], ["--provider", "ollama"]]) {
    const r = await run(
      ["--transcript", "input.txt", ...mode],
      "hello",
      undefined,
      false,
      true,
    );
    assertEquals(r.code, 0);
    assertEquals(r.envReads, []);
    assertEquals(r.report.credential.state, "not_required");
  }
});
Deno.test("doctor classifies input failures without echoing content or path", async () => {
  for (
    const [raw, code] of [
      [`{${SECRET}`, "invalid_json"],
      ['{"x":1}', "invalid_transcript"],
      ["[1]", "invalid_transcript"],
      ["[]", "empty_transcript"],
      ['[" ","\\n"]', "empty_transcript"],
    ]
  ) {
    const r = await run(base, raw);
    assertEquals(r.code, 2);
    assertEquals(r.report.errors[0].code, code);
  }
  assertEquals(
    (await run(base, "", SECRET, true)).report.errors[0].code,
    "unreadable_transcript",
  );
  assertEquals(
    (await run(["--transcript", "empty.txt", "--mock"], "  ")).report.errors[0]
      .code,
    "empty_transcript",
  );
});
Deno.test("doctor distinguishes missing and unreadable credential", async () => {
  for (const key of [null, "", "   "]) {
    assertEquals(
      (await run(base, '["hello"]', key)).report.errors[0].code,
      "missing_credential",
    );
  }
  const r = await run(
    base,
    '["hello"]',
    SECRET,
    false,
    true,
  );
  assertEquals(r.report.errors[0].code, "credential_permission");
  assertEquals(r.envReads, ["OPENAI_API_KEY"]);
});
Deno.test("doctor validates options without leaking their values", async () => {
  const cases = [
    [],
    ["--mock"],
    ["--transcript", "x"],
    [...base, "--mock"],
    [...base, "--unknown", SECRET],
    [...base, "--api-key", SECRET],
    [...base, "--model"],
    [...base, "--model", ""],
    [...base, "--provider", SECRET],
    ["--transcript", "x", "--provider", SECRET],
    [...base, "--api-key-env", "invalid-name"],
    ["--transcript", "x", "--provider", "openai-compatible"],
  ];
  for (const args of cases) assertEquals((await run(args)).code, 2);
  for (
    const n of [
      "0",
      "-1",
      "1.2",
      "1e2",
      "0x10",
      "NaN",
      "Infinity",
      "9007199254740992",
    ]
  ) {
    assertEquals((await run([...base, "--max-calls", n])).code, 2);
  }
  for (
    const url of [
      `https://user:${SECRET}@example.com`,
      `https://example.com/?key=${SECRET}`,
      `https://example.com/#${SECRET}`,
      "file:///tmp/private",
      SECRET,
      "https://example.com/?",
      "https://example.com/#",
    ]
  ) {
    assertEquals(
      (await run([...base, "--base-url", url])).report.errors[0].code,
      "invalid_base_url",
    );
  }
});
Deno.test("doctor describes explicit model endpoint and ceiling without sending", async () => {
  const r = await run([
    ...base,
    "--model",
    "chosen-model",
    "--base-url",
    "http://localhost:8000/v1/chat/completions",
    "--max-calls",
    "18",
  ]);
  assertEquals(r.code, 0);
  assertEquals(r.report.configuration.model, "chosen-model");
  assertEquals(
    r.report.configuration.endpoint,
    "http://localhost:8000/v1/chat/completions",
  );
  assertEquals(r.report.configuration.budget.ceiling, 18);
  assertEquals(r.envReads, ["OPENAI_API_KEY"]);
});

// This case used to assert code 0 for --max-calls 7, which locked in the one
// outcome this command exists to prevent: a ceiling under the probe count
// spends that many real provider calls and then dies on a fatal call_ceiling
// with no report. Proven on a stubbed judge: 17 throws after 17 calls, 18
// completes. Found in independent review of the first draft of this PR.
Deno.test("a ceiling under the battery size is blocked, not merely described", async () => {
  for (const ceiling of ["1", "7", "17"]) {
    const r = await run([...base, "--max-calls", ceiling]);
    assertEquals(r.code, 2, `--max-calls ${ceiling} must block`);
    assertEquals(r.report.status, "blocked");
    assert(
      r.report.errors.some((e: { code: string }) =>
        e.code === "budget_below_battery"
      ),
      `--max-calls ${ceiling} must name budget_below_battery`,
    );
  }
  // The boundary is the probe count itself, not an arbitrary number.
  const ok = await run([...base, "--max-calls", "18"]);
  assertEquals(ok.code, 0);
  assertEquals(ok.report.configuration.budget.ceiling, 18);
  assertEquals(ok.report.configuration.budget.normal, 18);
});

Deno.test("a key hidden in a base-url path segment does not reach stdout", async () => {
  // userinfo, query and fragment are refused outright; a path segment is not,
  // so the endpoint goes through the same redactor the provider errors use.
  const r = await run([
    "--transcript",
    `/private/${SECRET}.json`,
    "--provider",
    "openai-compatible",
    "--base-url",
    "https://example.com/v1/sk-LEAKEDSECRET1234/chat",
    "--max-calls",
    "18",
  ]);
  assert(
    !JSON.stringify(r.report).includes("sk-LEAKEDSECRET1234"),
    "a key in the endpoint path reached the diagnostic JSON",
  );
  assert(
    r.report.configuration.endpoint.includes("[REDACTED]"),
    "the endpoint was not redacted",
  );
});

Deno.test("--help answers instead of rejecting the option", async () => {
  // cli/scan.ts prints usage for -h. An agent exploring this CLI tries --help
  // first; "unsupported option" with exit 2 teaches it nothing.
  for (const flag of ["--help", "-h"]) {
    let out = "";
    const code = await main([flag], {
      readTextFile: () => Promise.reject(new Error("must not read")),
      readEnv: () => {
        throw new Error("must not read env");
      },
      write: (t) => {
        out = t;
      },
    });
    assertEquals(code, 0, `${flag} must exit 0`);
    assert(out.includes("--transcript"), `${flag} must list the options`);
    assert(
      !out.includes('locally_ready":'),
      `${flag} must not emit a diagnostic`,
    );
  }
});
