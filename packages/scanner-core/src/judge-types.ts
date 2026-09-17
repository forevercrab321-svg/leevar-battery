// The provider-neutral judge contract.
//
// Lives here rather than beside the HTTP adapters because gradeBattery needs
// the TYPE and nothing else: its body never touches a provider, only
// `deps.judge.score(ctx)`. Keeping the interface in the core and the adapters
// wherever they happen to live is what makes "bring your own model" a
// configuration question instead of a fork.

import type { TestVerdict } from "./types.ts";
export type { JudgeContext } from "./prompts/types.ts";
import type { JudgeContext } from "./prompts/types.ts";

export interface Judge {
  score(ctx: JudgeContext): Promise<TestVerdict>;
  /** LLM calls consumed so far (0 for a scripted judge). */
  calls(): number;
  readonly mode: string;
}
