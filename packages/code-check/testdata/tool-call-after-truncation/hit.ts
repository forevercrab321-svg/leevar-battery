// Shape of catalog case 04 (rewritten, minimal): the length stop is noticed and
// logged, and the tool calls of the cut-off turn are dispatched anyway.
export async function runTurn(llm, tools) {
  const res = await llm.chat();
  const finishReason = res.choices[0].finish_reason;
  if (finishReason === "length") {
    console.warn("output was cut off");
  }
  const toolCalls = res.choices[0].message.tool_calls ?? [];
  return Promise.all(toolCalls.map((call) => executeTool(tools, call)));
}
