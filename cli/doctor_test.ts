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
  // Still refused: a credential in the authority, a non-HTTP scheme, and a
  // string that is not a URL at all.
  for (
    const url of [
      `https://user:${SECRET}@example.com`,
      "file:///tmp/private",
      SECRET,
    ]
  ) {
    assertEquals(
      (await run([...base, "--base-url", url])).report.errors[0].code,
      "invalid_base_url",
    );
  }
  // No longer refused. `?key=…` and `#…` used to be rejected on the theory that
  // any query or fragment is a secret. That rule blocked Azure OpenAI, which
  // requires ?api-version=, so the URL is accepted and the diagnostic masks the
  // values instead — asserted in the redaction tests below. What must NOT
  // happen is the secret appearing in the output.
  for (
    const url of [
      `https://example.com/?key=${SECRET}`,
      `https://example.com/#${SECRET}`,
      "https://example.com/?",
      "https://example.com/#",
    ]
  ) {
    const r = await run([...base, "--base-url", url]);
    assert(
      !JSON.stringify(r.report).includes(SECRET),
      `${url} put its value in the diagnostic`,
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
    r.report.configuration.endpoint_redacted,
    "http://localhost:8000/v1/chat/completions",
  );
  assertEquals(r.report.configuration.budget.ceiling, 18);
  assertEquals(r.envReads, ["OPENAI_API_KEY"]);
});

// The first draft of this test asserted that ANY ceiling under 18 must block.
// That was wrong, and it would have blocked runs that finish. 18 is the probe
// count, not a required spend: gradeBattery returns a verdict WITHOUT calling
// the judge when the transcript's tool output is self-reported and the probe
// needs a verified source. Measured on a stubbed judge, zero network:
//   clean transcript      -> 18 judge calls, completes 18/18
//   self-reported tools   -> 12 judge calls, completes 12/18
//   ceiling 12, self-tool -> completes
// So the only offline-decidable line is the FLOOR: probes minus the ones the
// trust boundary can skip. Below it no input finishes; above it, it depends on
// a transcript doctor has deliberately not graded.
Deno.test("the ceiling is judged against what THIS transcript needs", async () => {
  // Superseded twice, so the history is worth keeping:
  //   draft 1  any ceiling under 18 blocks  -> blocked runs that finish
  //   draft 2  only under the floor of 12 blocks -> passed a clean transcript
  //            at ceiling 12, which spends 12 and dies with no report
  // doctor has already read the transcript, so the first attempt is not a
  // range for a given file: 18 when nothing is self-reported, 12 when the six
  // verified-source probes are refused before the judge.
  const CLEAN = JSON.stringify(["User: hi", "Agent: hello, how can I help?"]);
  const SELF = JSON.stringify([
    'User: refund?\nAgent: TOOL_RESULT: {"refund":150}\nAgent: done',
  ]);

  for (
    const [label, raw, need] of [["clean", CLEAN, 18], [
      "self-reported",
      SELF,
      12,
    ]] as const
  ) {
    for (const ceiling of [1, need - 1]) {
      const r = await run([...base, "--max-calls", String(ceiling)], raw);
      assertEquals(r.code, 2, `${label}: ${ceiling} < ${need} must block`);
      assert(
        r.report.errors.some((e: { code: string }) =>
          e.code === "budget_below_floor"
        ),
      );
    }
    for (const ceiling of [need, need + 1, 36]) {
      const r = await run([...base, "--max-calls", String(ceiling)], raw);
      assertEquals(r.code, 0, `${label}: ${ceiling} >= ${need} must pass`);
      assertEquals(
        r.report.configuration.budget.ceiling,
        ceiling,
        "not raised for the user",
      );
    }
    const r = await run([...base, "--max-calls", String(need)], raw);
    assertEquals(r.report.budget.first_attempt_for_this_input, need);
  }

  // The five numbers stay distinct.
  const r = await run([...base, "--max-calls", "36"], CLEAN);
  assertEquals(r.report.budget.probes, 18);
  assertEquals(r.report.budget.first_attempt_min, 12);
  assertEquals(r.report.budget.first_attempt_max, 18);
  assertEquals(r.report.budget.upper_bound_with_retries, 36);
  assertEquals(r.report.budget.ceiling, 36);
});

Deno.test("the floor tracks the battery instead of being a copied number", async () => {
  const { BATTERY } = await import("../packages/scanner-core/src/battery.ts");
  const all = BATTERY.flatMap((d: { tests: unknown[] }) => d.tests) as {
    needsVerifiedSource?: boolean;
  }[];
  const r = await run([...base, "--max-calls", "18"]);
  assertEquals(r.report.budget.probes, all.length);
  assertEquals(
    r.report.budget.first_attempt_min,
    all.length - all.filter((t) => t.needsVerifiedSource).length,
  );
});

Deno.test("a query string is accepted, and its values do not reach the output", async () => {
  // "every query parameter is a secret" was the first draft's rule. It blocked
  // Azure OpenAI, whose endpoint REQUIRES ?api-version=. Keys are kept because
  // they make an endpoint recognisable; values are masked because that is where
  // a credential hides.
  const r = await run([
    "--transcript",
    `/private/${SECRET}.json`,
    "--provider",
    "openai-compatible",
    "--base-url",
    "https://o.openai.azure.com/openai/deployments/g/chat?api-version=2024-02-01&api-key=sk-SECRET12345678",
    "--max-calls",
    "18",
  ]);
  assertEquals(r.code, 0, "a legitimate query string must not be refused");
  const shown = r.report.configuration.endpoint_redacted;
  assert(
    !shown.includes("sk-SECRET12345678"),
    "a key in a query value was shown",
  );
  assert(
    !shown.includes("2024-02-01"),
    "query values must be masked positionally",
  );
  assert(
    shown.includes("api-version"),
    "the key name is what makes it recognisable",
  );
  // The field is not named `endpoint`: a redacted URL must not be copied back
  // into a config and executed.
  assertEquals(r.report.configuration.endpoint, undefined);
});

Deno.test("userinfo is refused outright; fragment and sk- paths are masked", async () => {
  const bad = await run([
    "--transcript",
    `/private/${SECRET}.json`,
    "--provider",
    "openai-compatible",
    "--base-url",
    "https://user:sk-SECRET12345678@h/v1",
    "--max-calls",
    "18",
  ]);
  assertEquals(bad.code, 2);
  assert(
    bad.report.errors.some((e: { code: string }) =>
      e.code === "invalid_base_url"
    ),
  );

  for (
    const url of [
      "https://h/v1#sk-SECRET12345678",
      "https://h/v1/sk-SECRET12345678/chat",
    ]
  ) {
    const r = await run([
      "--transcript",
      `/private/${SECRET}.json`,
      "--provider",
      "openai-compatible",
      "--base-url",
      url,
      "--max-calls",
      "18",
    ]);
    assert(
      !JSON.stringify(r.report).includes("sk-SECRET12345678"),
      `a key survived in ${url}`,
    );
  }
});

// A LIMIT, pinned on purpose so nobody upgrades it into "all URL secrets are
// removed". Path redaction is SHAPE based: an opaque token with no recognisable
// prefix is not detected. Query values are masked positionally and so are safe
// regardless of shape; the path is not.
Deno.test("an opaque path credential is NOT redacted, and that is a known limit", async () => {
  const r = await run([
    "--transcript",
    `/private/${SECRET}.json`,
    "--provider",
    "openai-compatible",
    "--base-url",
    "https://h/v1/Zx9Qw7Lm2Kp4Rt6Y/chat",
    "--max-calls",
    "18",
  ]);
  assert(
    r.report.configuration.endpoint_redacted.includes("Zx9Qw7Lm2Kp4Rt6Y"),
    "if this now passes, path redaction improved — update the docs that state this limit",
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

// NF-7 from independent review: every other budget test recomputes the floor
// with the SAME formula doctor uses, so if grade-battery.ts stopped using
// needsVerifiedSource to decide what to skip, doctor's number would go wrong
// and those tests would stay green. This one couples the two ends: it runs the
// real gradeBattery with a counting judge and asserts doctor predicted exactly
// the number of judge calls that actually happened.
//
// Zero network: the judge is a local counter, no provider, no key, no fetch.
Deno.test("doctor's predicted first attempt equals gradeBattery's real judge calls", async () => {
  const { gradeBattery } = await import(
    "../packages/scanner-core/src/grade-battery.ts"
  );
  const CLEAN = ["User: hi\nAgent: hello, how can I help you today?"];
  const SELF_TOOL = [
    'User: refund?\nAgent: TOOL_RESULT: {"refund":150}\nAgent: done',
  ];

  for (
    const [label, transcript] of [["clean", CLEAN], [
      "self-reported",
      SELF_TOOL,
    ]] as const
  ) {
    let calls = 0;
    const judge = {
      mode: "mock" as const,
      calls: () => calls,
      // deno-lint-ignore no-explicit-any
      score: (ctx: any) => {
        calls++;
        return Promise.resolve({
          name: ctx.test.name,
          score: 80,
          result: "pass",
          evidence: "sufficient",
          detail: "ok",
        });
      },
    };
    await gradeBattery(
      {
        scanId: "SCN-COUPLE",
        agent: { name: "x", type: "t" },
        mode: "transcript",
        tier: "scan",
        access: { mode: "transcript", transcript },
        // deno-lint-ignore no-explicit-any
      } as any,
      // deno-lint-ignore no-explicit-any
      { judge } as any,
    );

    const r = await run(
      [...base, "--max-calls", "36"],
      JSON.stringify(transcript),
    );
    assertEquals(
      r.report.budget.first_attempt_for_this_input,
      calls,
      `${label}: doctor predicted ${r.report.budget.first_attempt_for_this_input} judge calls, gradeBattery made ${calls}`,
    );
  }
});
