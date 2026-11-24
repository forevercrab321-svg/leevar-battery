import { assertEquals } from "@std/assert";
import { langOf, parseSource } from "./source.ts";

Deno.test("language is picked from the extension", () => {
  assertEquals(langOf("a/b.py"), "python");
  assertEquals(langOf("a/b.ts"), "js");
  assertEquals(langOf("a/b.tsx"), "js");
  assertEquals(langOf("a/b.mjs"), "js");
  assertEquals(langOf("a/b.d.ts"), null);
  assertEquals(langOf("a/b.go"), null);
});

Deno.test("comments are blanked and strings kept in `code`; string bodies blanked in `bare`", () => {
  const s = parseSource("x.ts", 'const u = "http://a"; // finish_reason\n/* tool_calls */ f();', "js");
  assertEquals(s.raw.length, 2);
  assertEquals(s.code[0].trimEnd(), 'const u = "http://a";');
  assertEquals(s.bare[0].trimEnd(), 'const u = "        ";');
  assertEquals(s.code[1].trim(), "f();");
});

Deno.test("python comments and triple-quoted strings keep line numbers", () => {
  const s = parseSource("x.py", 'a = """one\n# not a comment\n"""  # real comment\nb = 1', "python");
  assertEquals(s.raw.length, 4);
  assertEquals(s.code[1], "# not a comment");
  assertEquals(s.bare[1].trim(), "");
  assertEquals(s.code[2].trimEnd(), '"""');
  assertEquals(s.code[3], "b = 1");
});
