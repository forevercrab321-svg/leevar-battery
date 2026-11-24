// Shape of catalog cases 03/04 (rewritten, minimal): tool arguments that fail
// to parse are completed by a repair step and handed to the tool.
import { jsonrepair } from "jsonrepair";
import { parse as parsePartial } from "partial-json";

export function parseToolArgs(raw: string) {
  try {
    return JSON.parse(raw);
  } catch {
    return JSON.parse(jsonrepair(raw));
  }
}

export function parseAnswer(raw: string) {
  return parsePartial(raw);
}
