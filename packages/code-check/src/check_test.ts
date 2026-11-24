import { assert, assertEquals } from "@std/assert";
import { scanPath } from "./check.ts";

const TREE = new URL(import.meta.resolve("../testdata/tree")).pathname;

Deno.test("a directory walk reads Python and TS files and skips node_modules and other files", async () => {
  const r = await scanPath(TREE);
  assertEquals(r.filesScanned, 2);
  const files = [...new Set(r.findings.map((f) => f.file))].sort();
  assertEquals(files, ["agent.py", "sub/stream.ts"]);
});

Deno.test("--exclude drops a path prefix from the walk", async () => {
  const r = await scanPath(TREE, { exclude: ["sub"] });
  assertEquals(r.filesScanned, 1);
  assert(r.findings.every((f) => f.file === "agent.py"));
});

Deno.test("a single file can be checked", async () => {
  const r = await scanPath(`${TREE}/agent.py`);
  assertEquals(r.filesScanned, 1);
  assert(r.findings.length > 0);
  assertEquals(r.findings[0].file, "agent.py");
});

Deno.test("test files and test folders are skipped by default, and counted", async () => {
  const r = await scanPath(TREE);
  assertEquals(r.testsSkipped, 3);
  assert(r.findings.every((f) => !/tests?\/|__tests__|\.test\./.test(f.file)));
});

Deno.test("--include-tests scans them too", async () => {
  const r = await scanPath(TREE, { includeTests: true });
  assertEquals(r.filesScanned, 5);
  assertEquals(r.testsSkipped, 0);
});

Deno.test("a file that cannot be read is skipped with its reason, and the scan goes on", async () => {
  const r = await scanPath(TREE, {
    readFile: (p: string) =>
      p.endsWith("agent.py") ? Promise.reject(new Error("permission denied")) : Deno.readTextFile(p),
  });
  assertEquals(r.filesScanned, 1);
  assertEquals(r.skipped, [{ file: "agent.py", reason: "permission denied" }]);
  assert(r.findings.some((f) => f.file === "sub/stream.ts"));
});
