import json
import os
import secrets
import time
import urllib.error
import urllib.request

base = os.environ["OFFORA_TEST_URL"]


def post(key, body, session=None, extra=None):
    headers = {"Content-Type": "application/json"}
    if session:
        headers["Mcp-Session-Id"] = session
    headers.update(extra or {})
    request = urllib.request.Request(f"{base}/mcp/{key}", data=json.dumps(body).encode(), headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            raw = response.read()
            return response.status, (json.loads(raw) if raw else None), response.headers
    except urllib.error.HTTPError as error:
        raw = error.read()
        return error.code, (json.loads(raw) if raw else None), error.headers


def rpc(key, session, method, params=None, ident=1):
    body = {"jsonrpc": "2.0", "id": ident, "method": method}
    if params is not None:
        body["params"] = params
    return post(key, body, session)


def initialize(key, name):
    status, body, headers = rpc(key, None, "initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": name, "version": "1"}})
    return status, body, headers.get("Mcp-Session-Id")


def tool(key, session, name, arguments=None):
    status, body, _ = rpc(key, session, "tools/call", {"name": name, "arguments": arguments or {}})
    assert status == 200, (status, body)
    result = body["result"]
    return result["isError"], json.loads(result["content"][0]["text"])


key = secrets.token_hex(32)
status, body, a = initialize(key, "claude-code")
assert status == 200 and a, (status, body)
assert body["result"]["protocolVersion"] == "2025-06-18"
assert "office_update_summary" in body["result"]["instructions"]
assert body["result"]["capabilities"] == {"tools": {}}

status, _, _ = post(key, {"jsonrpc": "2.0", "method": "notifications/initialized"}, a)
assert status == 202

status, body, _ = rpc(key, a, "tools/list")
names = {t["name"] for t in body["result"]["tools"]}
assert len(names) == 16 and "office_describe" in names and "office_set_repo" in names and "office_update_summary" in names and "office_watch_url" in names

failed, who = tool(key, a, "office_whoami")
assert not failed and who["session_id"] and who["channel_id"]

failed, _ = tool(key, a, "office_update_summary", {"summary": "測試進度", "progress": 57})
assert not failed
failed, _ = tool(key, a, "office_update_summary", {"summary": "測試進度", "progress": 101})
assert failed

status, body, b = initialize(key, "codex")
assert status == 200 and b and b != a
failed, listing = tool(key, b, "office_list_sessions")
assert not failed
mine = {m["session_id"]: m for m in listing["sessions"]}
assert mine[who["session_id"]]["progress"] == 57 and mine[who["session_id"]]["summary"] == "測試進度"
assert len(mine) == 2

failed, sent = tool(key, a, "office_send_message", {"client_message_id": "m-" + secrets.token_hex(8), "text": "你好"})
assert not failed
failed, since = tool(key, b, "office_read_since", {"after_seq": 0})
assert not failed and any("你好" in json.dumps(m, ensure_ascii=False) for m in since["messages"])

failed, link = tool(key, a, "office_watch_url")
assert not failed and link["url"].endswith("/#office=" + key)

repo_name = "acme-" + secrets.token_hex(4)
key2 = secrets.token_hex(32)
key3 = secrets.token_hex(32)
_, _, a2 = initialize(key, "idle-same-computer")
_, _, d = initialize(key2, "claude-code")
_, _, e = initialize(key3, "claude-code")
failed, _ = tool(key, a, "office_set_repo", {"repo_url": f"https://github.com/Org/{repo_name}.git"})
assert not failed
failed, again = tool(key, a, "office_set_repo", {"repo_url": f"https://github.com/Org/{repo_name}.git"})
assert not failed and again["status"] == "already_set"
failed, _ = tool(key2, d, "office_set_repo", {"repo_url": f"git@github.com:org/{repo_name}"})
assert not failed
failed, _ = tool(key3, e, "office_set_repo", {"repo_url": f"https://github.com/org/other-{repo_name}"})
assert not failed
failed, _ = tool(key, a, "office_set_repo", {"repo_url": "not a url"})
assert failed
failed, _ = tool(key, b, "office_list_sessions", {"room": "repo"})
assert failed

failed, listing = tool(key2, d, "office_list_sessions")
assert not failed
rooms = {m["room"] for m in listing["sessions"]}
assert rooms == {"computer", "repo"}, rooms
repo_members = [m for m in listing["sessions"] if m["room"] == "repo"]
assert len(repo_members) == 2
assert len(listing["sessions"]) == 3

failed, listing = tool(key3, e, "office_list_sessions")
assert len(listing["sessions"]) == 2

failed, listing = tool(key, a, "office_list_sessions")
assert len([m for m in listing["sessions"] if m["room"] == "computer"]) == 3
assert len([m for m in listing["sessions"] if m["room"] == "repo"]) == 2

failed, _ = tool(key, a, "office_update_summary", {"summary": "兩間同步", "progress": 33})
assert not failed
failed, listing = tool(key2, d, "office_list_sessions", {"room": "repo"})
assert not failed and any(m["summary"] == "兩間同步" and m["progress"] == 33 for m in listing["sessions"])

text = "repo 訊息 " + secrets.token_hex(4)
failed, _ = tool(key, a, "office_send_message", {"client_message_id": "r-" + secrets.token_hex(8), "text": text})
assert not failed
failed, read = tool(key2, d, "office_read_messages")
assert any(text in json.dumps(m, ensure_ascii=False) and m["room"] == "repo" for m in read["messages"])
failed, read = tool(key3, e, "office_read_messages")
assert not any(text in json.dumps(m, ensure_ascii=False) for m in read["messages"])
failed, read = tool(key, b, "office_read_messages")
assert any(text in json.dumps(m, ensure_ascii=False) for m in read["messages"])

key4 = secrets.token_hex(32)
_, _, f4 = initialize(key4, "claude-code")
failed, _ = tool(key4, f4, "office_update_summary", {"summary": "先回報再加入", "progress": 0})
assert not failed
failed, _ = tool(key4, f4, "office_set_repo", {"repo_url": f"https://github.com/org/{repo_name}"})
assert not failed
failed, listing = tool(key2, d, "office_list_sessions", {"room": "repo"})
assert any(m["summary"] == "先回報再加入" and m["progress"] == 0 for m in listing["sessions"]), listing

def api(path, body):
    request = urllib.request.Request(f"{base}{path}", data=json.dumps(body).encode(), headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read())

failed, _ = tool(key2, d, "office_describe", {"goal": "修登入頁", "computer": "筆電", "environment": "WSL"})
assert not failed
status, listed = api("/api/v1/auto/rooms", {"office_key": key2})
assert status == 200, listed
kinds = [r["kind"] for r in listed["rooms"]]
assert kinds == ["computer", "repo"], kinds
assert listed["rooms"][0]["goal"] == "修登入頁" and listed["rooms"][0]["environment"] == "WSL"
assert listed["rooms"][1]["repo"] == f"github.com/org/{repo_name}", listed["rooms"][1]
assert "pw" not in json.dumps(listed)
status, named = api("/api/v1/auto/name", {"office_key": listed["rooms"][1]["key"], "name": "登入專案"})
assert status == 200
status, listed = api("/api/v1/auto/rooms", {"office_key": key2})
assert listed["rooms"][1]["name"] == "登入專案"
status, listed3 = api("/api/v1/auto/rooms", {"office_key": key3})
assert [r["kind"] for r in listed3["rooms"]] == ["computer", "repo"] and listed3["rooms"][0]["goal"] is None
status, _ = api("/api/v1/auto/rooms", {"office_key": secrets.token_hex(32)})
assert status == 404
status, _ = api("/api/v1/auto/name", {"office_key": secrets.token_hex(32), "name": "x"})
assert status == 404

time.sleep(1)
failed, listing = tool(key, b, "office_list_sessions")
assert all(m["presence"] in ("online", "unknown") for m in listing["sessions"])

other = secrets.token_hex(32)
status, _, c = initialize(other, "claude-code")
assert status == 200
status, _, _ = rpc(key, c, "tools/list")
assert status == 404
status, _, _ = rpc(key, None, "tools/list")
assert status == 400
status, _, _ = rpc(key, "0" * 32, "tools/list")
assert status == 404
status, _, _ = post(key, {"jsonrpc": "2.0", "id": 1, "method": "ping"}, a, {"Origin": "https://evil.example"})
assert status == 403
status, _, _ = post("short", {"jsonrpc": "2.0", "id": 1, "method": "ping"})
assert status == 403
request = urllib.request.Request(f"{base}/mcp/{key}", method="GET")
try:
    urllib.request.urlopen(request, timeout=5)
    raise AssertionError("GET unexpectedly succeeded")
except urllib.error.HTTPError as error:
    assert error.code == 405
status, body, _ = rpc(key, a, "no/such")
assert status == 200 and body["error"]["code"] == -32601

request = urllib.request.Request(f"{base}/mcp/{key}", headers={"Mcp-Session-Id": a}, method="DELETE")
with urllib.request.urlopen(request, timeout=5) as response:
    assert response.status == 204
status, _, _ = rpc(key, a, "tools/list")
assert status == 404
failed, listing = tool(key, b, "office_list_sessions")
assert who["session_id"] not in {m["session_id"] for m in listing["sessions"]}
limited = [initialize(secrets.token_hex(32), "burst")[0] for _ in range(30)]
assert 429 in limited and limited[0] == 200, limited
print("mcp integration passed")
