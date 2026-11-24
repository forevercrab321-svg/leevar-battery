export async function runNode(props) {
  const {
    toolResponses,
    finish_reason,
    error,
  } = await runToolCall({
    ...props,
  });
  return { toolResponses, finish_reason, error };
}
