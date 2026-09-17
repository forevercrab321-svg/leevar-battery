// One concurrency pool, shared by every phase that fans out judge calls.
//
// WHY THIS FILE EXISTS (2026-08-03): `pooled` used to be a private function in
// pipeline.ts, so the 18-test battery ran 9-way while Job-Fit — which lives in
// jobfit.ts and cannot import pipeline.ts without a cycle — ran a bare serial
// `for` loop. The asymmetry was invisible in the code and expensive in
// production: a scan is battery-then-JobFit, so a 6-requirement job cost
// 2 pooled rounds + **6 serial rounds**, and at CALL_TIMEOUT_MS = 75s (plus one
// retry) that is where the wall-clock went.
//
// Measured on the 2026-08-02 self-scan: every scan carrying a job spec died at
// 24m29s / 24m29s / 24m14s against `sweepStaleRunning`'s 20-minute line, while
// the SAME transcripts with the job spec removed delivered in 5m15s and ~8min.
// The self-scan write-up attributed this to "24 serial probes" — half right:
// the 18 were already pooled, only the 6 were serial. That mattered, because it
// pointed the fix at the sweep clock (a config decision) instead of here.
//
// Keep both phases importing from this file. A second copy of this function is
// how the asymmetry comes back.

/** Judge-call fan-out width. 9 ≈ 2 round-trips for the 18-test battery, and
 * one round for a typical job spec. Deliberately the same number in both
 * phases: they run sequentially, so this is also the peak concurrent load a
 * customer's endpoint sees from one scan. */
export const JUDGE_POOL = 9;

/** Run items through a fixed-size concurrency pool, preserving input order.
 *
 * Results are indexed by input position, so callers may rely on order. Progress
 * callbacks fired from inside `fn` are NOT ordered — they interleave by
 * completion, which is why nothing downstream may parse them for sequence. */
export async function pooled<T, R>(
  items: T[],
  size: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from(
    { length: Math.min(size, items.length) },
    async () => {
      while (i < items.length) {
        const idx = i++;
        results[idx] = await fn(items[idx]);
      }
    },
  );
  await Promise.all(workers);
  return results;
}
