export async function refreshToken(refresh: string) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fetch(`${AUTH}/oauth/token`, { method: "POST", body: refresh });
    } catch {
      await sleep(500);
    }
  }
}
