// Retrying a model call or a read is not what this rule is about.
export async function askModel(client, prompt: string) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await client.chat.completions.create({ model: "m", messages: [{ role: "user", content: prompt }] });
    } catch {
      await sleep(1000);
    }
  }
}

export async function getOrder(id: string) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fetch(`${API}/orders/${id}`);
    } catch {
      await sleep(1000);
    }
  }
}
