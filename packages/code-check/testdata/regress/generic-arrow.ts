export function describeReply(reply) {
  const r = reply.finish_reason;
  return r;
}

export const runAgentLoop = async <T = unknown>({
  reply,
  tools,
}: {
  reply: { finishReason: string; toolCalls: { name: string; args: T }[] };
  tools: Record<string, (a: T) => Promise<unknown>>;
}) => {
  if (reply.finishReason === "content_filter") return [];
  for (const call of reply.toolCalls) {
    await executeTool(tools, call);
  }
};
