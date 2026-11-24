// Reading a source file well enough for line-level rules, without a parser.
//
// Each file is kept three ways, all with the same lines and columns:
//   raw   the file as written (for snippets)
//   code  comments blanked, strings kept ("length" is still visible)
//   bare  comments blanked and string bodies blanked (quotes kept), so a
//         brace, a keyword or a call inside a string is not mistaken for code
//
// Known limits, on purpose: JavaScript regex literals are not recognised (a
// quote inside one can blank the rest of its line), and blocks are found by
// indentation (Python) or brace matching (JS/TS), not by a grammar.

import type { Lang } from "./types.ts";

export interface SourceFile {
  path: string;
  lang: Lang;
  raw: string[];
  code: string[];
  bare: string[];
}

export interface Range {
  start: number;
  end: number;
}

const JS_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i;

export function langOf(path: string): Lang | null {
  const p = path.toLowerCase();
  if (p.endsWith(".py")) return "python";
  if (/\.d\.(ts|mts|cts)$/.test(p)) return null;
  if (JS_EXT.test(p)) return "js";
  return null;
}

export function parseSource(path: string, text: string, lang: Lang): SourceFile {
  const src = text.replace(/\r\n?/g, "\n");
  const code: string[] = [];
  const bare: string[] = [];
  const n = src.length;
  let i = 0;
  // Current string delimiter, or "" outside strings.
  let quote = "";
  let blockComment = false;
  let lineComment = false;

  const push = (c: string, inCode: boolean, inBare: boolean) => {
    code.push(inCode || c === "\n" ? c : " ");
    bare.push(inBare || c === "\n" ? c : " ");
  };

  while (i < n) {
    const c = src[i];
    if (lineComment) {
      if (c === "\n") lineComment = false;
      push(c, false, false);
      i++;
      continue;
    }
    if (blockComment) {
      if (c === "*" && src[i + 1] === "/") {
        push(c, false, false);
        push("/", false, false);
        i += 2;
        blockComment = false;
        continue;
      }
      push(c, false, false);
      i++;
      continue;
    }
    if (quote) {
      if (c === "\\" && i + 1 < n) {
        push(c, true, false);
        push(src[i + 1], true, false);
        i += 2;
        continue;
      }
      if (src.startsWith(quote, i)) {
        for (const q of quote) push(q, true, true);
        i += quote.length;
        quote = "";
        continue;
      }
      // An unterminated one-line string ends at the newline.
      if (c === "\n" && quote.length === 1 && quote !== "`") quote = "";
      push(c, true, false);
      i++;
      continue;
    }
    // Outside strings and comments.
    if (lang === "python" && c === "#") {
      lineComment = true;
      continue;
    }
    if (lang === "js" && c === "/" && src[i + 1] === "/") {
      lineComment = true;
      continue;
    }
    if (lang === "js" && c === "/" && src[i + 1] === "*") {
      blockComment = true;
      push(c, false, false);
      push("*", false, false);
      i += 2;
      continue;
    }
    if (lang === "python" && (src.startsWith('"""', i) || src.startsWith("'''", i))) {
      quote = src.slice(i, i + 3);
      for (const q of quote) push(q, true, true);
      i += 3;
      continue;
    }
    if (c === '"' || c === "'" || (lang === "js" && c === "`")) {
      quote = c;
      push(c, true, true);
      i++;
      continue;
    }
    push(c, true, true);
    i++;
  }

  return {
    path,
    lang,
    raw: src.split("\n"),
    code: code.join("").split("\n"),
    bare: bare.join("").split("\n"),
  };
}

export function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function isBlank(line: string): boolean {
  return line.trim() === "";
}

/** Index of the last line of the block whose header starts on line `i`.
 * Returns `i` itself for a one-line statement (`if x: return y`). */
export function blockEnd(src: SourceFile, i: number, col = 0): number {
  return src.lang === "python" ? pyBlockEnd(src, i) : jsBlockEnd(src, i, col);
}

function pyBlockEnd(src: SourceFile, i: number): number {
  const b = src.bare;
  // Find where the header ends (a line ending in ':'), allowing a header that
  // wraps over a few lines.
  let h = -1;
  for (let j = i; j < Math.min(b.length, i + 10); j++) {
    const t = b[j].trimEnd();
    if (t.endsWith(":")) {
      h = j;
      break;
    }
    if (j === i && /:\s*\S/.test(t) && /^\s*(if|elif|else|for|while|try|except|with|def|async|class|finally)\b/.test(t)) {
      return i; // one-line block: `if x: return y`
    }
  }
  if (h < 0) return i;
  const base = indentOf(b[i]);
  let end = h;
  for (let k = h + 1; k < b.length; k++) {
    if (isBlank(b[k])) continue;
    if (indentOf(b[k]) <= base) break;
    end = k;
  }
  return end;
}

function jsBlockEnd(src: SourceFile, i: number, col: number): number {
  const b = src.bare;
  let paren = 0;
  let sawParen = false;
  for (let j = i; j < b.length; j++) {
    const line = b[j];
    for (let k = j === i ? col : 0; k < line.length; k++) {
      const c = line[k];
      if (c === "(" || c === "[") {
        paren++;
        sawParen = true;
      } else if (c === ")" || c === "]") paren--;
      else if (c === "{" && paren <= 0) {
        return matchBrace(src, j, k);
      } else if (c === ";" && paren <= 0) {
        return j; // a braceless one-statement body
      }
    }
    // `if (x)` followed by a statement on the next line.
    if (sawParen && paren <= 0 && j > i && !isBlank(line)) return j;
    if (sawParen && paren <= 0 && j === i) {
      const rest = line.slice(line.lastIndexOf(")") + 1).trim();
      if (rest !== "" && !rest.startsWith("{")) return j;
    }
  }
  return i;
}

/** Line of the brace that closes the `{` at (line, col). */
export function matchBrace(src: SourceFile, line: number, col: number): number {
  let depth = 0;
  const b = src.bare;
  for (let j = line; j < b.length; j++) {
    for (let k = j === line ? col : 0; k < b[j].length; k++) {
      const c = b[j][k];
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) return j;
      }
    }
  }
  return b.length - 1;
}

/** Last line of the statement starting on line `i`: where all brackets opened
 * on or after it are closed again. Used for `xs.map((x) => { ... })`. */
export function statementEnd(src: SourceFile, i: number): number {
  let depth = 0;
  const b = src.bare;
  for (let j = i; j < b.length; j++) {
    for (const c of b[j]) {
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") depth--;
    }
    if (depth <= 0) return j;
  }
  return b.length - 1;
}

const PY_DEF = /^\s*(async\s+)?def\s+\w+/;
const JS_FUNCS = [
  /\bfunction\b[\s*]*[\w$]*\s*(<[^>]*>)?\s*\(/,
  /^\s*(export\s+)?(default\s+)?(const|let|var)\s+[\w$]+\s*(:[^=]+)?=\s*(async\s+)?(\([^)]*\)|[\w$]+)\s*(:\s*[^=]+)?=>/,
  /^\s*((public|private|protected|static|async|override|readonly)\s+)*\*?[\w$]+\s*(<[^>]*>)?\s*\([^)]*\)?\s*(:\s*[^{;]+)?\{?\s*$/,
];
const JS_NOT_FUNC = /^\s*(if|for|while|switch|catch|return|else|do|try|with|await|new|typeof|case)\b/;

/** Function bodies, as line ranges, header line included. */
export function functionScopes(src: SourceFile): Range[] {
  const out: Range[] = [];
  src.bare.forEach((line, i) => {
    if (src.lang === "python") {
      if (PY_DEF.test(line)) out.push({ start: i, end: pyBlockEnd(src, i) });
      return;
    }
    if (JS_NOT_FUNC.test(line)) return;
    if (!JS_FUNCS.some((re) => re.test(line))) return;
    const end = jsBlockEnd(src, i, 0);
    if (end > i || /\{.*\}/.test(line)) out.push({ start: i, end });
  });
  return out;
}

/** The innermost named function around line `i`, or the whole file. */
export function enclosingFunction(src: SourceFile, i: number, scopes = functionScopes(src)): Range {
  let best: Range = { start: 0, end: src.bare.length - 1 };
  for (const s of scopes) {
    if (s.start <= i && i <= s.end && s.start >= best.start && !(s.start === best.start && s.end > best.end)) {
      best = s;
    }
  }
  return best;
}

export function linesIn(src: SourceFile, r: Range, which: "code" | "bare" = "code"): string {
  return src[which].slice(r.start, r.end + 1).join("\n");
}

/** A line that only logs or prints. */
export const LOG_LINE =
  /^\s*(await\s+)?(print|console\.\w+|(self\.|this\.)?(logger|logging|log|_logger|LOGGER)\.\w+|warnings\.warn)\s*\(/;
