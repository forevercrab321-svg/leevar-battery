export function screen(reply, toolCalls) {
  if (reply.finishReason === "content_filter") return [];
  const blocked = [];
  for (const call of toolCalls) {
    if (!isToolCallParamsAllowed(call)) blocked.push(call);
  }
  return blocked;
}
