export interface StepResult {
  finishReason?: string;
  stopReason: string | undefined;
}

export async function runApprovedTools(info, toolCalls) {
  const summary = {
    stopReason: info.reason === "approval" ? "awaiting-approval" : "done",
  };
  for (const call of toolCalls) {
    await executeTool(call);
  }
  return summary;
}
