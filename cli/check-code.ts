#!/usr/bin/env -S deno run --allow-read
// Check an agent project's code for five fault shapes that maintainers of real
// open-source projects confirmed (docs/catalog/). Offline: no model, no key,
// no network. It reads your files and never executes or changes them.
//
//   deno task check-code ./my-agent
//   deno task check-code ./my-agent --exclude tests --json
//
// EXIT CODES
//   0  the check ran (with or without matches)
//   1  the path could not be read
//   2  the arguments were wrong
//   3  --fail-on-findings was given and something matched

import { scanPath } from "../packages/code-check/src/check.ts";
import { renderMarkdown } from "../packages/code-check/src/report.ts";
import { RULES } from "../packages/code-check/src/rules.ts";

const USAGE = `leevar-battery check-code: offline pattern check for agent code

  deno task check-code <path> [options]

<path> is a directory (walked recursively) or one file. Python (.py) and
TypeScript / JavaScript (.ts .tsx .js .jsx .mjs .cjs .mts .cts) are read.
node_modules, .git, virtualenvs, build output and vendor folders are skipped.

OPTIONS
  --exclude <prefix>    Leave out a path, relative to <path>. Repeatable.
  --json                Print the machine result instead of Markdown.
  --fail-on-findings    Exit 3 when anything matched (for CI).
  -h, --help            This.

RULES
${RULES.map((r) => `  ${r.id.padEnd(28)}${r.title}`).join("\n")}

Every match is a possible issue for a person to confirm, not a verdict.
`;

export async function main(argv: string[]): Promise<number> {
  if (argv.length === 0) {
    console.log(USAGE);
    return 2;
  }
  let path: string | undefined;
  const exclude: string[] = [];
  let json = false;
  let failOnFindings = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") {
      console.log(USAGE);
      return 0;
    } else if (a === "--json") json = true;
    else if (a === "--fail-on-findings") failOnFindings = true;
    else if (a === "--exclude") {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) {
        console.error("error: --exclude needs a path\n");
        return 2;
      }
      exclude.push(v);
    } else if (a.startsWith("-")) {
      console.error(`error: unknown option ${a}\n`);
      console.log(USAGE);
      return 2;
    } else if (path === undefined) path = a;
    else {
      console.error(`error: one path only (got ${path} and ${a})\n`);
      return 2;
    }
  }
  if (path === undefined) {
    console.error("error: a <path> to check is required\n");
    console.log(USAGE);
    return 2;
  }

  let result;
  try {
    result = await scanPath(path, { exclude });
  } catch (err) {
    console.error(`error: cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  console.log(json ? JSON.stringify(result, null, 2) : renderMarkdown(result));
  return failOnFindings && result.findings.length > 0 ? 3 : 0;
}

if (import.meta.main) {
  Deno.exit(await main(Deno.args));
}
