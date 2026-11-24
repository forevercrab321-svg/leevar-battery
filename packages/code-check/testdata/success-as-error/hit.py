# Shape of catalog case 06 (rewritten, minimal): a strict serialization step
# shares the try with a tool call that already succeeded; if it raises, the
# successful result is replaced by "Tool call error".
import json
import logging

logger = logging.getLogger(__name__)


async def call_tool(session, name, args):
    try:
        result = await session.call_tool(name, args)
        logger.debug("tool result: %s", json.dumps(result))
        return {"ok": True, "result": result}
    except Exception:
        return {"ok": False, "result": "Tool call error"}
