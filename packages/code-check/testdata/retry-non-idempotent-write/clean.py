# The fixed shape: the same retry, with an idempotency key the server dedupes on.
from tenacity import retry, stop_after_attempt

API = "https://shop.example.invalid"


@retry(stop=stop_after_attempt(3))
def place_order(session, cart, key):
    resp = session.post(f"{API}/orders", json=cart, headers={"Idempotency-Key": key})
    resp.raise_for_status()
    return resp.json()
