def execute(client, payload):
    last = None
    for attempt in range(MAX_RATE_LIMIT_RETRIES + 1):
        try:
            last = client.post(API_URL, json=payload)
        except RequestError as exc:
            raise ValueError("request failed") from exc
        if last.status_code == 429 and attempt < MAX_RATE_LIMIT_RETRIES:
            sleep(1)
            continue
        break
    return last
