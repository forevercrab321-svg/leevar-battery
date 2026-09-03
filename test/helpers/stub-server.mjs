// A scripted stand-in for api-scan. Nothing in the test suite touches the real
// API: every request lands here, is recorded, and is answered from a script.
import http from "node:http";

/**
 * @param {object} script
 *   submit  — answer for the create-scan POST: {status, body} or (req) => {status, body}
 *   polls   — answers for successive polls; the last one repeats
 *   handler — full override: (record, {isPoll, pollIndex}) => {status, body}
 */
export async function startStub(script = {}) {
  const requests = [];
  let pollIndex = 0;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body = null;
      try { body = JSON.parse(raw); } catch { /* keep raw */ }
      const record = { method: req.method, url: req.url, headers: req.headers, body, raw };
      requests.push(record);
      const isPoll = Boolean(body && typeof body.scan_id === "string");
      let answer;
      if (typeof script.handler === "function") {
        answer = script.handler(record, { isPoll, pollIndex });
        if (isPoll) pollIndex++;
      } else if (isPoll) {
        const polls = script.polls ?? [{ status: 200, body: { scan_id: body.scan_id, status: "delivered" } }];
        answer = polls[Math.min(pollIndex, polls.length - 1)];
        pollIndex++;
      } else {
        answer = script.submit ?? {
          status: 202,
          body: {
            scan_id: "SCN-2026-0001",
            status: "queued",
            mode: body?.mode ?? "transcript",
            tier: "scan",
            free_scans_remaining_this_month: 4,
            message: "Free scan queued (4 left this month).",
          },
        };
      }
      if (typeof answer === "function") answer = answer(record);
      const status = answer.status ?? 200;
      const payload = answer.raw !== undefined ? answer.raw : JSON.stringify(answer.body ?? {});
      res.writeHead(status, { "content-type": answer.contentType ?? "application/json" });
      res.end(payload);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    port,
    url: `http://127.0.0.1:${port}/functions/v1/api-scan`,
    requests,
    submits: () => requests.filter((r) => !(r.body && typeof r.body.scan_id === "string")),
    polls: () => requests.filter((r) => r.body && typeof r.body.scan_id === "string"),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
