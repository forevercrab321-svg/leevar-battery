// Shared types for the code check.

export type Lang = "python" | "js";

export type RuleId =
  | "tool-call-after-truncation"
  | "repaired-json-applied"
  | "stream-error-ignored"
  | "success-as-error"
  | "retry-non-idempotent-write";

/** One possible problem at one place in one file. */
export interface Finding {
  rule: RuleId;
  /** Path as given to the checker (relative to the scanned root when scanning a directory). */
  file: string;
  /** 1-based line number. */
  line: number;
  /** The source line, trimmed. */
  snippet: string;
  /** What this specific match looks like, in one or two sentences. */
  detail: string;
}

export interface CatalogRef {
  /** Catalog entry number, e.g. "03". */
  id: string;
  title: string;
  /** File name under docs/catalog/. */
  file: string;
}

export interface RuleInfo {
  id: RuleId;
  title: string;
  /** Why the pattern is risky. */
  why: string;
  /** How to fix it, in general terms. */
  fix: string;
  /** Catalog cases this pattern comes from. Empty when there is none yet. */
  catalog: CatalogRef[];
  /** Said instead of catalog links when `catalog` is empty. */
  catalogNote?: string;
}
