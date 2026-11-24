# Shape of catalog case 03 (rewritten, minimal): the loop reads finish_reason,
# but only to look for content_filter, then runs every tool call in the turn.
def handle_response(response, tools):
    choice = response.choices[0]
    if choice.finish_reason == "content_filter":
        return "blocked"
    results = []
    for call in choice.message.tool_calls or []:
        args = parse_args(call.function.arguments)
        results.append(tools[call.function.name](**args))
    return results
