export async function serveToolCalls(request) {
  for (const call of request.toolCalls) {
    await executeTool(call);
  }
  const res = await finish();
  if (res.finish_reason === "stop") return res;
  return null;
}
