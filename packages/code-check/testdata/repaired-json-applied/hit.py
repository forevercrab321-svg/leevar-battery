# Shape of catalog case 02 (rewritten, minimal): a cut-off JSON answer is
# repaired and its half values are written to the store.
import json
from json_repair import repair_json


def tag_document(client, store, doc):
    text = client.complete(doc.content)
    data = json.loads(repair_json(text))
    store.update(doc.id, tags=data["tags"], amount=data["amount"])
    store.mark_processed(doc.id)
