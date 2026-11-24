# Pattern (not yet in the catalog): an order is created inside an automatic
# retry with no idempotency key; a lost response creates a second order.
from tenacity import retry, stop_after_attempt, wait_exponential
from urllib3.util.retry import Retry

API = "https://shop.example.invalid"


@retry(stop=stop_after_attempt(3), wait=wait_exponential())
def place_order(session, cart):
    resp = session.post(f"{API}/orders", json=cart)
    resp.raise_for_status()
    return resp.json()


def make_adapter():
    return Retry(total=5, allowed_methods=None, backoff_factor=0.5)
