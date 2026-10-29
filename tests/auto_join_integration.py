import json
import os
import secrets
import urllib.error
import urllib.request

base = os.environ["OFFORA_TEST_URL"]


def call(path, body):
    request = urllib.request.Request(base + path, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        return error.code, json.load(error)


def members(channel, token):
    request = urllib.request.Request(base + "/api/v1/sessions?channel_id=" + channel, headers={"Authorization": "Bearer " + token})
    with urllib.request.urlopen(request, timeout=5) as response:
        return json.load(response)["sessions"]


def join(key, code):
    return call("/api/v1/auto/join", {"office_key": key, "role": "AI", "code": code, "model": "test"})


one, two = secrets.token_hex(32), secrets.token_hex(32)
status_a, a = join(one, "A1")
status_b, b = join(one, "B1")
status_c, c = join(two, "A1")
assert (status_a, status_b, status_c) == (201, 201, 201)
assert a["channel_id"] == b["channel_id"] != c["channel_id"]
assert join(one, "A1")[0] == 409
assert join("short", "X")[0] == 400
status, watcher = call("/api/v1/auto/watch", {"office_key": one})
assert status == 201 and watcher["channel_id"] == a["channel_id"]
seen = members(a["channel_id"], watcher["session_token"])
assert {"A1", "B1"} <= {m["code"] for m in seen}
assert c["session_id"] not in {m["session_id"] for m in seen}
assert call("/api/v1/auto/watch", {"office_key": secrets.token_hex(32)})[0] == 404
print("auto join integration passed")
