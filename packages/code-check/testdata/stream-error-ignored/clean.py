# The fixed shape: an in-band error chunk fails the run.
import json


def run_workflow(resp):
    parts = []
    for line in resp.iter_lines():
        chunk = json.loads(line)
        if chunk["type"] == "item":
            parts.append(chunk["content"])
        elif chunk["type"] == "error":
            raise WorkflowError(chunk.get("message"))
        elif chunk["type"] == "end":
            break
    return "".join(parts)
