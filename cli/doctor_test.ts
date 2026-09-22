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
    "7",
  ]);
  assertEquals(r.code, 0);
  assertEquals(r.report.configuration.model, "chosen-model");
  assertEquals(
    r.report.configuration.endpoint,
    "http://localhost:8000/v1/chat/completions",
  );
  assertEquals(r.report.configuration.budget.ceiling, 7);
  assertEquals(r.envReads, ["OPENAI_API_KEY"]);
});
