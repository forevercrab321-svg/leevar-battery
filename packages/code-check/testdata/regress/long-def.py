def describe(reply):
    return reply.finish_reason


def run_tools(
    reply,
    tools,
    registry,
    tracer,
    budget,
    retries,
    timeout,
    session,
    user,
    org,
    region,
    flags,
):
    for call in reply.tool_calls:
        execute_tool(tools, call)
