#!/usr/bin/env -S deno run --allow-write=docs/fixes
// Writes docs/fixes/D1.md … D6.md from packages/scanner-core/src/fix-guide.ts.
//
//   deno task fixes
//
// fix-guide_test.ts fails when the committed files differ from this output.

import { BATTERY } from "../../packages/scanner-core/src/battery.ts";
import { renderFixDoc } from "../../packages/scanner-core/src/fix-guide.ts";

for (const d of BATTERY) {
  const path = new URL(`./${d.id}.md`, import.meta.url);
  await Deno.writeTextFile(path, renderFixDoc(d.id));
  console.log(`wrote docs/fixes/${d.id}.md`);
}
