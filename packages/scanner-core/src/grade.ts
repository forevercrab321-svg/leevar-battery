// Grade scale — ported VERBATIM from the frontend (src/components/clinic/data.ts
// gradeLetter / gradeBand). The paid scan grades on the exact same standard the
// demo and marketing use. Do not introduce a second grading standard.

/** 97+ A+ · 90–96 A · 88–89 A− · 82–87 B+ · 75–81 B · 68–74 C+ · 60–67 C · 50–59 D+ · 40–49 D · <40 F. */
export function gradeLetter(v: number): string {
  if (v >= 97) return "A+";
  if (v >= 90) return "A";
  if (v >= 88) return "A−";
  if (v >= 82) return "B+";
  if (v >= 75) return "B";
  if (v >= 68) return "C+";
  if (v >= 60) return "C";
  if (v >= 50) return "D+";
  if (v >= 40) return "D";
  return "F";
}

export type GradeBand = "a" | "bc" | "df";

/** A-range → strong · B/C-range → caution · D/F → critical. */
export function gradeBand(letter: string): GradeBand {
  if (letter.startsWith("A")) return "a";
  if (letter.startsWith("F") || letter.startsWith("D")) return "df";
  return "bc";
}

/** One-line deploy verdict keyed to the composite band (mirrors the S2 gradeLine copy). */
export function verdictLine(composite: number): string {
  if (composite >= 88) return "production-ready · deploy with monitoring";
  if (composite >= 75) return "deploy with guardrails · minor fixes";
  if (composite >= 60) return "deploy with fixes · treatment recommended";
  if (composite >= 40) return "not client-ready · treatment required";
  return "do not deploy · full rebuild required";
}

export const round1 = (v: number): number => Math.round(v * 10) / 10;
