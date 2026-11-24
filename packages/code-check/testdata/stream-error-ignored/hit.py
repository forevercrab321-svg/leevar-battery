# Shape of catalog case 05 (rewritten, minimal): an NDJSON stream parser that
# knows "item" and "end" chunks; an in-band "error" chunk falls through.
import json


def run_workflow(resp):
    parts = []
    for line in resp.iter_lines():
        if not line:
            continue
        chunk = json.loads(line)
        if chunk["type"] == "item":
            parts.append(chunk["content"])
        elif chunk["type"] == "end":
            break
    return {"status": "completed", "text": "".join(parts)}
