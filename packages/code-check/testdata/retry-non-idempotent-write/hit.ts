// A hand-written retry loop around a POST that sends an email.
export async function sendReceipt(to: string, html: string) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fetch(MAIL_API, { method: "POST", body: JSON.stringify({ to, html }) });
    } catch {
      await sleep(2 ** attempt * 1000);
    }
  }
}
