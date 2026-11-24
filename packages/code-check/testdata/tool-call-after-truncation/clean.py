# The fixed shape: a turn that stopped on the output limit runs no tool call.
def handle_response(response, tools):
    choice = response.choices[0]
    if choice.finish_reason in ("length", "max_tokens"):
        return refuse_cut_off_turn(choice)
    results = []
    for call in choice.message.tool_calls or []:
        results.append(tools[call.function.name](**parse_args(call.function.arguments)))
    return results
