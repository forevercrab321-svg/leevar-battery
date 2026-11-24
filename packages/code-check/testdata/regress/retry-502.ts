export async function runRemote(url: string, body: unknown) {
  for (let attempt = 0; attempt <= 2; attempt++) {
    try {
      const resp = await fetch(`${url}/api/execute`, { method: "POST", body: JSON.stringify(body) });
      if ((resp.status === 429 || resp.status === 502) && attempt < 2) continue;
      return resp;
    } catch (err) {
      throw err;
    }
  }
}
