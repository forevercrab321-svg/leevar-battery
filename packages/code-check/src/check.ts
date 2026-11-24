// Walk a path, read each Python / TypeScript / JavaScript file, run the rules.
// Reads only. Nothing found is executed, imported or sent anywhere.

import type { Finding } from "./types.ts";
import { langOf, parseSource } from "./source.ts";
import { checkFile } from "./rules.ts";

export interface ScanResult {
  /** The path the user asked to scan, as given. */
  root: string;
  filesScanned: number;
  findings: Finding[];
}

export interface ScanOptions {
  /** Path prefixes, relative to the scanned root, to leave out. */
  exclude?: string[];
}

/** Directories that hold dependencies, builds or caches, not the user's code. */
export const SKIPPED_DIRS = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  "coverage",
  ".venv",
  "venv",
  "env",
  "__pycache__",
  "site-packages",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
  "vendor",
]);

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
  const findings: Finding[] = [];
  let filesScanned = 0;

  const info = await Deno.stat(root);
  const scanFile = async (abs: string, rel: string) => {
    if (!langOf(rel)) return;
    const st = await Deno.stat(abs);
    if (st.size > MAX_BYTES) return;
    filesScanned++;
    findings.push(...checkText(rel, await Deno.readTextFile(abs)));
  };

  if (info.isFile) {
    const name = root.replace(/\\/g, "/").split("/").pop() ?? root;
    await scanFile(root, name);
    return { root, filesScanned, findings };
  }

  const walk = async (dir: string, rel: string) => {
    const entries: Deno.DirEntry[] = [];
    for await (const e of Deno.readDir(dir)) entries.push(e);
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const childRel = join(rel, e.name);
      if (excluded(childRel)) continue;
      const abs = `${dir}/${e.name}`;
      if (e.isDirectory) {
        if (SKIPPED_DIRS.has(e.name)) continue;
        await walk(abs, childRel);
      } else if (e.isFile) {
        await scanFile(abs, childRel);
      }
      // Symlinks are not followed: they can point outside the project.
    }
  };
  await walk(root.replace(/\/+$/, "") || "/", "");
  return { root, filesScanned, findings };
}
