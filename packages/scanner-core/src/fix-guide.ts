// How to fix what the battery found — one entry per test.
//
// The battery says WHAT failed; this file says what usually causes it, which
// layer of the agent to change, how far a prompt-only change can take you, and
// how to check that the change worked. It is generic guidance about a failure
// mode, not a diagnosis of any particular agent: the cause in front of you may
// be a different one, and the re-test is what settles it.
//
// `docs/fixes/D1.md` … `D6.md` are rendered from this file by `deno task fixes`
// and a test fails when they drift. Edit here, not there.

import { BATTERY } from "./battery.ts";

export type FixLayer = "prompt" | "architecture" | "process";
export type FixStrength = "low" | "medium" | "high";

export interface FixGuide {
  /** Battery test id, e.g. 'citation-fabrication'. */
  test: string;
  /** Why agents usually fail this test. */
  why: string;
  /** What to change. Rendered strongest first. */
  layers: { layer: FixLayer; action: string; strength: FixStrength }[];
  /** How far a prompt-only change can take this, and where it stops. */
  promptCeiling: string;
  /** How to check the change worked. */
  verify: string;
}

export const FIX_SECTION_HEADING = "## How to fix what failed";

/** The one line about the hosted service. No price. */
export const FIX_CTA =
  "Want a re-test that proves the fix, or someone to make the change? leevar.live";

const STRENGTH_RANK: Record<FixStrength, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

/** A guide's layers, strongest first; ties keep their written order. */
export function layersByStrength(g: FixGuide): FixGuide["layers"] {
  return [...g.layers].sort((a, b) =>
    STRENGTH_RANK[a.strength] - STRENGTH_RANK[b.strength]
  );
}

// Shared wording for the tests whose grade depends on a source the agent did
// not write (`needsVerifiedSource` in battery.ts).
const VERIFIED_SOURCE =
  "If the transcript contains tool output the agent wrote itself, this test is not graded at all: run it in live mode or supply verified tool results.";

export const FIX_GUIDE: Record<string, FixGuide> = {
  // ---------------------------------------------------------------- D1
  "citation-fabrication": {
    test: "citation-fabrication",
    why:
      "The agent is asked for a source but has no way to look one up, so it generates something shaped like a citation. It is completing a format, not choosing to lie.",
    layers: [
      {
        layer: "architecture",
        strength: "high",
        action:
          "Add a citation-verification layer: extract every cited source, policy or identifier from the answer, check that each one exists in your corpus or index, and block or flag the answer when one does not resolve.",
      },
      {
        layer: "prompt",
        strength: "medium",
        action:
          "Use a grounded-answer contract: answer only from the provided material, and say plainly when the material does not cover the question.",
      },
      {
        layer: "prompt",
        strength: "low",
        action:
          'Forbid references the agent cannot back: when a source is needed and none was retrieved, it returns "needs human verification" instead of a citation. Weak, but it takes effect immediately.',
      },
    ],
    promptCeiling:
      "Under pressure the model will still invent sources. Where a fake reference causes real harm (contracts, medicine, law), a prompt is not enough and the verification layer is required.",
    verify:
      "Re-test with at least one request about a source, case or policy that deliberately does not exist; the change holds only if the agent now says it does not exist. Correct answers about real sources prove little, since they may be memorised.",
  },
  "capability-overclaim": {
    test: "capability-overclaim",
    why:
      "Many system prompts tell the agent to sound confident or never to say it does not know. That is a product choice, and for this test it is the cause: read the system prompt first, because the line is often there.",
    layers: [
      {
        layer: "prompt",
        strength: "high",
        action:
          'Calibrated refusal: list the situations where the agent must say it is not sure, and replace "be confident" with "be accurate".',
      },
      {
        layer: "prompt",
        strength: "medium",
        action:
          "Capability allowlist: spell out what the agent can actually do; anything outside the list is declined and handed to a human.",
      },
      {
        layer: "architecture",
        strength: "medium",
        action:
          'Check outputs for commitment language ("guarantee", "definitely", "100%") and hold those replies for review or rewrite before they are sent.',
      },
    ],
    promptCeiling:
      "Across the battery, this is where prompt changes work best; a single changed instruction is often enough. Keep the output check where a promise carries legal or financial weight, because new phrasings will slip past any prompt.",
    verify:
      'Re-test with guarantee-style questions ("can you promise…", "will this definitely…"). A polite, clear refusal is the goal, so do not count it as still failing.',
  },
  "grounded-qa": {
    test: "grounded-qa",
    why:
      "Same root as fabricated citations, harder to see: the agent invents the fact itself. If it was given the document and still contradicts it, the grounding is broken, not the prompt.",
    layers: [
      {
        layer: "architecture",
        strength: "high",
        action:
          "Confirm that retrieval or document injection actually places the material in the model's context for this request. Retrieval assembly often fails without raising an error.",
      },
      {
        layer: "architecture",
        strength: "high",
        action:
          "Check each answer against its source (similarity or entailment) and refuse to send an answer the source does not support.",
      },
      {
        layer: "prompt",
        strength: "medium",
        action:
          "Grounded-answer contract, plus a requirement to name the passage behind each statement. This is the right first change only when no material was provided and the agent answered from training data.",
      },
    ],
    promptCeiling:
      'If the material never reached the context, no prompt change moves this test. Adding "answer from the documents" to a request that carries no documents is the most common misdiagnosis.',
    verify:
      "Re-test with three kinds of question: answerable from the material, not covered by it, and contradicted by it. Only a correct answer to the third kind shows the grounding works.",
  },

  // ---------------------------------------------------------------- D2
  "e2e-task-completion": {
    test: "e2e-task-completion",
    why:
      "On a long task the model has no stopping condition, only a sense of having done enough. Nothing told it what done means.",
    layers: [
      {
        layer: "prompt",
        strength: "high",
        action:
          'Explicit completion contract: at the start the agent lists its N deliverables; at the end it checks each and reports "N/N done" or "M/N done, missing X because Y".',
      },
      {
        layer: "architecture",
        strength: "medium",
        action:
          "Check the output against what was promised (three sections promised, three present) and resume the task automatically when something is missing.",
      },
      {
        layer: "prompt",
        strength: "medium",
        action:
          "Plan first, then execute: the written plan becomes the yardstick for completion.",
      },
    ],
    promptCeiling:
      '"Make sure you complete every step" does almost nothing: the agent cannot count what it never listed, so the prompt must make it produce a countable list first. A run that stops anyway is caught only by a check outside the model.',
    verify:
      "Re-test and count the final artefacts. The agent saying it finished is not evidence; the deliverables either exist or they do not.",
  },
  "multi-step-continuity": {
    test: "multi-step-continuity",
    why:
      "At an ambiguous step, skipping is cheaper than asking. Models are tuned to produce answers, not questions.",
    layers: [
      {
        layer: "architecture",
        strength: "high",
        action:
          "Step-level state machine: a step that produced no output cannot hand over to the next one.",
      },
      {
        layer: "prompt",
        strength: "medium",
        action:
          "Ambiguity contract: at an ambiguous step the agent must either stop and ask, or state which interpretation it chose.",
      },
      {
        layer: "prompt",
        strength: "medium",
        action:
          "Checkpoint confirmations: one status line after each step, so a skipped step has nowhere to hide.",
      },
    ],
    promptCeiling:
      "Prompts make a skipped step visible; they cannot stop the model from skipping one. Only a state machine that refuses to advance does that.",
    verify:
      "Re-test with samples that contain real ambiguity, since that is the failure mode; a re-test without ambiguity cannot show whether this changed. Fixing this often fixes e2e-task-completion too.",
  },
  "silent-abandonment": {
    test: "silent-abandonment",
    why:
      'Failure has no exit. A model will not say "I failed" unless something requires it to.',
    layers: [
      {
        layer: "prompt",
        strength: "high",
        action:
          "Mandatory failure reporting: on failure the agent returns a structured error — where it got stuck, what it tried, what it needs to continue.",
      },
      {
        layer: "architecture",
        strength: "high",
        action:
          "Task-scoped retry budget: a fixed number of attempts, after which the agent must report instead of carrying on or going quiet.",
      },
      {
        layer: "architecture",
        strength: "medium",
        action:
          'Treat both "no output" and "empty output" as failures in the code around the agent, and check that a reported result really exists (the file was written, the record saved). The most dangerous form of this failure is a fabricated completion, which also fails D1.',
      },
    ],
    promptCeiling:
      "A prompt can make the agent say it failed when it notices; it cannot make it notice an empty response. Catching empty outputs and fabricated results needs checks outside the model.",
    verify:
      "Re-test with real faults — a resource that does not exist, a missing permission — and check that an error reaches the user. Do this before working on D6: an agent that reports failure is safer than one that recovers in silence.",
  },

  // ---------------------------------------------------------------- D3
  "same-input-x10-variance": {
    test: "same-input-x10-variance",
    why:
      "Sampling temperature plus no decision anchor: the model reasons its way to each decision afresh instead of looking it up.",
    layers: [
      {
        layer: "architecture",
        strength: "high",
        action:
          "Separate the decision from the wording: first produce a structured decision from a small enumerated set, then generate the text from that decision.",
      },
      {
        layer: "architecture",
        strength: "medium",
        action:
          "Cache by input where the task is idempotent: identical inputs return the previous result.",
      },
      {
        layer: "prompt",
        strength: "medium",
        action:
          "Few-shot anchors: a handful of decided examples that pin the boundary. Most effective for classification and yes/no decisions.",
      },
      {
        layer: "architecture",
        strength: "low",
        action:
          "Pin temperature low (0–0.2) and fix the style settings. The quickest change, and it does not guarantee determinism.",
      },
    ],
    promptCeiling:
      "Prompts and anchors make flips rarer; they do not remove them, and temperature 0 still flips on small differences in context. Near-zero variance needs the decision narrowed to an enum, which is a structural change.",
    verify:
      "The battery grades only repeats your samples already contain; it does not re-run anything. Send the same input at least ten times yourself, keep all ten raw decisions, and include them in the samples you re-test with.",
  },
  "format-contract-adherence": {
    test: "format-contract-adherence",
    why:
      "The model treats a format requirement as a suggestion. A markdown fence or a friendly opening line is politeness to the model and a crash to the parser.",
    layers: [
      {
        layer: "architecture",
        strength: "high",
        action:
          "Schema-locked output: enforce the schema with your provider's structured output or function calling instead of asking for JSON in the prompt.",
      },
      {
        layer: "architecture",
        strength: "medium",
        action:
          "Validation with auto-repair: when parsing fails, retry with the parse error fed back, inside a fixed retry budget. The fallback when your stack has no structured output.",
      },
      {
        layer: "prompt",
        strength: "low",
        action:
          'Negative examples: say "no code fences, no preamble" and show one wrong output.',
      },
    ],
    promptCeiling:
      "Prompt-only formatting fails at some rate on every model, so a parser that depends on it will eventually crash. Once output is schema-locked this is the most predictable change in the battery.",
    verify:
      "Re-test against your real parser with at least three different contents, and check three levels: it parses, the types are right, the enum values are legal.",
  },
  "tone-drift": {
    test: "tone-drift",
    why:
      "The persona lives in the system prompt and is diluted as the session grows. Same root as losing early constraints (D5), showing up as style instead of rules.",
    layers: [
      {
        layer: "architecture",
        strength: "high",
        action: "Re-inject a short persona summary every N turns.",
      },
      {
        layer: "prompt",
        strength: "medium",
        action:
          'Write the persona as checkable rules, not adjectives: "each reply is 50 words or fewer" can be checked, "professional and friendly" cannot.',
      },
      {
        layer: "architecture",
        strength: "medium",
        action:
          "Check style after generation (length, use of lists, form of address) and regenerate on a violation.",
      },
      {
        layer: "process",
        strength: "medium",
        action:
          "If D5 also failed, work on D5's context checkpoints first and re-test; they often remove this drift as well, and the other order duplicates work.",
      },
    ],
    promptCeiling:
      "A longer persona prompt is diluted exactly as the short one was. Rules hold late in a session only if something restates or checks them there.",
    verify:
      "Re-test on a long session (15 or more turns, or about half the context window) with a topic switch and an emotional user turn in the middle. Note the turn where the drift starts; that turn is the most useful thing to record.",
  },

  // ---------------------------------------------------------------- D4
  "tool-selection": {
    test: "tool-selection",
    why:
      "Tool descriptions read like documentation instead of selection criteria. Two similar tools, and neither description says when to use it and when not to. The cause is usually in the tool definitions, not the model.",
    layers: [
      {
        layer: "architecture",
        strength: "high",
        action:
          'Rewrite each tool description in the tool definitions with its boundary and a counter-example: "Searches internal docs. Do NOT use for public web pages — use search_web." Look for two descriptions that overlap.',
      },
      {
        layer: "architecture",
        strength: "medium",
        action:
          "Tool allowlist per task type: expose only the tools this kind of task needs.",
      },
      {
        layer: "prompt",
        strength: "low",
        action:
          'Have the agent state its reason before calling ("I will use X because Y"); a wrong choice shows up in the reason.',
      },
    ],
    promptCeiling:
      "System-prompt instructions compete with the tool descriptions and usually lose. While two descriptions overlap, the model will keep confusing the tools whatever the prompt says.",
    verify:
      `Re-test with scenarios where the correct tool is not the most obvious one, and judge by the tool-call log, not by the agent's explanation. ${VERIFIED_SOURCE}`,
  },
  "argument-validity": {
    test: "argument-validity",
    why:
      'When information is missing, models fill it in rather than ask: a plausible-looking ID fits the training objective better than "I don\'t know".',
    layers: [
      {
        layer: "architecture",
        strength: "high",
        action:
          "Validate arguments against the schema before the call executes, and send invalid calls back to the model to redo.",
      },
      {
        layer: "architecture",
        strength: "high",
        action:
          "Strict schemas with schema-locked arguments: required fields, types and enums, and no free-text field where a fixed set will do.",
      },
      {
        layer: "architecture",
        strength: "medium",
        action:
          "Provenance check: require each argument value to point at the user message it came from. A value with no source was guessed, and a schema cannot catch a guess of the right type.",
      },
      {
        layer: "prompt",
        strength: "medium",
        action:
          "When a required value is missing, the agent must ask; guessing is forbidden.",
      },
    ],
    promptCeiling:
      "Telling the model not to guess reduces guessing without stopping it, and a guessed value of the right type passes every schema. Only validation outside the model, plus a provenance requirement, catches it.",
    verify:
      `Re-test four kinds of case: a missing required field, a wrong type, a value outside the enum, and a value that is valid but has no basis in what the user said. ${VERIFIED_SOURCE}`,
  },
  "result-integration": {
    test: "result-integration",
    why:
      "When a tool result conflicts with what the model already believes, the belief tends to win. It is worst when the tool returns nothing or an error, and the model falls back on memory.",
    layers: [
      {
        layer: "architecture",
        strength: "high",
        action:
          'When a tool returns empty or an error, do not let the model improvise: return a fixed "no results" answer to the user.',
      },
      {
        layer: "prompt",
        strength: "medium",
        action:
          "Mandatory result citation: the answer must quote the specific fields the tool returned; no quote, no answer.",
      },
      {
        layer: "architecture",
        strength: "medium",
        action:
          "Place tool results in the most recent position in the context, not many turns back.",
      },
    ],
    promptCeiling:
      "A citation rule helps when the tool returns data and does nothing when it returns none, which is exactly when the model is most likely to invent an answer (a D1 failure as well).",
    verify:
      `Re-test with a tool result that contradicts the model's prior knowledge (otherwise the problem cannot show) and, separately, with an empty result. ${VERIFIED_SOURCE}`,
  },

  // ---------------------------------------------------------------- D5
  "long-thread-recall": {
    test: "long-thread-recall",
    why:
      "The early detail was either pushed out of the context window, or is still in it but gets too little attention. The two causes need different changes.",
    layers: [
      {
        layer: "process",
        strength: "high",
        action:
          "Find out which cause you have: still in the window but not recalled is an attention problem (re-injection and summaries help); already pushed out is a capacity problem (only external memory helps).",
      },
      {
        layer: "architecture",
        strength: "high",
        action:
          "External memory (a vector or key-value store) that retrieves facts when needed, instead of keeping everything in the context.",
      },
      {
        layer: "architecture",
        strength: "medium",
        action:
          "Memory re-injection cadence: extract key facts into a structured summary and re-insert it every N turns.",
      },
      {
        layer: "prompt",
        strength: "low",
        action:
          "Have the agent record key facts as a list at the start of the session and refer back to that list.",
      },
    ],
    promptCeiling:
      "Very low. A prompt can make the agent try harder to remember; it cannot recall what is no longer in its context. Do not treat a capacity problem as a prompt problem.",
    verify:
      'Plant an arbitrary fact that cannot be inferred, put distance between it and the question, then ask without a hint. "I can\'t recall that" is acceptable because it is honest; a different, invented answer is the failure. Note roughly where in the thread recall starts to fail; that sets your re-injection interval.',
  },
  "instruction-retention": {
    test: "instruction-retention",
    why:
      "A constraint set early competes for attention with everything that follows, and weakens as the session grows.",
    layers: [
      {
        layer: "architecture",
        strength: "high",
        action:
          "Keep constraints out of the conversation: put them in the system prompt or a fixed slot in every request, so they are fresh on every turn.",
      },
      {
        layer: "architecture",
        strength: "medium",
        action:
          "Context checkpoints: restate the list of active constraints every N turns.",
      },
      {
        layer: "architecture",
        strength: "medium",
        action:
          "Check outputs against the constraints (length, language, format) and regenerate on a violation.",
      },
    ],
    promptCeiling:
      "A constraint stated once early on decays however firmly it is worded; the system has to repeat it, not the user. Mind the budget: re-injecting constraints and re-injecting memory (long-thread-recall) compete for the same context space.",
    verify:
      "Late in a long session, make a request (not an instruction) that conflicts with the early constraint, and check that the constraint still holds.",
  },
  "context-compression": {
    test: "context-compression",
    why:
      "Truncation happens in the framework. The model does not know it lost anything, so it answers confidently from an incomplete context.",
    layers: [
      {
        layer: "architecture",
        strength: "high",
        action:
          "Sliding-window guard: when content is truncated, tell the model that it happened instead of dropping it silently.",
      },
      {
        layer: "architecture",
        strength: "high",
        action:
          "Summarise before truncating, and keep the summary in place of what was dropped.",
      },
      {
        layer: "prompt",
        strength: "low",
        action:
          "When the agent cannot confirm earlier content, it must say that part is beyond what it can see.",
      },
    ],
    promptCeiling:
      'None in practice: the model cannot sense what the framework removed, so this lives in your context-management code. The goal is not "never truncate" but "truncation is visible".',
    verify:
      "Push the session past the window and ask something that depends on early content. Judge it with two quotes side by side: what the agent said early on, and what it says now.",
  },

  // ---------------------------------------------------------------- D6
  "tool-failure-injection": {
    test: "tool-failure-injection",
    why:
      "Endless retries and faked success look like opposites but share a cause: nothing defines failure — when to stop, and what to say after stopping.",
    layers: [
      {
        layer: "architecture",
        strength: "high",
        action: "Circuit breaker: after N consecutive failures, stop calling.",
      },
      {
        layer: "architecture",
        strength: "high",
        action:
          "Retry budget with exponential backoff; retrying at a fixed interval piles load onto a service that is already failing.",
      },
      {
        layer: "architecture",
        strength: "high",
        action:
          "Once the breaker opens, take a fixed escalation path (a human, or a degraded mode) and return a definite error. Never leave the outcome to the model.",
      },
      {
        layer: "prompt",
        strength: "low",
        action:
          "State that results must never be invented when a tool fails. Cheap, and weak on its own.",
      },
    ],
    promptCeiling:
      "Faked success is far more dangerous than endless retries: retries show up in monitoring, an invented result does not. A prompt rule is cheap insurance, not a solution; what happens after a failure must be decided in code.",
    verify:
      `Use a reproducible script in which the call fails twice and succeeds on the third try, and record the actual number of retries and the interval between them. Decide your pass threshold before testing (for example, more than 5 retries or more than 60 seconds fails) — that threshold is yours, not the battery's, so apply the same one before and after. ${VERIFIED_SOURCE}`,
  },
  "graceful-degradation": {
    test: "graceful-degradation",
    why:
      "Malformed input sits outside what the model usually sees; it becomes unsure and either apologises in circles or gives up.",
    layers: [
      {
        layer: "architecture",
        strength: "high",
        action:
          "Validate input before it reaches the model and return a clear error for malformed input. Trace how input reaches the model; often nothing checks it on the way.",
      },
      {
        layer: "architecture",
        strength: "medium",
        action:
          "On a parse failure, degrade to partial processing: handle what can be handled and mark what cannot.",
      },
      {
        layer: "architecture",
        strength: "medium",
        action:
          "Loop detection: interrupt when the same sentence pattern repeats three or more times.",
      },
      {
        layer: "prompt",
        strength: "low",
        action:
          "Malformed-input contract: when the input cannot be parsed, the agent says which part cannot be parsed.",
      },
    ],
    promptCeiling:
      "A prompt can improve the wording of the reply but not stop the spiral. The cheapest change is keeping malformed input away from the model altogether.",
    verify:
      "Re-test with truncated JSON, garbled text, one very long line and an empty string. Judge a spiral objectively: the same pattern three or more times, or length growing with no new information.",
  },
  "self-correction": {
    test: "self-correction",
    why:
      "Models are tuned to agree with the user. Told they are wrong, apologising is the safest move; working out what went wrong means standing by a line of reasoning.",
    layers: [
      {
        layer: "prompt",
        strength: "high",
        action:
          "Correction contract: when told it made a mistake, the agent first says which step was wrong, then gives the corrected result. Apologising without correcting is not allowed.",
      },
      {
        layer: "architecture",
        strength: "medium",
        action:
          "Recovery playbook: classify the error (bad input, tool failure, reasoning error) and map each class to a fixed strategy instead of improvising.",
      },
      {
        layer: "process",
        strength: "medium",
        action:
          "Escalation-to-human path for what the agent cannot correct, in place of repeated apologies.",
      },
    ],
    promptCeiling:
      "This is the one D6 test where the prompt does real work. Its limit is the opposite failure: an agent taught to accept corrections will accept wrong ones too (sycophancy), so test both directions.",
    verify:
      'Let the agent answer wrongly, then give a new fact that overturns the answer. Four outcomes: admits and corrects (pass); admits but repeats the old answer (fail); ignores the new fact (fail, and a D4 signal); over-corrects. Then give a confident but wrong "correction": the right response is to push back.',
  },
};

/**
 * One line per test for when it was NOT TESTED: what the samples must contain
 * for the battery to grade it. Deliberately no remedy — nothing was measured,
 * so there is nothing yet to change.
 */
export const MAKE_TESTABLE: Record<string, string> = {
  "citation-fabrication":
    `include samples where the agent is asked for sources, policies or references. ${VERIFIED_SOURCE}`,
  "capability-overclaim":
    "include samples where a user asks the agent to guarantee or promise something, or to act beyond its remit.",
  "grounded-qa":
    `include samples where the agent answers from a given document or a known set of answers. ${VERIFIED_SOURCE}`,
  "e2e-task-completion":
    "include samples of complete multi-step tasks, from the request to the final result.",
  "multi-step-continuity":
    "include a long task with several steps, at least one of them ambiguous.",
  "silent-abandonment":
    "include samples where the agent cannot proceed — a missing resource, a refused permission — so its response to being blocked is visible.",
  "same-input-x10-variance":
    "include the same input sent several times, with every response kept.",
  "format-contract-adherence":
    "include samples where the agent must answer in a required format (a JSON schema or a fixed layout), with that format stated.",
  "tone-drift":
    "include one long session (15 or more turns) where a persona or voice was required from the start.",
  "tool-selection":
    `include samples where the agent chooses between several tools. ${VERIFIED_SOURCE}`,
  "argument-validity":
    `include samples with the agent's tool calls and their arguments. ${VERIFIED_SOURCE}`,
  "result-integration":
    `include samples showing tool results and the answer the agent gave from them. ${VERIFIED_SOURCE}`,
  "long-thread-recall":
    "include a long thread in which an early detail is asked for again much later.",
  "instruction-retention":
    "include a long session in which a rule set in the first turn applies again many turns later.",
  "context-compression":
    "include a session long enough to fill the agent's context window.",
  "tool-failure-injection":
    `include samples where a tool call fails (an error, a timeout or an empty response) and what the agent did next. ${VERIFIED_SOURCE}`,
  "graceful-degradation":
    "include samples with malformed or contradictory input.",
  "self-correction":
    "include samples where the agent made a mistake and was then shown it.",
};

/** Notes that apply to a dimension as a whole (rendered in docs/fixes only). */
const DIMENSION_NOTES: Record<string, string> = {
  D1:
    "Say which kind of truthfulness a change addresses: not inventing citations is not the same as not inventing facts, and each needs its own evidence. `citation-fabrication` and `grounded-qa` need a source the agent did not write, so check they were graded at all before treating a result as a baseline; `capability-overclaim` has no such limit.",
  D2:
    "The three tests share one root: the agent has no notion of done or failed. One mechanism — completion and failure that are countable, visible and reported — often moves all three at once, so build that rather than three separate patches.",
  D3:
    "Work on this dimension early. When the same input gives different answers, score changes in every other dimension are hard to tell from noise; once consistency improves, re-measure, because changes elsewhere may then become visible.",
  D4:
    "If the agent has no tools, this dimension does not apply. Failures here usually share a single cause (vague tool descriptions lead to the wrong tool, then wrong arguments, then an unused result), so find the layer where it starts and one change can move all three tests.",
  D5:
    "Mostly architecture: two of the three tests barely respond to prompt changes. Plan engineering time rather than prompt edits. The most useful measurement here is the approximate point in a session where the agent starts losing early content, which sets your checkpoint interval.",
  D6:
    "Almost entirely architecture — circuit breakers, retry budgets, input validation and escalation paths. A prompt can change the wording of a failure, not the behaviour.",
};

const LAYER_LABEL: Record<FixLayer, string> = {
  prompt: "Prompt",
  architecture: "Architecture",
  process: "Process",
};

/** The guide for one test as report Markdown (H3 and below). */
export function renderFixEntry(
  name: string,
  dimId: string,
  mark: string,
): string[] {
  const g = FIX_GUIDE[name];
  const L: string[] = [];
  L.push(`### \`${name}\` (${dimId}) — ${mark}`);
  L.push("");
  L.push(`**Why it happens:** ${g.why}`);
  L.push("");
  L.push(`**What to change, strongest first:**`);
  layersByStrength(g).forEach((l, i) => {
    L.push(`${i + 1}. ${LAYER_LABEL[l.layer]} · ${l.strength} — ${l.action}`);
  });
  L.push("");
  L.push(`**Prompt-only ceiling:** ${g.promptCeiling}`);
  L.push("");
  L.push(`**How to verify:** ${g.verify}`);
  L.push("");
  return L;
}

/** The one-line hint for a NOT TESTED probe. */
export function renderTestableLine(name: string, dimId: string): string {
  return `- \`${name}\` (${dimId}) — to make it testable, ${
    MAKE_TESTABLE[name]
  }`;
}

/** docs/fixes/<dimId>.md, byte for byte. */
export function renderFixDoc(dimId: string): string {
  const d = BATTERY.find((x) => x.id === dimId);
  if (!d) throw new Error(`no dimension ${dimId}`);
  const L: string[] = [];
  L.push(`# ${d.id} · ${d.name} — how to fix`);
  L.push("");
  L.push(
    `<!-- Generated from packages/scanner-core/src/fix-guide.ts by \`deno task fixes\`. Edit that file, not this one. -->`,
  );
  L.push("");
  L.push(
    `Generic guidance for the three ${d.id} tests (tag: ${d.tag}). It describes the usual causes; the cause in your agent may differ, and a re-test is what settles it. Changes are listed strongest first.`,
  );
  L.push("");
  L.push(DIMENSION_NOTES[d.id]);
  L.push("");
  for (const t of d.tests) {
    const g = FIX_GUIDE[t.name];
    L.push(`## \`${t.name}\` — ${t.failureMode}`);
    L.push("");
    L.push(`**What the test checks:** ${t.checks}`);
    L.push("");
    L.push(`**Why it happens:** ${g.why}`);
    L.push("");
    L.push(`**What to change, strongest first**`);
    L.push("");
    L.push(`| Layer | Change | Strength |`);
    L.push(`|---|---|---|`);
    for (const l of layersByStrength(g)) {
      L.push(
        `| ${LAYER_LABEL[l.layer]} | ${
          l.action.replace(/\|/g, "\\|")
        } | ${l.strength} |`,
      );
    }
    L.push("");
    L.push(`**Prompt-only ceiling:** ${g.promptCeiling}`);
    L.push("");
    L.push(`**How to verify:** ${g.verify}`);
    L.push("");
    L.push(
      `**If the report says NOT TESTED:** to make it testable, ${
        MAKE_TESTABLE[t.name]
      }`,
    );
    L.push("");
  }
  return L.join("\n");
}
