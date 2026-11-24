// The five rules of the code check.
//
// Each rule is a line-level pattern match over one file, scoped to the
// enclosing function. It finds code SHAPED like a fault that maintainers of a
// real project confirmed (docs/catalog/), not the fault itself: every match is
// a place for a person to read, and the absence of a match proves nothing.
// When in doubt a rule stays quiet; each one has a false-positive control in
// rules_test.ts.

import type { Finding, RuleId, RuleInfo } from "./types.ts";
import {
  blockEnd,
  enclosingFunction,
  functionOrFile,
  functionScopes,
  indentOf,
  linesIn,
  LOG_LINE,
  type Range,
  type Scope,
  type SourceFile,
  statementEnd,
} from "./source.ts";

/** Bumped whenever a rule's matching changes, so a saved JSON result says
 * which rules produced it. */
export const RULES_VERSION = "2";

export const CATALOG_BASE_URL =
  "https://github.com/forevercrab321-svg/leevar-battery/blob/main/docs/catalog/";

const C01 = {
  id: "01",
  title: "Cut-off tool call runs with `{}` arguments (heymrun/heym)",
  file: "01-truncated-tool-call-runs-with-empty-arguments.md",
};
const C02 = {
  id: "02",
  title: "Cut-off answer repaired and written to the store (clusterzx/paperless-ai)",
  file: "02-truncated-answer-repaired-and-applied.md",
};
const C03 = {
  id: "03",
  title: "Cut-off tool call completed by JSON repair and run (langroid/langroid)",
  file: "03-truncated-tool-call-completed-by-json-repair.md",
};
const C04 = {
  id: "04",
  title: "Cut-off tool arguments run in the agent loop (labring/FastGPT)",
  file: "04-truncated-tool-call-in-agent-loop.md",
};
const C05 = {
  id: "05",
  title: "Streamed workflow error dropped, run reported completed (langbot-app/LangBot)",
  file: "05-workflow-error-chunk-reported-as-completed.md",
};
const C06 = {
  id: "06",
  title: "Successful structured tool result sent to the model as an error (emcie-co/parlant)",
  file: "06-structured-mcp-result-reported-as-tool-error.md",
};
const C10 = {
  id: "10",
  title: "HTTP 200 reported as a failed tool call (simstudioai/sim)",
  file: "10-http-200-reported-as-failed-tool-call.md",
};

export const RULES: RuleInfo[] = [
  {
    id: "tool-call-after-truncation",
    title: "Tool calls may run from a response that was cut off by the output limit",
    why:
      "When the model hits its output token limit in the middle of a tool call, the arguments are cut off. If the loop runs the turn's tool calls without first ruling out a length stop, a tool can run with half-written, repaired or default arguments, and the run still looks successful.",
    fix:
      "Before running any tool call, check the stop reason for every transport's length value (`length`, `max_tokens`, `MAX_TOKENS`, `incomplete`) and run none of that turn's calls. Send the model a tool error saying the call was cut off, and stop with a clear message after one or two cut turns in a row.",
    catalog: [C01, C03, C04],
  },
  {
    id: "repaired-json-applied",
    title: "Model output may be JSON-repaired and then used as a complete result",
    why:
      "A lenient JSON repair step closes an unfinished object, so an answer cut off by the output limit parses as valid data. Values come out shortened (an amount of 10 instead of 1000, a tag cut mid-word) and nothing downstream can tell.",
    fix:
      "Carry the stop reason out of the model client and refuse an answer that stopped on length before parsing it. Use lenient repair for display or logging only, never for data that will be written somewhere or passed to a tool.",
    catalog: [C02, C03],
  },
  {
    id: "stream-error-ignored",
    title: "A stream parser may ignore in-band error events",
    why:
      "Many streaming protocols send a failure as an event inside a well-formed HTTP 200 body. A parser that handles only the event types it expects lets an `error` event fall through, so the run is reported as completed with a partial or empty answer.",
    fix:
      "Handle every documented event type, treat an in-band `error` as a failure of the run, and make the default branch fail loudly instead of skipping. Do not finalize a partial answer as complete after an error was seen.",
    catalog: [C05],
  },
  {
    id: "success-as-error",
    title: "A successful result may be reported as a failure",
    why:
      "If a step that runs after the tool has already succeeded (logging, strict serialization) shares its try block, or if success is read from keys inside a third-party body instead of from the HTTP status, a call that worked is reported as failed. The agent may then retry a side-effecting call or tell the user it failed.",
    fix:
      "Decide success from the call itself (the HTTP status code, or whether the tool raised). Keep logging and serialization outside the try that wraps the tool call, make them lenient (`default=str`), and never let them replace the result.",
    catalog: [C06, C10],
  },
  {
    id: "retry-non-idempotent-write",
    title: "A write may be retried automatically without an idempotency key",
    why:
      "When a POST, a send or a create times out after the server already acted, an automatic retry does it again: a second order, a second email, a second charge. Nothing in this file marks the request so the server can drop the duplicate.",
    fix:
      "Send an idempotency key that stays the same across retries of one logical operation (for example an `Idempotency-Key` header), or retry only on errors that prove the request never reached the server, or do not retry writes automatically.",
    catalog: [],
    catalogNote:
      "pattern, not yet in catalog: no maintainer-confirmed case of ours is in docs/catalog/ for this one yet.",
  },
];

export function ruleInfo(id: RuleId): RuleInfo {
  const r = RULES.find((x) => x.id === id);
  if (!r) throw new Error(`unknown rule ${id}`);
  return r;
}

// ---------------------------------------------------------------------------

const REASON = /\b(finish_?reason|finishReason|stop_?reason|stopReason|FinishReason|StopReason)\b/;
const LENGTH =
  /["'`](length|max_tokens|MAX_TOKENS|max_output_tokens|MAX_OUTPUT_TOKENS|incomplete)["'`]|\.(LENGTH|MAX_TOKENS)\b/;
const EXIT = /\b(return|raise|throw|break|continue)\b/;
const NEGATED = /!==?|\bnot\s+in\b|!=/;
const ASSIGN = /^\s*(?:(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=(?!=)(.*)$/;
const DESTRUCTURE = /^\s*(?:const|let|var)\s*\{([^}]*)\}\s*(?::[^=]+)?=(?!=)(.*)$/;
const CONDITION = /^\s*(}\s*)?(if|elif|else\s+if|while)\b|\?\s*$/;
const DEF_LINE = /^\s*((async\s+)?def|(export\s+)?(default\s+)?(async\s+)?function)\b/;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function finding(src: SourceFile, rule: RuleId, i: number, detail: string): Finding {
  return { rule, file: src.path, line: i + 1, snippet: src.raw[i].trim(), detail };
}

function contains(r: Range, i: number): boolean {
  return r.start <= i && i <= r.end;
}

function wordsRe(words: string[]): RegExp | null {
  return words.length ? new RegExp(`\\b(${words.map(escapeRe).join("|")})\\b`) : null;
}

// --- 1. tool-call-after-truncation ------------------------------------------

const TOOL_LIST = /\b(tool_calls|toolCalls|tool_uses|toolUses|function_calls|functionCalls)\b/;
const TOOL_LOOP_PY = /^\s*(async\s+)?for\s+(.+?)\s+in\s+(.*\b(tool_calls|tool_uses|function_calls)\b.*)$/;
const TOOL_LOOP_JS =
  /^\s*for\s*(await\s*)?\(\s*(?:const|let|var)?\s*(.+?)\s+of\s+(.*\b(toolCalls|tool_calls|toolUses|tool_uses|functionCalls)\b.*)$/;
const TOOL_ITER_JS =
  /\b(toolCalls|tool_calls|toolUses|tool_uses|functionCalls)\b[\w$.?!\])]*\s*\.\s*(map|forEach|flatMap)\s*\(\s*(async\s*)?\(?\s*\{?\s*([\w$]+)?/;
/** Streamed fragments of tool calls are assembled, not run. */
const DELTA = /\bdeltas?\b|_delta\b|Delta\b|\bchunk\b/;
/** The name must start with the verb: `_handle_tool_call`, `executeTool`,
 * `ainvoke`; not `_function_call_item`, which builds something. */
const VERB = /^_*a?(execute|run|call|invoke|dispatch|handle|apply)/i;
const PREDICATE =
  /^(is|has|can|should|validate|check|assert|ensure|get|build|format|parse|serialize|to)([A-Z_]|$)|[Aa]llowed|[Pp]ermitted|[Vv]alid/;
const TOOLISH = /tool|function/i;
const TOOL_INDEX = /\b\w*(tool|func|handler|registry)\w*\s*\[[^\]]+\]\s*\(/i;
const DIRECT_DISPATCH =
  /\b([\w$.]*(execute|run|call|invoke|dispatch|handle|process)_?[Tt]ools?(_?[Cc]alls?|_?[Ee]xecution|_?[Uu]ses?)?)\s*\(/;

/** Does this text call something that runs a tool? */
function runsTool(text: string, loopVar: string | null): boolean {
  if (TOOL_INDEX.test(text)) return true;
  const varRe = loopVar ? new RegExp(`\\b${escapeRe(loopVar)}\\b`) : null;
  // Lookahead, so a call nested in another call's arguments is seen too.
  for (const m of text.matchAll(/([\w$.]+)\s*\((?=([^()]*))/g)) {
    const name = m[1].split(".").pop() ?? "";
    if (!VERB.test(name) || PREDICATE.test(name)) continue;
    if (TOOLISH.test(name) || (varRe && varRe.test(m[2]))) return true;
  }
  return false;
}

function toolDispatchLines(src: SourceFile): number[] {
  const out: number[] = [];
  for (let i = 0; i < src.bare.length; i++) {
    const line = src.bare[i];
    if (DEF_LINE.test(line) || LOG_LINE.test(line)) continue;
    const loop = src.lang === "python" ? line.match(TOOL_LOOP_PY) : line.match(TOOL_LOOP_JS);
    const iter = src.lang === "js" ? line.match(TOOL_ITER_JS) : null;
    if (loop || iter) {
      const subject = loop ? loop[3] : line;
      if (DELTA.test(subject)) continue;
      const loopVar = loop ? (loop[2].match(/^[\w$]+$/)?.[0] ?? null) : (iter?.[4] ?? null);
      const end = iter ? statementEnd(src, i) : blockEnd(src, i);
      const first = loop ? line.replace(/^[^:{]*(:|\{)/, "") : line.replace(TOOL_LIST, "");
      const body = [first, ...src.bare.slice(i + 1, end + 1).filter((l) => !LOG_LINE.test(l))].join("\n");
      if (runsTool(body, loopVar)) out.push(i);
      continue;
    }
    const d = line.match(DIRECT_DISPATCH);
    if (d && !PREDICATE.test(d[1].split(".").pop() ?? "")) out.push(i);
  }
  return out;
}

/** Type and interface fields: `finishReason?: string;`, `stop_reason: str = ""`. */
const TYPE_FIELD =
  /^\s*(readonly\s+)?(finish_?reason|finishReason|stop_?reason|stopReason)\s*\??\s*:\s*[\w$.'"|<>\[\], ]+(=[^=].*)?[;,]?\s*$/;

/** Does this line read the model's stop reason? Writing a field of that name,
 * declaring its type, or receiving it from a tool run does not count. */
function readsReason(line: string, reasonRe: RegExp): boolean {
  if (TYPE_FIELD.test(line)) return false;
  const d = line.match(DESTRUCTURE);
  if (d) {
    if (REASON.test(d[1])) return !/\b[\w$]*tool[\w$]*\s*\(/i.test(d[2]);
    return reasonRe.test(d[2]);
  }
  const a = line.match(ASSIGN);
  const text = a ? a[2] : line;
  const stripped = text
    .replace(new RegExp(`${REASON.source}\\s*\\??\\s*:(?!:)`, "g"), "")
    .replace(new RegExp(`${REASON.source}\\s*=(?!=)`, "g"), "");
  return reasonRe.test(stripped);
}

/** Lines of a multi-line destructure whose value comes from a tool run:
 * `const {\n finish_reason,\n} = await runToolCall(...)`. A stop reason read
 * there is the tool runner's result, not the model's turn. */
function toolRunDestructures(src: SourceFile, fn: Range): Set<number> {
  const out = new Set<number>();
  for (let i = fn.start; i <= fn.end; i++) {
    if (!/^\s*(const|let|var)\s*\{\s*$/.test(src.code[i])) continue;
    for (let k = i + 1; k <= Math.min(fn.end, i + 60); k++) {
      const close = src.code[k].match(/^\s*\}\s*(:[^=]+)?=(?!=)(.*)$/);
      if (!close) continue;
      if (/\b[\w$]*tool[\w$]*\s*\(/i.test(close[2])) for (let j = i; j <= k; j++) out.add(j);
      break;
    }
  }
  return out;
}

function checkToolCallAfterTruncation(src: SourceFile, scopes: Scope[]): Finding[] {
  const out: Finding[] = [];
  const done = new Set<number>(); // one finding per function
  for (const d of toolDispatchLines(src)) {
    const fn = enclosingFunction(src, d, scopes);
    if (!fn) continue; // top-level code: not judged (no reliable scope)
    if (done.has(fn.start)) continue;
    const before: Range = { start: fn.start, end: d - 1 };
    const fromToolRun = toolRunDestructures(src, fn);
    const reasonNames: string[] = [];
    for (let i = before.start; i <= before.end; i++) {
      const m = src.code[i].match(ASSIGN);
      if (m && readsReason(src.code[i], REASON)) reasonNames.push(m[1]);
    }
    const reasonRe = new RegExp(
      `${REASON.source}${reasonNames.length ? `|\\b(${reasonNames.map(escapeRe).join("|")})\\b` : ""}`,
    );
    const refs: number[] = [];
    for (let i = before.start; i <= before.end; i++) {
      if (!fromToolRun.has(i) && readsReason(src.code[i], reasonRe)) refs.push(i);
    }
    if (refs.length === 0) continue; // the stop reason is not read before the calls run: out of scope
    // Flags like `truncated = finish_reason == "length"`.
    const flagNames: string[] = [];
    for (let i = before.start; i <= before.end; i++) {
      const m = src.code[i].match(ASSIGN);
      if (m && reasonRe.test(m[2]) && LENGTH.test(m[2])) flagNames.push(m[1]);
    }
    const flagRe = wordsRe(flagNames);

    let guarded = false;
    let lengthBranch = -1;
    let insideLengthBranch = false;
    for (let i = fn.start; i < d && !guarded; i++) {
      const line = src.code[i];
      if (!CONDITION.test(line)) continue;
      const aboutReason = reasonRe.test(line);
      const aboutFlag = flagRe !== null && flagRe.test(line);
      if (!aboutReason && !aboutFlag) continue;
      const end = blockEnd(src, i);
      const body = src.bare.slice(i, end + 1).join("\n");
      const flagNegated = aboutFlag && /\bnot\b|!(?!=)/.test(line);
      const lengthy = LENGTH.test(line) || (aboutFlag && !flagNegated);
      const negated = NEGATED.test(line) || flagNegated;
      if (contains({ start: i, end }, d)) {
        if (lengthy && !negated) {
          insideLengthBranch = true;
          lengthBranch = i;
        } else guarded = true;
        continue;
      }
      if (EXIT.test(body) && (lengthy || negated)) guarded = true;
      else if (lengthy) lengthBranch = i;
    }
    if (guarded) continue;
    done.add(fn.start);
    const nearest = refs[refs.length - 1];
    let detail: string;
    if (insideLengthBranch) {
      detail = `Tool calls may run inside the branch for a length stop (line ${lengthBranch + 1}).`;
    } else if (lengthBranch >= 0) {
      detail =
        `A length stop seems to be noticed at line ${lengthBranch + 1}, but that branch does not appear to stop the turn, so the tool calls here may still run.`;
    } else {
      detail =
        `The stop reason appears to be read at line ${nearest + 1}, and the tool calls here may run without any earlier comparison with a length value (\`length\`, \`max_tokens\`, ...).`;
    }
    out.push(finding(src, "tool-call-after-truncation", d, detail));
  }
  return out;
}

// --- 2. repaired-json-applied -----------------------------------------------

/** Known repair libraries, and the names each one exports that repair JSON.
 * A bare name counts only when it was imported from one of these. */
const REPAIR_EXPORTS: Record<string, string[] | null> = {
  "json_repair": ["repair_json", "loads", "load", "from_file"],
  "partial_json_parser": ["loads"],
  "dirtyjson": ["loads"],
  "jsonrepair": null, // any name imported from it
  "partial-json": null,
  "best-effort-json-parser": null,
  "untruncate-json": null,
  "json-repair": null,
  "ai": ["parsePartialJson"],
  "@ai-sdk/ui-utils": ["parsePartialJson"],
  "@ai-sdk/provider-utils": ["parsePartialJson"],
};
const QUALIFIED_REPAIR = /\b(json_repair\.(loads|load|repair_json|from_file)|partial_json_parser\.loads|dirtyjson\.loads)\s*\(/;
const TRUNCATION_GUARD =
  /\b(finish_?reason|finishReason|stop_?reason|stopReason)\b|truncat|incomplete|is_?complete|isComplete|repaired-parse|was_?repaired|wasRepaired/i;

/** Regex sources (already escaped) for names that call a repair function. */
function repairImports(src: SourceFile): string[] {
  const names: string[] = [];
  const allowed = (mod: string, name: string) => {
    const list = REPAIR_EXPORTS[mod];
    return list === null || (list !== undefined && list.includes(name));
  };
  for (const line of src.code) {
    let m = line.match(/^\s*from\s+([\w.]+)\s+import\s+(.+)$/);
    if (m && m[1] in REPAIR_EXPORTS) {
      for (const part of m[2].replace(/[()]/g, "").split(",")) {
        const p = part.trim().split(/\s+as\s+/);
        const orig = p[0].trim();
        if (orig === "*") {
          for (const n of REPAIR_EXPORTS[m[1]] ?? []) names.push(escapeRe(n));
        } else if (/^\w+$/.test(orig) && allowed(m[1], orig)) {
          names.push(escapeRe((p[1] ?? orig).trim()));
        }
      }
      continue;
    }
    m = line.match(/^\s*import\s+([\w.]+)(?:\s+as\s+(\w+))?\s*$/);
    if (m && m[1] in REPAIR_EXPORTS) {
      names.push(`${escapeRe(m[2] ?? m[1])}\\.\\w+`);
      continue;
    }
    m = line.match(/^\s*import\s+(.+?)\s+from\s+["']([^"']+)["']/);
    if (m && m[2] in REPAIR_EXPORTS) {
      const spec = m[1];
      const named = spec.match(/\{([^}]*)\}/);
      if (named) {
        for (const part of named[1].split(",")) {
          const p = part.trim().split(/\s+as\s+/);
          const orig = p[0].trim();
          if (/^[\w$]+$/.test(orig) && allowed(m[2], orig)) names.push(escapeRe((p[1] ?? orig).trim()));
        }
      }
      const rest = spec.replace(/\{[^}]*\}/, "").replace(/,/g, " ").trim();
      const ns = rest.match(/\*\s+as\s+([\w$]+)/);
      if (ns) names.push(`${escapeRe(ns[1])}\\.[\\w$]+`);
      else if (/^[\w$]+$/.test(rest.split(/\s+/)[0] ?? "") && REPAIR_EXPORTS[m[2]] === null) {
        names.push(escapeRe(rest.split(/\s+/)[0]));
      }
    }
  }
  return names.filter(Boolean);
}

function checkRepairedJson(src: SourceFile, scopes: Scope[]): Finding[] {
  const imported = repairImports(src);
  const importedRe = imported.length ? new RegExp(`(^|[^\\w$.])(${imported.join("|")})\\s*\\(`) : null;
  const out: Finding[] = [];
  src.bare.forEach((line, i) => {
    if (/^\s*(import|from)\b/.test(line) || DEF_LINE.test(line)) return;
    if (!QUALIFIED_REPAIR.test(line) && !(importedRe && importedRe.test(line))) return;
    if (LOG_LINE.test(line)) return; // display or logging only
    const fn = functionOrFile(src, i, scopes);
    if (TRUNCATION_GUARD.test(linesIn(src, fn))) return;
    out.push(finding(
      src,
      "repaired-json-applied",
      i,
      "This looks like a JSON repair of model output, and nothing in this function appears to check whether the output was cut off (stop reason, `truncated`, `incomplete`) before the repaired value is used. A check in the caller would not be seen.",
    ));
  });
  return out;
}

// --- 3. stream-error-ignored ------------------------------------------------

const STREAM_MARKER =
  /iter_lines|aiter_lines|iter_text|aiter_text|readline|getReader\s*\(|\.split\(\s*["'`]\\n|["'`]data:|for\s+await|async\s+for|EventSource|ndjson|event-stream/i;
const PARSE_CALL = /\b(json\.loads|JSON\.parse|orjson\.loads|ujson\.loads)\s*\(/;
const TYPE_SUBJECT = /type|event|kind/i;
const ERROR_LITERAL = /error|fail|exception|abort|cancel/i;
const ERROR_MENTION =
  /["'`](error|failed|failure|errors)["'`]|(?<!(console|logger|logging|log|LOGGER|_logger|warnings))\.(error|err|errors)\b/;

interface Comparison {
  line: number;
  subject: string;
  base: string;
  literal: string;
}

function baseOf(subject: string): string {
  return subject.match(/^[\w$]+/)?.[0] ?? "";
}

function comparisons(src: SourceFile, fn: Range): Comparison[] {
  const out: Comparison[] = [];
  for (let i = fn.start; i <= fn.end; i++) {
    const line = src.code[i];
    if (!/^\s*(}\s*)?(if|elif|else\s+if)\b/.test(line)) continue;
    const re = /([\w$.\[\]"'()]+?)\s*(?:===?)\s*(["'`])([^"'`]+)\2|(["'`])([^"'`]+)\4\s*(?:===?)\s*([\w$.\[\]"'()]+)/g;
    for (const m of line.matchAll(re)) {
      const subject = (m[1] ?? m[6]).replace(/^(if|elif)\b|^\(+|\s/g, "");
      const literal = m[3] ?? m[5];
      if (TYPE_SUBJECT.test(subject)) out.push({ line: i, subject, base: baseOf(subject), literal });
    }
  }
  for (let i = fn.start; i <= fn.end; i++) {
    const line = src.code[i];
    const sw = line.match(/^\s*switch\s*\((.+)\)\s*\{?\s*$/) ?? line.match(/^\s*match\s+(.+):\s*$/);
    if (!sw || !TYPE_SUBJECT.test(sw[1])) continue;
    const end = blockEnd(src, i);
    for (let k = i + 1; k <= end; k++) {
      for (const m of src.code[k].matchAll(/\bcase\s+(["'`])([^"'`]+)\1/g)) {
        const expr = sw[1].replace(/\s/g, "").replace(/^\(+/, "");
        out.push({ line: i, subject: `switch:${i}:${expr}`, base: baseOf(expr), literal: m[2] });
      }
    }
  }
  return out;
}

/** Is `name` assigned from a JSON parse inside a loop, in this function? */
function parsedInLoop(src: SourceFile, fn: Range, name: string): boolean {
  if (!name) return false;
  const assign = new RegExp(`(^|[^\\w$.])${escapeRe(name)}\\s*(:[^=]+)?=(?!=)\\s*(await\\s+)?.*${PARSE_CALL.source}`);
  for (let i = fn.start; i <= fn.end; i++) {
    if (!assign.test(src.code[i])) continue;
    for (let h = fn.start; h < i; h++) {
      if (!/^\s*(async\s+)?(for|while)\b/.test(src.bare[h])) continue;
      if (blockEnd(src, h) >= i) return true;
    }
  }
  return false;
}

function hasFailingDefault(src: SourceFile, group: Comparison[]): boolean {
  const first = group[0].line;
  if (group[0].subject.startsWith("switch:")) {
    const end = blockEnd(src, first);
    for (let k = first + 1; k <= end; k++) {
      if (/^\s*(default\s*:|case\s+_\s*:)/.test(src.code[k])) {
        const body = src.bare.slice(k, end + 1).join("\n");
        return /\b(raise|throw)\b/.test(body.split(/\bcase\b/)[0]);
      }
    }
    return false;
  }
  const last = group[group.length - 1].line;
  const end = blockEnd(src, last);
  const base = indentOf(src.code[first]);
  for (let k = end; k <= Math.min(src.code.length - 1, end + 2); k++) {
    const line = src.code[k];
    const m = line.match(/\belse\b(?!\s*if)/);
    if (!m) continue;
    if (src.lang === "python" && indentOf(line) !== base) continue;
    const bodyEnd = blockEnd(src, k, src.lang === "js" ? m.index ?? 0 : 0);
    return /\b(raise|throw)\b/.test(src.bare.slice(k, bodyEnd + 1).join("\n"));
  }
  return false;
}

function checkStreamErrors(src: SourceFile, scopes: Scope[]): Finding[] {
  const out: Finding[] = [];
  const seen = new Set<number>();
  for (const fn of scopes) {
    const text = linesIn(src, fn);
    if (!STREAM_MARKER.test(text) || !PARSE_CALL.test(text)) continue;
    const groups = new Map<string, Comparison[]>();
    for (const c of comparisons(src, fn)) {
      if (enclosingFunction(src, c.line, scopes) !== fn) continue; // belongs to a nested function
      const g = groups.get(c.subject) ?? [];
      g.push(c);
      groups.set(c.subject, g);
    }
    for (const group of groups.values()) {
      group.sort((a, b) => a.line - b.line);
      const literals = new Set(group.map((c) => c.literal));
      if (literals.size < 2) continue;
      if ([...literals].some((l) => ERROR_LITERAL.test(l))) continue;
      if (!parsedInLoop(src, fn, group[0].base)) continue; // not hand-parsed stream events
      if (ERROR_MENTION.test(text)) continue;
      if (hasFailingDefault(src, group)) continue;
      const at = group[0].line;
      if (seen.has(at)) continue;
      seen.add(at);
      out.push(finding(
        src,
        "stream-error-ignored",
        at,
        `This looks like a hand-written stream parser that handles ${
          [...literals].map((l) => `\`${l}\``).join(", ")
        }; no branch appears to handle an error event, and other event types may be skipped rather than failing the run.`,
      ));
    }
  }
  return out;
}

// --- 4. success-as-error ----------------------------------------------------

const TOOL_CALL =
  /[\w$.]*(call|run|execute|invoke)_?[Tt]ool\w*\s*\(|\btools?\s*\[[^\]]+\]\s*\(|\btool\.(run|arun|invoke|ainvoke|call|execute)\s*\(/;
const STRICT_SERIALIZE = /\bjson\.dumps\s*\(/;
const ERROR_RESULT =
  /["'`][^"'`]*(error|fail)[^"'`]*["'`]|is_?[Ee]rror\s*[:=]\s*(True|true)|success\s*[:=]\s*(False|false)|["']?ok["']?\s*[:=]\s*(False|false)/i;

function checkSuccessAsError(src: SourceFile, scopes: Scope[]): Finding[] {
  const out: Finding[] = [];
  // 4a (catalog 06, Python only): a strict json.dumps after the tool call,
  // inside the same try, whose broad except turns any exception into an
  // error result. JSON.stringify on plain data does not throw in practice,
  // so JS is left out.
  if (src.lang === "python") {
    for (let t = 0; t < src.bare.length; t++) {
      const line = src.bare[t];
      if (!/^\s*try\s*:\s*$/.test(line)) continue;
      const tryEnd = blockEnd(src, t);
      let call = -1;
      let ser = -1;
      for (let k = t + 1; k <= tryEnd; k++) {
        const b = src.bare[k];
        if (call < 0 && TOOL_CALL.test(b) && !DEF_LINE.test(b)) call = k;
        else if (call >= 0 && STRICT_SERIALIZE.test(b) && !/default\s*=|cls\s*=/.test(src.code[k])) {
          ser = k;
          break;
        }
      }
      if (call < 0 || ser < 0) continue;
      let h = -1;
      const base = indentOf(line);
      for (let k = tryEnd + 1; k < src.bare.length; k++) {
        if (src.bare[k].trim() === "") continue;
        if (indentOf(src.bare[k]) === base && /^\s*except\b/.test(src.bare[k])) h = k;
        break;
      }
      if (h < 0 || !/^\s*except\s*(\(?\s*(Exception|BaseException)\b[^:]*)?:/.test(src.bare[h])) continue;
      const hEnd = blockEnd(src, h);
      const handler = src.code.slice(h, hEnd + 1).join("\n");
      if (!ERROR_RESULT.test(handler)) continue;
      if (/^\s*raise\b/m.test(src.bare.slice(h + 1, hEnd + 1).join("\n"))) continue;
      out.push(finding(
        src,
        "success-as-error",
        ser,
        `This serialization appears to run after the tool call at line ${
          call + 1
        } has returned, inside the same try. If it raises (an object json.dumps cannot encode), the handler at line ${
          h + 1
        } may report the tool as failed.`,
      ));
    }
  }

  // 4b (catalog 10): success read from keys inside a parsed response body.
  src.code.forEach((line, i) => {
    if (!/^\s*(}\s*)?(if|elif|else\s+if)\b/.test(line)) return;
    const m = line.match(/["']status["']\s+in\s+([\w$]+)/) ??
      line.match(/\b([\w$]+)\.hasOwnProperty\(\s*["']status["']\s*\)/) ??
      line.match(/\b([\w$]+)\.status\s*(?:!==?\s*undefined\s*)?&&/);
    if (!m) return;
    const v = escapeRe(m[1]);
    const otherKey = new RegExp(
      `["'](data|result|error|success)["']\\s+in\\s+${v}\\b|\\b${v}\\.(data|result|error|success)\\b|${v}\\.hasOwnProperty\\(\\s*["'](data|result|error|success)`,
    );
    if (!otherKey.test(line)) return;
    const fn = functionOrFile(src, i, scopes);
    const parsed = new RegExp(`\\b${v}\\s*(:[^=]+)?=\\s*.*(\\.json\\s*\\(|json\\.loads|JSON\\.parse)`);
    if (!parsed.test(linesIn(src, fn))) return;
    const body = src.code.slice(i, blockEnd(src, i) + 1).join("\n");
    const fromBody = new RegExp(
      `(success|ok|status)["']?\\s*[:=]\\s*${v}(\\.|\\[)|success\\s*[:=]\\s*(False|false|None|undefined)`,
    );
    if (!fromBody.test(body) && !ERROR_RESULT.test(body)) return;
    out.push(finding(
      src,
      "success-as-error",
      i,
      `Success or failure appears to be decided here from keys inside the parsed body \`${m[1]}\`, not from the HTTP status. A 200 whose body happens to have these keys may be reported as failed.`,
    ));
  });
  return out;
}

// --- 5. retry-non-idempotent-write ------------------------------------------

const RETRY_DECORATOR =
  /^\s*@(tenacity\.)?retry\b|^\s*@backoff\.on_(exception|predicate)\b|^\s*@(with_retry|retryable|retry_on_\w+)\b/;
const RETRY_LOOP = /^\s*(for|while)\b.*\b(retr\w*|attempts?|tries|max_tries|num_tries)\b/i;
const RETRY_WRAPPER =
  /\b(pRetry|p_retry|asyncRetry|withRetry|withRetries|retryAsync|backOff|retry|Retrying|AsyncRetrying)\s*\(\s*(async\b|\(|function\b|lambda\b|[\w$]+\s*=>)/;
const URLLIB3_RETRY = /\bRetry\s*\(/;
const WRITE =
  /\.\s*(post|patch)\s*\(|\bmethod\s*[:=]\s*["'`](POST|PATCH)["'`]|\bsend_?(e?mail|message|sms|notification)\w*\s*\(|\bsend(E?[Mm]ail|Message|Sms|SMS|Notification)\w*\s*\(|\bcreate_?(order|payment|charge|invoice|refund|transfer|payout)\w*\s*\(|\b(charges|paymentIntents|payment_intents|refunds|orders|invoices|transfers|payouts|Charge|PaymentIntent|Refund|Order|Invoice|Transfer|Payout)\.create\s*\(/i;
const MODEL_CALL =
  /completions|chat\.|messages\.create|responses\.create|embeddings|generate_?content|\/v1\/(chat|messages|completions|responses|embeddings)|\/api\/(chat|generate|embed)|\btts\b|speech|synthes/i;
/** Requests that read or authenticate rather than change state. */
const NON_WRITE_POST = /token|oauth|auth|search|query|lookup|match|graphql|login|verify|validate|screen/i;
const IDEMPOTENCY = /idempot|dedup\w*[_-]?key|client_?token|clientRequestToken/i;

function writesIn(src: SourceFile, r: Range): number[] {
  const out: number[] = [];
  for (let i = r.start; i <= r.end; i++) {
    const code = src.code[i];
    if (!WRITE.test(code) || MODEL_CALL.test(code) || NON_WRITE_POST.test(code)) continue;
    if (!WRITE.test(src.bare[i]) && !/\bmethod\s*[:=]/.test(code)) continue;
    out.push(i);
  }
  return out;
}

/** A loop that retries only when the server answered 429 (it refused the
 * request), never on 5xx or timeouts, and re-raises network errors, cannot
 * send a write twice. */
function retriesOnlyOnRefusal(src: SourceFile, scope: Range): boolean {
  const text = linesIn(src, scope);
  if (!/\b429\b/.test(text)) return false;
  // 5xx and timeouts can come back after the server already acted.
  if (/\b5\d\d\b|timeout|timed\s*out|ETIMEDOUT|ECONNRESET/i.test(text)) return false;
  for (let i = scope.start; i <= scope.end; i++) {
    const line = src.bare[i];
    const m = line.match(/^\s*except\b|\bcatch\b/);
    if (!m) continue;
    const end = blockEnd(src, i, src.lang === "js" ? line.search(/\bcatch\b/) : 0);
    if (!/\b(raise|throw)\b/.test(src.bare.slice(i, end + 1).join("\n"))) return false;
  }
  return true;
}

function checkRetryWrites(src: SourceFile, scopes: Scope[]): Finding[] {
  if (IDEMPOTENCY.test(src.code.join("\n"))) return [];
  const out: Finding[] = [];
  const seen = new Set<number>();
  const report = (w: number, retryLine: number, how: string) => {
    if (seen.has(w)) return;
    seen.add(w);
    out.push(finding(
      src,
      "retry-non-idempotent-write",
      w,
      `This looks like a write inside ${how} (line ${retryLine + 1}), and no idempotency key appears in this file. A key set elsewhere would not be seen.`,
    ));
  };

  src.bare.forEach((line, i) => {
    let scope: Range | null = null;
    let how = "";
    if (src.lang === "python" && RETRY_DECORATOR.test(line)) {
      let d = i + 1;
      while (d < src.bare.length && /^\s*@/.test(src.bare[d])) d++;
      if (d < src.bare.length && /^\s*(async\s+)?def\b/.test(src.bare[d])) {
        scope = { start: d, end: blockEnd(src, d) };
        how = "a function retried by a decorator";
      }
    } else if (RETRY_LOOP.test(line)) {
      scope = { start: i, end: blockEnd(src, i) };
      how = "a retry loop";
    } else if (RETRY_WRAPPER.test(line) && !/^\s*@/.test(line) && !DEF_LINE.test(line)) {
      scope = { start: i, end: statementEnd(src, i) };
      how = "a retry wrapper";
    } else if (src.lang === "python" && URLLIB3_RETRY.test(line)) {
      const end = statementEnd(src, i);
      const args = src.code.slice(i, end + 1).join(" ");
      if (
        /(allowed_methods|method_whitelist)\s*=\s*(None|False)\b|(allowed_methods|method_whitelist)\s*=[^)]*["'](POST|PATCH)["']/
          .test(args) && !seen.has(i)
      ) {
        seen.add(i);
        out.push(finding(
          src,
          "retry-non-idempotent-write",
          i,
          "This HTTP retry policy appears to retry POST/PATCH requests too (`allowed_methods`), and no idempotency key appears in this file.",
        ));
      }
      return;
    }
    if (!scope) return;
    if (MODEL_CALL.test(linesIn(src, scope))) return; // retrying a model call is not this rule
    if (retriesOnlyOnRefusal(src, scope)) return;
    const fn = enclosingFunction(src, scope.start, scopes);
    if (fn && NON_WRITE_POST.test(src.code[fn.start])) return; // e.g. refreshToken(), searchX()
    const writes = writesIn(src, scope);
    if (writes.length) report(writes[0], i, how);
  });
  return out;
}

// ---------------------------------------------------------------------------

export function checkFile(src: SourceFile): Finding[] {
  const scopes = functionScopes(src);
  return [
    ...checkToolCallAfterTruncation(src, scopes),
    ...checkRepairedJson(src, scopes),
    ...checkStreamErrors(src, scopes),
    ...checkSuccessAsError(src, scopes),
    ...checkRetryWrites(src, scopes),
  ].sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule));
}
