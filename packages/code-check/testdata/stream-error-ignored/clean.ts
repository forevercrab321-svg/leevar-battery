// A default branch that throws covers every unknown event type.
export async function readStream(res: Response): Promise<string> {
  const reader = res.body!.getReader();
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return text;
    const evt = JSON.parse(new TextDecoder().decode(value));
    switch (evt.type) {
      case "delta":
        text += evt.text;
        break;
      case "done":
        return text;
      default:
        throw new Error(`unexpected stream event: ${evt.type}`);
    }
  }
}

// Typed SDK streams are not parsed here, so this rule leaves them alone: the
// SDK raises on error events itself.
export async function sdkStream(client) {
  let text = "";
  for await (const event of client.messages.stream({ model: "m", messages: [] })) {
    if (event.type === "content_block_delta") text += event.delta.text;
    else if (event.type === "message_stop") break;
  }
  return text;
}
