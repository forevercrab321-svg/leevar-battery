# The fixed shape: the finish reason is checked before anything is repaired.
import json_repair


def tag_document(client, store, doc):
    reply = client.complete(doc.content)
    if reply.finish_reason == "length":
        raise AnswerCutOff(doc.id)
    data = json_repair.loads(reply.text)
    store.update(doc.id, tags=data["tags"])
