export async function loop(messages, toolCalls) {
  const { finish_reason } = await collectToolResults(messages);
  for (const call of toolCalls) {
    await executeTool(call);
  }
  return finish_reason;
}
