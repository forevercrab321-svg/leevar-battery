import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_API,
  GRADE_LADDER,
  SPEC,
  UsageError,
  gradeRank,
  helpText,
  meetsThreshold,
  normalizeGrade,
  normalizeOptions,
  parseArgs,
  parseHeader,
  parseThreshold,
} from "../scan.mjs";

const usage = (fn, re) => assert.throws(fn, (err) => err instanceof UsageError && err.exitCode === 4 && re.test(err.message));

test("parseArgs: defaults", () => {
  const o = parseArgs([]);
  assert.equal(o.source, "gh-battery");
  assert.equal(o.interval, 15);
  assert.equal(o.timeout, 1500);
  assert.equal(o.tier, "scan");
  assert.deepEqual(o.transcript, []);
  assert.deepEqual(o.header, []);
  assert.equal(o.json, false);
  assert.equal(o["fail-on-withheld"], false);
  assert.equal(o.email, undefined);
});

test("parseArgs: repeatable flags, --flag=value, short aliases", () => {
  const o = parseArgs(["--transcript", "a.txt", "--transcript=b.txt", "--header", "x=1", "--header", "y=2=3", "-v", "--email=me@co.com", "--fail-below=B+"]);
  assert.deepEqual(o.transcript, ["a.txt", "b.txt"]);
  assert.deepEqual(o.header, ["x=1", "y=2=3"]);
  assert.equal(o.verbose, true);
  assert.equal(o.email, "me@co.com");
  assert.equal(o["fail-below"], "B+");
  assert.equal(parseArgs(["-q"]).quiet, true);
  assert.equal(parseArgs(["-h"]).help, true);
});

test("parseArgs: '-' is a value (stdin), '--' ends flags", () => {
  assert.deepEqual(parseArgs(["--transcript", "-"]).transcript, ["-"]);
  assert.deepEqual(parseArgs(["--", "--not-a-flag"])._positionals, ["--not-a-flag"]);
});

test("parseArgs: unknown flag suggests the closest one", () => {
  usage(() => parseArgs(["--transcipt", "x"]), /unknown flag "--transcipt".*Did you mean --transcript\?/);
  usage(() => parseArgs(["--zzzzzz"]), /unknown flag "--zzzzzz"\. Run --help/);
  usage(() => parseArgs(["-x"]), /unknown flag "-x"/);
});

test("parseArgs: value errors name the fix", () => {
  usage(() => parseArgs(["--email"]), /--email needs a value, e\.g\. --email you@example\.com/);
  usage(() => parseArgs(["--json=yes"]), /--json takes no value/);
  usage(() => parseArgs(["--interval", "soon"]), /--interval must be a positive number of seconds/);
  usage(() => parseArgs(["--timeout", "-5"]), /--timeout must be a positive number/);
});

test("normalizeOptions: a plain transcript run on the free tier", () => {
  const o = normalizeOptions(parseArgs(["--email", "You@Co.com", "--name", " bot ", "--transcript", "t.txt"]), {});
  assert.equal(o.mode, "transcript");
  assert.equal(o.email, "you@co.com", "lowercased at the boundary like api-scan/index.ts:331");
  assert.equal(o.name, "bot");
  assert.equal(o.apiKey, null);
  assert.equal(o.api, DEFAULT_API);
  assert.equal(o.threshold, null);
  assert.deepEqual(o.warnings, []);
});

test("normalizeOptions: LEEVAR_API_KEY makes --email optional and LEEVAR_API_URL overrides --api", () => {
  const o = normalizeOptions(parseArgs(["--name", "bot", "--transcript", "t.txt"]), { LEEVAR_API_KEY: " k1 ", LEEVAR_API_URL: "http://127.0.0.1:1/x" });
  assert.equal(o.apiKey, "k1");
  assert.equal(o.email, null);
  assert.equal(o.api, "http://127.0.0.1:1/x");
  assert.equal(normalizeOptions(parseArgs(["--api", "http://localhost:2/y", "--name", "b", "--transcript", "t"]), { LEEVAR_API_KEY: "k", LEEVAR_API_URL: "http://127.0.0.1:1/x" }).api, "http://localhost:2/y", "flag beats env");
});

test("normalizeOptions: legacy positional form maps and warns", () => {
  const o = normalizeOptions(parseArgs(["me@co.com", "my-agent", "./t.txt"]), {});
  assert.equal(o.email, "me@co.com");
  assert.equal(o.name, "my-agent");
  assert.deepEqual(o.transcript, ["./t.txt"]);
  assert.match(o.warnings[0], /positional arguments are deprecated/);
  usage(() => normalizeOptions(parseArgs(["stray"]), {}), /unexpected argument "stray"/);
});

test("normalizeOptions: every missing requirement is a usage error that names the fix", () => {
  usage(() => normalizeOptions(parseArgs([]), {}), /nothing to scan\. Pass --transcript/);
  usage(() => normalizeOptions(parseArgs(["--transcript", "t", "--email", "a@b.c"]), {}), /--name is required/);
  usage(() => normalizeOptions(parseArgs(["--transcript", "t", "--name", "n"]), {}), /--email is required on the free tier \(5 scans/);
  usage(() => normalizeOptions(parseArgs(["--transcript", "t", "--live", "https://x.y", "--name", "n", "--email", "a@b.c"]), {}), /either --transcript or --live, not both/);
  usage(() => normalizeOptions(parseArgs(["--transcript", "t", "--header", "a=b", "--name", "n", "--email", "a@b.c"]), {}), /--header only applies to --live/);
  usage(() => normalizeOptions(parseArgs(["--live", "ftp://x", "--name", "n", "--email", "a@b.c"]), {}), /not an http\(s\) URL/);
  usage(() => normalizeOptions(parseArgs(["--live", "https://x.y", "--header", "novalue", "--name", "n", "--email", "a@b.c"]), {}), /--header expects name=value/);
  usage(() => normalizeOptions(parseArgs(["--transcript", "t", "--name", "n", "--email", "nope"]), {}), /"nope" is not an email address/);
  usage(() => normalizeOptions(parseArgs(["--transcript", "t", "--name", "n", "--email", "a@b.c", "--tier", "gold"]), {}), /--tier must be "scan" or "full"/);
  usage(() => normalizeOptions(parseArgs(["--transcript", "t", "--name", "n", "--email", "a@b.c", "--source", "bad tag!"]), {}), /--source must be 1-40 characters/);
  usage(() => normalizeOptions(parseArgs(["--transcript", "t", "--name", "n", "--email", "a@b.c", "-v", "-q"]), {}), /--verbose and --quiet contradict/);
});

test("normalizeOptions: --scan-id rules", () => {
  const o = normalizeOptions(parseArgs(["--scan-id", "scn-2026-0001", "--email", "a@b.c"]), {});
  assert.equal(o.scanId, "SCN-2026-0001", "uppercased like api-scan/index.ts:161");
  usage(() => normalizeOptions(parseArgs(["--scan-id", "x"]), {}), /--scan-id on the free tier needs the --email/);
  assert.equal(normalizeOptions(parseArgs(["--scan-id", "x"]), { LEEVAR_API_KEY: "k" }).scanId, "X");
  usage(() => normalizeOptions(parseArgs(["--scan-id", "x", "--email", "a@b.c", "--transcript", "t"]), {}), /cannot be combined/);
});

test("normalizeOptions: warnings for --tier full without a key, and the poll-interval floor", () => {
  const o = normalizeOptions(parseArgs(["--transcript", "t", "--name", "n", "--email", "a@b.c", "--tier", "full", "--interval", "0.1"]), {});
  assert.match(o.warnings.find((w) => w.includes("--tier full")), /free tier is locked to "scan"/);
  assert.equal(o.interval, 1, "public API: floor at 1s");
  assert.match(o.warnings.find((w) => w.includes("--interval")), /below the 1s floor/);
  const local = normalizeOptions(parseArgs(["--api", "http://127.0.0.1:9/x", "--transcript", "t", "--name", "n", "--email", "a@b.c", "--interval", "0.02"]), {});
  assert.equal(local.interval, 0.02, "localhost stubs may poll fast");
});

test("grades: normalization accepts A-, a-, A− and ranks by grade.ts:7-16", () => {
  assert.equal(normalizeGrade("a-"), "A−");
  assert.equal(normalizeGrade("A−"), "A−");
  assert.equal(gradeRank("A-"), GRADE_LADDER.indexOf("A−"));
  assert.ok(gradeRank("A+") > gradeRank("A") && gradeRank("A") > gradeRank("A-") && gradeRank("A-") > gradeRank("B+") && gradeRank("B+") > gradeRank("B"));
  assert.ok(gradeRank("B") > gradeRank("C+") && gradeRank("C+") > gradeRank("C") && gradeRank("C") > gradeRank("D+") && gradeRank("D+") > gradeRank("D") && gradeRank("D") > gradeRank("F"));
  assert.equal(gradeRank("E"), -1);
});

test("thresholds: letters and composite numbers", () => {
  assert.deepEqual(parseThreshold("b+"), { kind: "grade", rank: GRADE_LADDER.indexOf("B+"), label: "B+" });
  assert.deepEqual(parseThreshold("88"), { kind: "composite", value: 88, label: "88" });
  assert.deepEqual(parseThreshold("87.5"), { kind: "composite", value: 87.5, label: "87.5" });
  usage(() => parseThreshold("Z"), /"Z" is not a grade\. Use one of F D D\+ C C\+ B B\+ A− A A\+/);
  usage(() => parseThreshold("101"), /0-100/);
  assert.equal(meetsThreshold(parseThreshold("B"), "B+", 84.2), true);
  assert.equal(meetsThreshold(parseThreshold("B+"), "B", 80), false);
  assert.equal(meetsThreshold(parseThreshold("A-"), "A−", 88.1), true);
  assert.equal(meetsThreshold(parseThreshold("88"), "B+", 84.2), false);
  assert.equal(meetsThreshold(parseThreshold("80"), "B+", 84.2), true);
  assert.equal(meetsThreshold(parseThreshold("B"), null, null), false, "no grade never meets a grade threshold");
  assert.equal(meetsThreshold(parseThreshold("50"), "A", null), false, "no composite never meets a numeric threshold");
  assert.equal(meetsThreshold(null, null, null), true, "no threshold requested");
});

test("parseHeader splits on the first '=' only", () => {
  assert.deepEqual(parseHeader("authorization=Bearer a=b=="), ["authorization", "Bearer a=b=="]);
  assert.deepEqual(parseHeader(" x-key = v "), ["x-key", " v "]);
});

test("--help documents every flag in the table", () => {
  const help = helpText();
  for (const flag of Object.keys(SPEC)) assert.ok(help.includes(`--${flag}`), `--help is missing --${flag}`);
  for (const line of ["EXIT CODES", "FREE TIER", "LEEVAR_API_KEY", "EXAMPLES"]) assert.ok(help.includes(line), `--help is missing ${line}`);
});
