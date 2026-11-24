def accumulate(chunk, buffers):
    if chunk.finish_reason == "content_filter":
        return None
    delta = chunk.choices[0].delta
    for tc in delta.tool_calls:
        buffers[tc.index] = handle_partial(tc)
    return buffers
