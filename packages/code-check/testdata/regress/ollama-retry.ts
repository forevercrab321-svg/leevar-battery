export async function chat(body) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fetch(`${OLLAMA}/api/chat`, { method: "POST", body: JSON.stringify(body) });
    } catch {
      await sleep(500);
    }
  }
}
