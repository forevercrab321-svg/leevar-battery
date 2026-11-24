// The fixed shape: success comes from the HTTP response, whatever the body holds.
export async function httpRequest(url: string, body: unknown) {
  const response = await fetch(url, { method: "POST", body: JSON.stringify(body) });
  const data = await response.json();
  return { success: response.ok, status: response.status, output: data };
}
