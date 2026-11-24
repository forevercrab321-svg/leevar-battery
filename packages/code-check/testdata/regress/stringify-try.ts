export async function callAndLog(client, name, args) {
  try {
    const result = await client.callTool(name, args);
    log(JSON.stringify(result));
    return { isError: false, result };
  } catch {
    return { isError: true, text: "Tool call error" };
  }
}
