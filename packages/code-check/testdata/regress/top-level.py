reply = client.chat()
if reply.finish_reason == "content_filter":
    raise SystemExit(1)
for call in reply.tool_calls:
    execute_tool(call)
