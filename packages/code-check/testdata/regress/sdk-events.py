import json


def consume(stream):
    for event in stream:
        if event.type == "response.created":
            start()
        elif event.type == "response.completed":
            args = json.loads(event.arguments)
            done(args)
