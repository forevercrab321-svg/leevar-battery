// The Markdown a person reads. It says what matched and where, why the shape
// is risky, how it is usually fixed, and which confirmed real case it comes
// from. It does not say the code has a bug: a pattern match cannot know that.

import type { ScanResult } from "./check.ts";
import { CATALOG_BASE_URL, RULES } from "./rules.ts";

export const DISCLAIMER =
  "Possible issues found by pattern matching. Please confirm each one by reading the code: a match is a place to look, not proof of a bug, and no match is not proof there is none.";

export function renderMarkdown(r: ScanResult): string {
  const out: string[] = [];
  out.push("# Code check: possible agent faults", "");
  const files = `${r.filesScanned} file${r.filesScanned === 1 ? "" : "s"}`;
  out.push(
    `Scanned ${files} (Python, TypeScript, JavaScript) under \`${r.root}\`, offline. Nothing was executed or sent anywhere.`,
    "",
  );
  if (r.findings.length === 0) {
    out.push(
      `No matches for the ${RULES.length} rules. That is not proof the code is free of these faults: the rules match common shapes only. See docs/code-check.md for what each rule can and cannot see.`,
    );
    return out.join("\n") + "\n";
  }
  out.push(`> ${DISCLAIMER}`, "");
  const n = r.findings.length;
  out.push(`${n} possible issue${n === 1 ? "" : "s"}:`, "");

  for (const rule of RULES) {
    const hits = r.findings.filter((f) => f.rule === rule.id);
    if (hits.length === 0) continue;
    out.push(`## \`${rule.id}\`: ${rule.title}`, "");
    for (const f of hits) {
      out.push(`- **${f.file}:${f.line}** \`${f.snippet.replace(/`/g, "'")}\``);
      out.push(`  ${f.detail}`);
    }
    out.push("", `**Why it is risky.** ${rule.why}`, "", `**How it is usually fixed.** ${rule.fix}`, "");
    if (rule.catalog.length) {
      out.push(
        `**Confirmed real cases:** ${
          rule.catalog.map((c) => `[${c.id}: ${c.title}](${CATALOG_BASE_URL}${c.file})`).join("; ")
        }`,
        "",
      );
    } else {
      out.push(`**Confirmed real cases:** ${rule.catalogNote ?? "pattern, not yet in catalog"}`, "");
    }
  }
  return out.join("\n");
}
