// The same shape over server-sent events, with a switch that has no error case.
export async function readStream(res: Response): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return text;
    for (const line of decoder.decode(value).split("\n")) {
      if (!line.startsWith("data: ")) continue;
      const evt = JSON.parse(line.slice(6));
      switch (evt.type) {
        case "delta":
          text += evt.text;
          break;
        case "done":
          return text;
      }
    }
  }
}
