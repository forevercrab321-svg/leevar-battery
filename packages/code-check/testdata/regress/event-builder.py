def finish_stream(state):
    if state.finish_reason == "length":
        note_cut_off(state)
    for index, function_call in state.function_calls.items():
        yield done_event(
            item=_function_call_item(state, function_call),
        )
