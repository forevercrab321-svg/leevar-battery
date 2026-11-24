// Walk a path, read each Python / TypeScript / JavaScript file, run the rules.
// Reads only. Nothing found is executed, imported or sent anywhere.

import type { Finding } from "./types.ts";
import { langOf, parseSource } from "./source.ts";
import { checkFile } from "./rules.ts";

export interface ScanResult {
  /** The path the user asked to scan, as given. */
  root: string;
  filesScanned: number;
  /** Test files left out (see `isTestFile`); 0 with `includeTests`. */
  testsSkipped: number;
  /** Files that could not be read or checked, and why. The scan goes on. */
  skipped: { file: string; reason: string }[];
  findings: Finding[];
}

export interface ScanOptions {
  /** Path prefixes, relative to the scanned root, to leave out. */
  exclude?: string[];
  /** Scan test files too. Off by default: tests build faulty shapes on purpose. */
  includeTests?: boolean;
  /** How a file is read. Replaceable in tests. */
  readFile?: (path: string) => Promise<string>;
}

/** Directories that hold dependencies, builds or caches, not the user's code. */
export const SKIPPED_DIRS = new Set([
  "node_modules", ".git", ".hg", ".svn", "dist", "build", "out", ".next", ".nuxt", "coverage",
  ".venv", "venv", "env", "__pycache__", "site-packages", ".tox", ".mypy_cache", ".pytest_cache",
  "vendor",
]);

const TEST_DIRS = new Set(["test", "tests", "__tests__"]);
const TEST_FILE = /\.(test|spec)\.[^/]+$|(^|\/)test_[^/]*\.py$|_test\.(py|[mc]?[jt]sx?)$|(^|\/)conftest\.py$/;

/** A test file or a file under a test folder, by path. */
export function isTestFile(rel: string): boolean {
  const parts = rel.split("/");
  return parts.slice(0, -1).some((p) => TEST_DIRS.has(p)) || TEST_FILE.test(rel);
}

/** Files bigger than this are skipped (generated or bundled code). */
const MAX_BYTES = 1_000_000;
/** A line this long means minified code; the whole file is skipped. */
const MAX_LINE = 2_000;

/** Run the rules on one file's text. Unknown extensions give no findings. */
export function checkText(path: string, text: string): Finding[] {
  const lang = langOf(path);
  if (!lang) return [];
  if (text.split("\n").some((l) => l.length > MAX_LINE)) return [];
  return checkFile(parseSource(path, text, lang));
}

function join(a: string, b: string): string {
  return a === "" ? b : `${a}/${b}`;
}

function normalizePrefix(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

export async function scanPath(root: string, opts: ScanOptions = {}): Promise<ScanResult> {
  const exclude = (opts.exclude ?? []).map(normalizePrefix).filter(Boolean);
  const excluded = (rel: string) => exclude.some((e) => rel === e || rel.startsWith(`${e}/`));
  const read = opts.readFile ?? ((p: string) => Deno.readTextFile(p));
  const result: ScanResult = { root, filesScanned: 0, testsSkipped: 0, skipped: [], findings: [] };

  const scanFile = async (abs: string, rel: string, explicit: boolean) => {
    if (!langOf(rel)) return;
    if (!explicit && !opts.includeTests && isTestFile(rel)) {
      result.testsSkipped++;
      return;
    }
    try {
      const st = await Deno.stat(abs);
      if (st.size > MAX_BYTES) return;
      const text = await read(abs);
      const found = checkText(rel, text);
      result.filesScanned++;
      result.findings.push(...found);
    } catch (err) {
      result.skipped.push({ file: rel, reason: err instanceof Error ? err.message : String(err) });
    }
  };

  const info = await Deno.stat(root);
  if (info.isFile) {
    const name = root.replace(/\\/g, "/").split("/").pop() ?? root;
    await scanFile(root, name, true);
    return result;
  }

  const walk = async (dir: string, rel: string) => {
    const entries: Deno.DirEntry[] = [];
    try {
      for await (const e of Deno.readDir(dir)) entries.push(e);
    } catch (err) {
      result.skipped.push({ file: rel || ".", reason: err instanceof Error ? err.message : String(err) });
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const childRel = join(rel, e.name);
      if (excluded(childRel)) continue;
      const abs = `${dir}/${e.name}`;
      if (e.isDirectory) {
        if (SKIPPED_DIRS.has(e.name)) continue;
        await walk(abs, childRel);
      } else if (e.isFile) {
        await scanFile(abs, childRel, false);
      }
      // Symlinks are not followed: they can point outside the project.
    }
  };
  await walk(root.replace(/\/+$/, "") || "/", "");
  return result;
}
