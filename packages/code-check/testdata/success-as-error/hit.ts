// Shape of catalog case 10 (rewritten, minimal): a 200 response whose body has
// "status" and "data" keys is treated as a wrapper, and its success is read
// from the body instead of the HTTP status.
export async function httpRequest(url: string, body: unknown) {
  const response = await fetch(url, { method: "POST", body: JSON.stringify(body) });
  const data = await response.json();
  if ("status" in data && "data" in data) {
    return { success: data.success, status: data.status, output: data.data };
  }
  return { success: response.ok, status: response.status, output: data };
}
