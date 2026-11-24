// An allow-list on the stop reason also guards: only a "tool_calls" stop runs tools.
export async function runTurn(llm, tools) {
  const res = await llm.chat();
  const reason = res.choices[0].finish_reason;
  if (reason !== "tool_calls") return finish(res);
  for (const call of res.choices[0].message.tool_calls) {
    await executeTool(tools, call);
  }
}

// Code that never reads a stop reason is out of this rule's scope (a known gap).
export function listToolNames(message) {
  return message.tool_calls.map((call) => call.function.name);
}
