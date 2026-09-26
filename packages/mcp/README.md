# leevar-mcp

The LEEVAR reliability battery as an MCP server. Ask Claude, Cursor or any MCP
client to grade an AI agent's conversations on 18 reliability tests, without
leaving the editor.

It does not grade anything itself and it never fills a gap with a guess. A
dimension your samples cannot evidence comes back `NOT TESTED`, and below 13 of
18 evidenced tests no grade is issued at all — the tool says so instead of
printing a letter.

## Tools

| Tool | What it does |
|---|---|
| `leevar_scan_transcript` | Sends 1–8 real conversation samples to the hosted battery. Returns a scan id. Free: 5 scans a month per email, no account. |
| `leevar_scan_status` | Reads the result: status, grade (only when one was issued), coverage, and the written report. |
| `leevar_battery` | Lists the 18 tests — what each checks and the failure it catches — so you can pick samples that exercise them. |

## Install

The npm package is not published yet. Until it is, run the server from a clone
(Node 18 or later):

```bash
git clone https://github.com/forevercrab321-svg/leevar-battery
cd leevar-battery/packages/mcp && npm install
```

Claude Desktop (`claude_desktop_config.json`) or Cursor (`.cursor/mcp.json`),
with the absolute path to your clone:

```json
{
  "mcpServers": {
    "leevar": {
      "command": "node",
      "args": ["/absolute/path/to/leevar-battery/packages/mcp/index.mjs"]
    }
  }
}
```

Claude Code:

```bash
claude mcp add leevar -- node /absolute/path/to/leevar-battery/packages/mcp/index.mjs
```

Then ask, for example: *"List the LEEVAR battery, pick three of my support
bot's conversations that cover it, and scan them."*

## Your data

Samples go to LEEVAR's hosted service, are graded there by third-party
language models (named on the [privacy page](https://www.leevar.live/privacy)),
and are deleted 30 days after the scan completes. Each scan uses one of the
email's 5 free monthly scans.
Strip API keys, credentials and personal data before sending. The tool
descriptions tell the assistant to ask you before it sends anything.

To grade entirely on your own machine with a model you choose, use the scanner
in the root of this repository instead (`deno task scan`) — nothing leaves your
machine except the calls to your own model provider.

## Reading a result

- **Grade issued** — `Grade: B (composite 81.2)` with the coverage it was
  computed on. Gate on coverage as well as the letter.
- **No grade** — the samples did not evidence enough of the battery. Send
  longer, real conversations that exercise the missing behaviours: a long
  thread for context, a repeated task for consistency, a tool failure for
  recovery. A reference average may be shown; it is not a verdict.
- **Failed** — the reason, whose fault it was, and whether a retry makes sense.
  If the fault is LEEVAR's, the free scan is credited back.

## Develop

```bash
npm install
npm test          # all requests go to local fakes; no free scans are spent
npm run gen       # regenerate battery.json from packages/scanner-core (Deno)
```

`LEEVAR_API_URL` overrides the endpoint (the tests use it to point at a local
stub).

MIT.
