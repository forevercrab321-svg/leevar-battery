export function createLoop(agent) {
  const route = {
    execute: async ({ inputData }) => {
      const result = await agent.generate(inputData);
      if (!result.object) throw new Error(String(result.finishReason));
      return result.object;
    },
  };
  const runStep = {
    execute: async ({
      inputData,
    }) => {
      for (const call of inputData.toolCalls) {
        await executeTool(call);
      }
    },
  };
  return [route, runStep];
}
