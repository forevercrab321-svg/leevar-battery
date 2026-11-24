# The fixed shape: the tool call has its own try; logging is lenient and
# separately guarded, so it cannot turn a success into an error.
import json
import logging

logger = logging.getLogger(__name__)


async def call_tool(session, name, args):
    try:
        result = await session.call_tool(name, args)
    except Exception as exc:
        return {"ok": False, "result": f"Tool call error: {exc}"}
    try:
        logger.debug("tool result: %s", json.dumps(result, default=str))
    except Exception:
        pass
    return {"ok": True, "result": result}
