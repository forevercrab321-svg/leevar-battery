// Lenient repair for display or logging is fine: nothing is written from it.
import { jsonrepair } from "jsonrepair";

export function showProgress(buffer: string) {
  console.debug("partial answer so far", jsonrepair(buffer));
}

// A comment or string that mentions jsonrepair( is not a call.
export const HELP = "we do not call jsonrepair( here";
