// Regenerates battery.json from the running battery definition, so the MCP
// server ships exactly the tests the hosted scan grades. Run from this folder:
//   deno run --allow-write=battery.json gen-battery.ts
import { BATTERY, BATTERY_ID } from "../scanner-core/src/battery.ts";

const out = {
  battery_id: BATTERY_ID,
  dimensions: BATTERY.map((d) => ({
    key: d.key,
    name: d.name,
    fixes: d.fixes,
    tests: d.tests.map((t) => ({
      name: t.name,
      checks: t.checks,
      catches: t.failureMode,
      needs_verified_source: Boolean(t.needsVerifiedSource),
    })),
  })),
};
await Deno.writeTextFile("battery.json", JSON.stringify(out, null, 2) + "\n");
console.log(`battery.json: ${BATTERY_ID}, ${BATTERY.length} dimensions`);
