import concurrent.futures
import hashlib
import json
import os
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

container = os.environ["OFFORA_TEST_DB_CONTAINER"]
database = os.environ["OFFORA_TEST_DB_NAME"]
base = os.environ["OFFORA_TEST_URL"]
tokens = {name: char * 64 for name, char in (("valid", "a"), ("expired", "b"), ("revoked", "c"), ("race", "d"))}


def sql(query):
    return subprocess.run(["docker", "exec", "-i", container, "psql", "-U", "postgres", "-d", database, "-v", "ON_ERROR_STOP=1", "-tA"], input=query, text=True, capture_output=True, check=True).stdout.strip()


def request_api(path, body, token=None):
    data = json.dumps(body).encode()
    headers = {"Content-Type": "application/json"}
    if token is not None:
        headers["Authorization"] = "Bearer " + token
    request = urllib.request.Request(base + path, data=data, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as response:
        return response.code, json.load(response)


def send(token):
    return request_api("/api/v1/invitations/redeem", {"invitation_token": token})


def read(path, token):
    request = urllib.request.Request(base + path, headers={"Authorization": "Bearer " + token})
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as response:
        return response.code, json.load(response)


def bootstrap(owner, space, channel, agent):
    data = json.dumps({"owner_id": owner, "space_id": space, "channel_id": channel, "agent_id": agent})
    result = subprocess.run(["target/debug/offora", "bootstrap"], input=data, text=True, capture_output=True, check=True)
    return json.loads(result.stdout)["owner_token"]


owner_token = bootstrap("owner", "space", "channel", "agent")
external_token = bootstrap("external-owner", "external-space", "external-channel", "external-agent")
assert len(owner_token) == 64 and owner_token != external_token
status, catalog = read("/api/v1/management", owner_token)
assert status == 200 and catalog["spaces"] == [{"id": "space", "name": "space"}]
assert catalog["channels"] == [{"id": "channel", "name": "channel", "space_id": "space"}]
assert catalog["agents"] == [{"id": "agent", "name": "agent"}]
status, external_catalog = read("/api/v1/management", external_token)
assert status == 200 and external_catalog["spaces"] == [{"id": "external-space", "name": "external-space"}]
assert read("/api/v1/management", "f" * 64)[0] == 401
assert request_api("/api/v1/observers", {"channel_id": "channel"}, "f" * 64)[0] == 401
assert request_api("/api/v1/observers", {"channel_id": "external-channel"}, owner_token)[0] == 403
status, observer = request_api("/api/v1/observers", {"channel_id": "channel"}, owner_token)
assert status == 201
observer_token = observer["session_token"]
status, empty_office = read("/api/v1/sessions?channel_id=channel", observer_token)
assert status == 200 and empty_office["sessions"] == []
observer_id = empty_office["self_session_id"]
assert read("/api/v1/sessions?channel_id=external-channel", observer_token)[0] == 403
assert read("/api/v1/management", owner_token)[1]["agents"] == [{"id": "agent", "name": "agent"}]
assert request_api("/api/v1/messages", {"schema_version": 1, "client_message_id": "observer-send", "channel_id": "channel", "payload": {"text": "forbidden"}}, observer_token)[0] == 403
assert request_api("/api/v1/sessions/me/heartbeat", {"channel_id": "channel", "sequence": 1}, observer_token)[0] == 403
bad = json.dumps({"owner_id": "rollback-owner", "space_id": "rollback-space", "channel_id": "channel", "agent_id": "rollback-agent"})
assert subprocess.run(["target/debug/offora", "bootstrap"], input=bad, text=True, capture_output=True).returncode != 0
assert sql("SELECT count(*) FROM owners WHERE id='rollback-owner';") == "0"
owner_digest = hashlib.sha256(owner_token.encode()).hexdigest()
assert request_api("/api/v1/spaces", {"id": "extra-space", "name": "Extra"}, owner_token)[0] == 201
assert request_api("/api/v1/spaces", {"id": "extra-space", "name": "Extra"}, owner_token)[0] == 200
assert request_api("/api/v1/spaces", {"id": "extra-space", "name": "Changed"}, owner_token)[0] == 409
assert request_api("/api/v1/spaces/external-space/channels", {"id": "forged", "name": "Forbidden"}, owner_token)[0] == 403
assert request_api("/api/v1/spaces/extra-space/channels", {"id": "extra-channel", "name": "Extra"}, owner_token)[0] == 201
assert request_api("/api/v1/agents", {"id": "extra-agent", "name": "Extra"}, owner_token)[0] == 201
assert request_api("/api/v1/agents", {"id": "unauthorized", "name": "Forbidden"})[0] == 401
extra_invite = {"space_id": "extra-space", "agent_id": "extra-agent", "channels": [{"channel_id": "extra-channel", "read": True, "send": True, "presence": False}], "expires_in_seconds": 3600, "max_uses": 1}
status, extra = request_api("/api/v1/invitations", extra_invite, owner_token)
assert status == 201
status, extra_credential = send(extra["invitation_token"])
assert status == 201
status, extra_session = request_api("/api/v1/sessions", {"role": "developer", "code": "X1", "model": "test"}, extra_credential["agent_token"])
assert status == 201
assert request_api("/api/v1/messages", {"schema_version": 1, "client_message_id": "x", "channel_id": "extra-channel", "payload": {"text": "new space"}}, extra_session["session_token"])[0] == 201
extra_discussion = {"channel_id": "extra-channel", "client_message_id": "older", "participants": [extra_session["session_id"]], "summary": "較早", "expires_in_seconds": 300}
status, old_discussion = request_api("/api/v1/conversations", extra_discussion, extra_session["session_token"])
assert status == 201
status, new_discussion = request_api("/api/v1/conversations", {**extra_discussion, "client_message_id": "newer", "summary": "較新"}, extra_session["session_token"])
assert status == 201
status, discussions = read("/api/v1/conversations?channel_id=extra-channel", extra_session["session_token"])
assert status == 200 and discussions["conversations"][0]["conversation_id"] == new_discussion["conversation_id"]
assert request_api("/api/v1/messages", {"schema_version": 1, "client_message_id": "older-activity", "channel_id": "extra-channel", "conversation_id": old_discussion["conversation_id"], "payload": {"text": "新回覆"}}, extra_session["session_token"])[0] == 201
status, discussions = read("/api/v1/conversations?channel_id=extra-channel", extra_session["session_token"])
assert status == 200 and discussions["conversations"][0]["conversation_id"] == old_discussion["conversation_id"]
status, baseline = read("/api/v1/messages/since?channel_id=extra-channel&after_seq=0&limit=200", extra_session["session_token"])
assert status == 200 and not baseline["has_more"]
assert baseline["latest_seq"] == baseline["next_seq"]
wait_path = "/api/v1/messages/since?channel_id=extra-channel&after_seq=" + str(baseline["next_seq"])
started = time.monotonic()
status, empty_wait = read(wait_path + "&wait_ms=400", extra_session["session_token"])
assert status == 200 and not empty_wait["messages"] and time.monotonic() - started >= 0.3
assert read(wait_path + "&wait_ms=25001", extra_session["session_token"])[0] == 400
ready = threading.Event()
def wait_for_message():
    ready.set()
    return read(wait_path + "&wait_ms=3000", extra_session["session_token"])
with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
    future = executor.submit(wait_for_message)
    assert ready.wait(1)
    time.sleep(0.2)
    assert not future.done()
    assert request_api("/api/v1/messages", {"schema_version": 1, "client_message_id": "wake-reader", "channel_id": "extra-channel", "payload": {"text": "喚醒讀取"}}, extra_session["session_token"])[0] == 201
    status, wake = future.result(timeout=3)
assert status == 200 and len(wake["messages"]) == 1 and wake["messages"][0]["payload"]["text"] == "喚醒讀取"
next_wait = "/api/v1/messages/since?channel_id=extra-channel&after_seq=" + str(wake["next_seq"]) + "&wait_ms=3000"
with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
    future = executor.submit(read, next_wait, extra_session["session_token"])
    time.sleep(0.2)
    assert not future.done()
    sql("UPDATE channel_grants SET can_read=false WHERE channel_id='extra-channel';")
    assert future.result(timeout=3)[0] == 403
sql("UPDATE channel_grants SET can_read=true WHERE channel_id='extra-channel';")
invite_body = {"space_id": "space", "agent_id": "external-agent", "channels": [{"channel_id": "channel", "read": True, "send": True, "presence": False}], "expires_in_seconds": 3600, "max_uses": 1}
assert request_api("/api/v1/invitations", invite_body)[0] == 401
assert request_api("/api/v1/invitations", {**invite_body, "space_id": "external-space"}, owner_token)[0] == 403
assert request_api("/api/v1/invitations", {**invite_body, "channels": [{"channel_id": "external-channel", "read": True, "send": True, "presence": False}]}, owner_token)[0] == 400
status, invite = request_api("/api/v1/invitations", invite_body, owner_token)
assert status == 201 and len(invite["invitation_token"]) == 64
status, external = send(invite["invitation_token"])
assert status == 201 and external["space_id"] == "space"
status, external_session = request_api("/api/v1/sessions", {"role": "external", "code": "E1", "model": "test"}, external["agent_token"])
assert status == 201
external_message = {"schema_version": 1, "client_message_id": "ext-1", "channel_id": "channel", "payload": {"text": "external"}}
assert request_api("/api/v1/messages", external_message, external_session["session_token"])[0] == 201
assert request_api("/api/v1/messages", {**external_message, "channel_id": "external-channel", "client_message_id": "ext-2"}, external_session["session_token"])[0] == 403
status, pending_invite = request_api("/api/v1/invitations", invite_body, owner_token)
assert status == 201
for name, token in tokens.items():
    digest = hashlib.sha256(token.encode()).hexdigest()
    expiry = "now() - interval '1 second'" if name == "expired" else "now() + interval '1 hour'"
    revoked = "now()" if name == "revoked" else "NULL"
    sql(f"INSERT INTO invitations (id, space_id, agent_id, token_hash, expires_at, max_uses, revoked_at) VALUES ('{name}', 'space', 'agent', decode('{digest}', 'hex'), {expiry}, 1, {revoked}); INSERT INTO invitation_channels (space_id, invitation_id, channel_id, can_read, can_send) VALUES ('space', '{name}', 'channel', true, true);")

status, response = send(tokens["valid"])
assert status == 201 and response["space_id"] == "space"
credential = response["agent_token"]
assert len(credential) == 64 and credential != tokens["valid"]
digest = hashlib.sha256(credential.encode()).hexdigest()
assert sql(f"SELECT count(*) FROM agent_credentials a JOIN channel_grants g ON g.credential_id = a.id WHERE a.token_hash = decode('{digest}', 'hex') AND g.channel_id = 'channel' AND g.can_read AND g.can_send;") == "1"
assert send(tokens["valid"])[0] == 401
assert send(tokens["expired"])[0] == 401
assert send(tokens["revoked"])[0] == 401
assert send("bad")[0] == 400
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
    statuses = sorted(result[0] for result in executor.map(send, [tokens["race"]] * 2))
assert statuses == [201, 401]
assert sql("SELECT uses FROM invitations WHERE id = 'race';") == "1"
session_body = {"role": "developer", "code": "D1", "model": "test", "summary": "working"}
status, session = request_api("/api/v1/sessions", session_body, credential)
assert status == 201 and session["space_id"] == "space" and len(session["session_token"]) == 64
assert session["session_token"] != credential
assert request_api("/api/v1/sessions", session_body, credential)[0] == 409
assert request_api("/api/v1/sessions", {**session_body, "code": "D2", "space_id": "other"}, credential)[0] == 400
assert request_api("/api/v1/sessions", {**session_body, "code": "D2"}, "f" * 64)[0] == 401
assert request_api("/api/v1/sessions", {**session_body, "code": "D2"})[0] == 401
status, outsider = request_api("/api/v1/sessions", {**session_body, "code": "D2"}, credential)
assert status == 201
assert request_api("/api/v1/sessions", {**session_body, "code": "D3"}, credential)[0] == 201
assert sql("SELECT count(*) FROM sessions WHERE space_id='space' AND role='developer';") == "3"
status, members = read("/api/v1/sessions?channel_id=channel", session["session_token"])
assert status == 200 and len(members["sessions"]) == 4
assert members["self_session_id"] == session["session_id"]
assert {member["code"] for member in members["sessions"]} == {"D1", "D2", "D3", "E1"}
assert all(member["agent_id"] == "agent" and member["agent_name"] == "agent" for member in members["sessions"] if member["code"].startswith("D"))
assert next(member for member in members["sessions"] if member["code"] == "E1")["agent_id"] == "external-agent"
summary_path = "/api/v1/sessions/me/summary"
assert request_api(summary_path, {"channel_id": "channel", "summary": "正在設計"}, session["session_token"])[0] == 403
sql("UPDATE channel_grants SET can_presence=true WHERE space_id='space' AND channel_id='channel' AND credential_id=(SELECT credential_id FROM sessions WHERE id='" + session["session_id"] + "');")
assert request_api(summary_path, {"channel_id": "channel", "summary": "正在設計"}, session["session_token"])[0] == 200
assert request_api(summary_path, {"channel_id": "channel", "summary": "偽造", "session_id": outsider["session_id"]}, session["session_token"])[0] == 400
assert request_api(summary_path, {"channel_id": "external-channel", "summary": "跨空間"}, session["session_token"])[0] == 403
status, members = read("/api/v1/sessions?channel_id=channel", session["session_token"])
assert status == 200 and next(member for member in members["sessions"] if member["session_id"] == session["session_id"])["summary"] == "正在設計"
heartbeat_path = "/api/v1/sessions/me/heartbeat"
assert request_api(heartbeat_path, {"channel_id": "channel", "sequence": 1}, external_session["session_token"])[0] == 403
assert request_api(heartbeat_path, {"channel_id": "channel", "sequence": 1}, session["session_token"])[0] == 200
status, members = read("/api/v1/sessions?channel_id=channel", session["session_token"])
assert next(member for member in members["sessions"] if member["session_id"] == session["session_id"])["presence"] == "online"
sql("UPDATE sessions SET last_heartbeat_at=now()-interval '100 seconds' WHERE id='" + session["session_id"] + "';")
assert request_api(heartbeat_path, {"channel_id": "channel", "sequence": 1}, session["session_token"])[0] == 409
status, members = read("/api/v1/sessions?channel_id=channel", session["session_token"])
assert next(member for member in members["sessions"] if member["session_id"] == session["session_id"])["presence"] == "offline"
assert request_api(heartbeat_path, {"channel_id": "channel", "sequence": 2}, session["session_token"])[0] == 200
assert request_api(heartbeat_path, {"channel_id": "channel", "sequence": 3}, session["session_token"])[0] == 200
status, presence_events = read("/api/v1/events/since?channel_id=channel&after_seq=0&limit=200", session["session_token"])
assert status == 200
online = [item for item in presence_events["events"] if item["actor_session_id"] == session["session_id"] and item["type"] == "presence.updated"]
assert len(online) == 2 and all(item["payload"] == {"presence": "online"} for item in online)
presence = [item for item in presence_events["events"] if item["actor_session_id"] == session["session_id"] and item["type"] in ("presence.updated", "presence.offline")]
assert [(item["type"], item["payload"]) for item in presence] == [("presence.updated", {"presence": "online"}), ("presence.offline", {"presence": "offline"}), ("presence.updated", {"presence": "online"})]
sql("UPDATE sessions SET last_heartbeat_at=now()-interval '100 seconds' WHERE id='" + session["session_id"] + "';")
deadline = time.monotonic() + 12
while time.monotonic() < deadline:
    status, presence_events = read("/api/v1/events/since?channel_id=channel&after_seq=0&limit=200", session["session_token"])
    offline = [item for item in presence_events["events"] if item["actor_session_id"] == session["session_id"] and item["type"] == "presence.offline"]
    if len(offline) == 2:
        break
    time.sleep(0.2)
assert status == 200 and len(offline) == 2 and offline[-1]["payload"] == {"presence": "offline"}
assert request_api(heartbeat_path, {"channel_id": "channel", "sequence": 4}, session["session_token"])[0] == 200
status, presence_events = read("/api/v1/events/since?channel_id=channel&after_seq=0&limit=200", session["session_token"])
presence = [item["type"] for item in presence_events["events"] if item["actor_session_id"] == session["session_id"] and item["type"] in ("presence.updated", "presence.offline")]
assert presence == ["presence.updated", "presence.offline", "presence.updated", "presence.offline", "presence.updated"]
assert read("/api/v1/sessions?channel_id=external-channel", session["session_token"])[0] == 403
conversation = {"channel_id": "channel", "client_message_id": "discussion-1", "participants": [session["session_id"], external_session["session_id"]], "summary": "討論", "expires_in_seconds": 300}
status, created = request_api("/api/v1/conversations", conversation, session["session_token"])
assert status == 201 and len(created["conversation_id"]) == 64
open_path = "/api/v1/conversations?channel_id=channel&status=open&page=1"
closed_path = "/api/v1/conversations?channel_id=channel&status=closed&page=1"
assert next(item for item in read(open_path, session["session_token"])[1]["conversations"] if item["conversation_id"] == created["conversation_id"])["gathering"] is True
sql("UPDATE conversations SET expires_at=now()-interval '1 second' WHERE id='" + created["conversation_id"] + "';")
assert next(item for item in read(open_path, session["session_token"])[1]["conversations"] if item["conversation_id"] == created["conversation_id"])["gathering"] is False
assert all(item["conversation_id"] != created["conversation_id"] for item in read(closed_path, session["session_token"])[1]["conversations"])
assert any(item["conversation_id"] == created["conversation_id"] for item in read("/api/v1/conversations?channel_id=channel&status=ended", session["session_token"])[1]["conversations"])
sql("UPDATE conversations SET expires_at=now()+interval '300 seconds' WHERE id='" + created["conversation_id"] + "';")
cancel_path = "/api/v1/conversations/" + created["conversation_id"] + "/cancel"
assert request_api(cancel_path, {}, outsider["session_token"])[0] == 403
assert request_api(cancel_path, {}, session["session_token"]) == (200, {"status": "released"})
assert request_api(cancel_path, {}, session["session_token"]) == (200, {"status": "released"})
assert next(item for item in read(open_path, session["session_token"])[1]["conversations"] if item["conversation_id"] == created["conversation_id"])["gathering"] is False
sql("UPDATE conversations SET expires_at=now()+interval '300 seconds' WHERE id='" + created["conversation_id"] + "';")
status, active = read("/api/v1/conversations?channel_id=channel", session["session_token"])
assert status == 200 and active["conversations"] == [{"conversation_id": created["conversation_id"], "summary": "討論", "participants": sorted(conversation["participants"])}]
assert read("/api/v1/conversations?channel_id=external-channel", session["session_token"])[0] == 403
assert request_api("/api/v1/conversations", {**conversation, "participants": list(reversed(conversation["participants"]))}, session["session_token"]) == (200, created)
assert request_api("/api/v1/conversations", {**conversation, "summary": "不同內容"}, session["session_token"])[0] == 409
assert sql("SELECT count(*) FROM conversation_participants WHERE conversation_id='" + created["conversation_id"] + "';") == "2"
assert request_api("/api/v1/conversations", {**conversation, "participants": [external_session["session_id"]]}, session["session_token"])[0] == 403
assert request_api("/api/v1/conversations", {**conversation, "client_message_id": "observer-participant", "participants": [session["session_id"], observer_id]}, session["session_token"])[0] == 403
assert request_api("/api/v1/conversations", {**conversation, "participants": [session["session_id"], "f" * 64]}, session["session_token"])[0] == 403
assert request_api("/api/v1/conversations", {**conversation, "channel_id": "external-channel"}, session["session_token"])[0] == 403
assert request_api("/api/v1/conversations", {**conversation, "participants": [session["session_id"]] * 2}, session["session_token"])[0] == 400
end_path = "/api/v1/conversations/" + created["conversation_id"] + "/end"
assert request_api(end_path, {}, outsider["session_token"])[0] == 403
assert request_api(end_path, {}, session["session_token"])[0] == 200
ended_at = sql("SELECT ended_at::text FROM conversations WHERE id='" + created["conversation_id"] + "';")
assert read("/api/v1/conversations?channel_id=channel", session["session_token"]) == (200, {"conversations": []})
status, ended_list = read("/api/v1/conversations?channel_id=channel&status=ended", session["session_token"])
assert status == 200 and ended_list["conversations"] == [{"conversation_id": created["conversation_id"], "summary": "討論", "participants": sorted(conversation["participants"])}]
assert read("/api/v1/conversations?channel_id=external-channel&status=ended", session["session_token"])[0] == 403
assert request_api(end_path, {}, session["session_token"])[0] == 200
assert sql("SELECT ended_at::text FROM conversations WHERE id='" + created["conversation_id"] + "';") == ended_at
sql("INSERT INTO spaces VALUES ('other', 'owner', 'Other'); INSERT INTO channels VALUES ('other-channel', 'other', 'Other'), ('private-channel', 'space', 'Private');")
message = {"schema_version": 1, "client_message_id": "request-1", "channel_id": "channel", "payload": {"text": "hello", "kind": "question", "work_ref": "site/login", "parent_work_ref": "site"}}
status, saved = request_api("/api/v1/messages", message, session["session_token"])
assert status == 201
status, before_read = read("/api/v1/messages?channel_id=channel", session["session_token"])
assert status == 200 and next(item for item in before_read["messages"] if item["message_id"] == saved["message_id"])["readers"] == []
read_path = "/api/v1/messages/" + saved["message_id"] + "/read"
assert request_api(read_path, {}, "f" * 64)[0] == 401
assert request_api(read_path, {}, observer_token)[0] == 403
assert request_api(read_path, {}, extra_session["session_token"])[0] == 403
assert request_api(read_path, {}, external_session["session_token"]) == (200, {"status": "read"})
assert request_api(read_path, {}, external_session["session_token"]) == (200, {"status": "read"})
status, after_read = read("/api/v1/messages?channel_id=channel", session["session_token"])
readers = next(item for item in after_read["messages"] if item["message_id"] == saved["message_id"])["readers"]
assert readers == [{"session_id": external_session["session_id"], "role": "external", "code": "E1"}]
status, read_events = read("/api/v1/messages/since?channel_id=channel&after_seq=0&limit=200", session["session_token"])
assert status == 200 and next(item for item in read_events["messages"] if item["message_id"] == saved["message_id"])["readers"] == readers
status, typed_read_events = read("/api/v1/events/since?channel_id=channel&after_seq=0&limit=200", session["session_token"])
assert status == 200 and next(item for item in typed_read_events["events"] if item["message_id"] == saved["message_id"])["readers"] == readers
status, resent = request_api("/api/v1/messages", message, session["session_token"])
assert status == 200 and saved["message_id"] == resent["message_id"]
assert request_api("/api/v1/messages", {**message, "payload": {"text": "changed"}}, session["session_token"])[0] == 409
assert request_api("/api/v1/messages", {**message, "client_message_id": "other", "channel_id": "other-channel"}, session["session_token"])[0] == 403
assert request_api("/api/v1/messages", {**message, "client_message_id": "private", "channel_id": "private-channel"}, session["session_token"])[0] == 403
assert request_api("/api/v1/messages", {**message, "actor_session_id": "someone"}, session["session_token"])[0] == 400
assert request_api("/api/v1/messages", message, "f" * 64)[0] == 401
assert sql("SELECT count(*) FROM messages WHERE channel_id='channel';") == "2"
status, second = request_api("/api/v1/messages", {**message, "client_message_id": "second", "payload": {"text": "second"}}, session["session_token"])
assert status == 201
status, page = read("/api/v1/messages?channel_id=channel&limit=1", session["session_token"])
assert status == 200 and len(page["messages"]) == 1 and page["next_cursor"]
status, next_page = read("/api/v1/messages?channel_id=channel&limit=1&cursor=" + page["next_cursor"], session["session_token"])
assert status == 200 and len(next_page["messages"]) == 1 and next_page["next_cursor"] is not None
assert page["messages"][0]["message_id"] != next_page["messages"][0]["message_id"]
status, work = read("/api/v1/messages?channel_id=channel&work_ref=site%2Flogin", session["session_token"])
assert status == 200 and len(work["messages"]) == 1 and work["messages"][0]["payload"]["parent_work_ref"] == "site"
status, actor = read("/api/v1/messages?channel_id=channel&actor_session_id=" + session["session_id"], session["session_token"])
assert status == 200 and len(actor["messages"]) == 2
assert read("/api/v1/messages?channel_id=channel&work_ref=other&cursor=" + saved["message_id"], session["session_token"])[0] == 400
assert read("/api/v1/messages?channel_id=other-channel", session["session_token"])[0] == 403
assert read("/api/v1/messages?channel_id=private-channel", session["session_token"])[0] == 403
assert read("/api/v1/messages?channel_id=channel&limit=201", session["session_token"])[0] == 400
assert read("/api/v1/messages?channel_id=channel&cursor=" + "f" * 64, session["session_token"])[0] == 400
in_conversation = {**message, "client_message_id": "discussion-msg", "conversation_id": created["conversation_id"]}
status, conversation_message = request_api("/api/v1/messages", in_conversation, session["session_token"])
assert status == 201
assert request_api("/api/v1/messages", in_conversation, session["session_token"]) == (200, conversation_message)
assert request_api("/api/v1/messages", {**in_conversation, "conversation_id": None}, session["session_token"])[0] == 409
assert request_api("/api/v1/messages", {**in_conversation, "client_message_id": "intruder"}, outsider["session_token"])[0] == 403
event_path = "/api/v1/events/since?channel_id=channel&after_seq="
event_cursor = 0
events = []
while True:
    status, page = read(event_path + str(event_cursor) + "&limit=2", session["session_token"])
    assert status == 200
    events.extend(page["events"])
    event_cursor = page["next_seq"]
    if not page["has_more"]:
        break
conversation_events = [item for item in events if item["conversation_id"] == created["conversation_id"]]
assert [item["type"] for item in conversation_events] == ["conversation.intent", "conversation.cancelled", "conversation.ended", "conversation.message"]
assert conversation_events[-1]["message_id"] == conversation_message["message_id"]
assert conversation_events[-1]["payload"]["text"] == "hello"
assert [item["seq"] for item in events] == list(range(1, len(events) + 1))
assert read(event_path + "999999", session["session_token"])[0] == 400
assert read("/api/v1/events/since?channel_id=external-channel&after_seq=0", session["session_token"])[0] == 403
assert read(event_path + "0", "f" * 64)[0] == 401
leave_intent = {"channel_id": "channel", "client_message_id": "leave-intent", "participants": [session["session_id"], outsider["session_id"]], "summary": "成員離開測試", "expires_in_seconds": 300}
status, leave_conversation = request_api('/api/v1/conversations', leave_intent, session['session_token'])
assert status == 201
assert next(item for item in read(open_path, session['session_token'])[1]['conversations'] if item['conversation_id'] == leave_conversation['conversation_id'])['gathering'] is True
status, departing = request_api("/api/v1/messages", {**message, "client_message_id": "departing-message", "payload": {"text": "離開前發話"}}, outsider["session_token"])
assert status == 201
assert request_api("/api/v1/sessions/me/leave", {}, outsider["session_token"])[0] == 200
assert request_api("/api/v1/sessions/me/leave", {}, outsider["session_token"])[0] == 200
assert next(item for item in read(open_path, session['session_token'])[1]['conversations'] if item['conversation_id'] == leave_conversation['conversation_id'])['gathering'] is False
status, after_departure = read(event_path + "0&limit=200", session["session_token"])
assert status == 200
outsider_events = [item for item in after_departure["events"] if item["actor_session_id"] == outsider["session_id"]]
assert [item["type"] for item in outsider_events] == ["session.joined", "conversation.message", "session.left"]
assert outsider_events[0]["payload"] == {"role": "developer", "code": "D2", "model": "test"}
assert outsider_events[1]["actor_role"] == "developer" and outsider_events[1]["actor_code"] == "D2"
assert outsider_events[1]["readers"] == [] and outsider_events[1]["reply_excerpt"] is None
assert sum(item["type"] == "session.left" for item in outsider_events) == 1
assert all(item["actor_session_id"] != observer_id for item in after_departure["events"])
status, former = read("/api/v1/messages?channel_id=channel&actor_session_id=" + outsider["session_id"], session["session_token"])
assert status == 200 and len(former["messages"]) == 1 and former["messages"][0]["message_id"] == departing["message_id"]
assert former["messages"][0]["actor_role"] == "developer" and former["messages"][0]["actor_code"] == "D2"
status, former_since = read("/api/v1/messages/since?channel_id=channel&after_seq=0&limit=200", session["session_token"])
former_event = next(item for item in former_since["messages"] if item["message_id"] == departing["message_id"])
assert status == 200 and former_event["actor_role"] == "developer" and former_event["actor_code"] == "D2"
assert request_api("/api/v1/messages", {**message, "client_message_id": "after-leave"}, outsider["session_token"])[0] == 401
assert request_api("/api/v1/messages", {**in_conversation, "client_message_id": "unknown", "conversation_id": "f" * 64}, session["session_token"])[0] == 403
status, conversation_history = read("/api/v1/messages?channel_id=channel&conversation_id=" + created["conversation_id"], session["session_token"])
assert status == 200 and len(conversation_history["messages"]) == 1 and conversation_history["messages"][0]["message_id"] == conversation_message["message_id"]
sql("UPDATE conversations SET expires_at=now()-interval '1 second' WHERE id='" + created["conversation_id"] + "';")
assert request_api("/api/v1/messages", {**in_conversation, "client_message_id": "late"}, session["session_token"])[0] == 201
reply = {**message, "client_message_id": "reply", "payload": {"text": "reply"}, "reply_to": saved["message_id"]}
status, reply_saved = request_api("/api/v1/messages", reply, session["session_token"])
assert status == 201
assert request_api("/api/v1/messages", reply, session["session_token"]) == (200, reply_saved)
assert request_api("/api/v1/messages", {**reply, "reply_to": second["message_id"]}, session["session_token"])[0] == 409
assert request_api("/api/v1/messages", {**reply, "client_message_id": "bad-reply", "reply_to": "f" * 64}, session["session_token"])[0] == 400
sql("INSERT INTO channel_grants (space_id,credential_id,channel_id,can_read,can_send) SELECT 'space', credential_id, 'private-channel', true, true FROM sessions WHERE code='D1';")
assert request_api("/api/v1/messages", {**reply, "client_message_id": "cross-channel-reply", "channel_id": "private-channel"}, session["session_token"])[0] == 400
status, history = read("/api/v1/messages?channel_id=channel", session["session_token"])
assert status == 200 and any(item["message_id"] == reply_saved["message_id"] and item["reply_to"] == saved["message_id"] for item in history["messages"])
assert next(item for item in history["messages"] if item["message_id"] == reply_saved["message_id"])["reply_excerpt"] == "hello"
status, reply_events = read("/api/v1/events/since?channel_id=channel&after_seq=0&limit=200", session["session_token"])
assert status == 200
assert next(item for item in reply_events["events"] if item["message_id"] == reply_saved["message_id"])["reply_excerpt"] == "hello"
status, initial_delivery = read("/api/v1/messages/since?channel_id=channel&after_seq=0&limit=200", session["session_token"])
assert status == 200 and not initial_delivery["has_more"]
assert next(item for item in initial_delivery["messages"] if item["message_id"] == reply_saved["message_id"])["reply_excerpt"] == "hello"
anchor = initial_delivery["next_seq"]
def send_batch(index):
    token = session["session_token"] if index % 2 == 0 else external_session["session_token"]
    body = {"schema_version": 1, "client_message_id": "batch-" + str(index), "channel_id": "channel", "payload": {"text": "batch " + str(index)}}
    return request_api("/api/v1/messages", body, token)
with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
    sent_batch = list(executor.map(send_batch, range(20)))
assert all(status == 201 for status, _ in sent_batch)
assert send_batch(0)[0] == 200
cursor = anchor
delivered = []
while True:
    status, page = read("/api/v1/messages/since?channel_id=channel&after_seq=" + str(cursor) + "&limit=3", session["session_token"])
    assert status == 200
    delivered.extend(page["messages"])
    cursor = page["next_seq"]
    if not page["has_more"]:
        break
assert [item["seq"] for item in delivered] == list(range(anchor + 1, anchor + 21))
assert {item["message_id"] for item in delivered} == {body["message_id"] for _, body in sent_batch}
status, sequence_history = read("/api/v1/messages?channel_id=channel&order=sequence&limit=200", session["session_token"])
assert status == 200
assert [item["message_id"] for item in sequence_history["messages"][:20]] == [item["message_id"] for item in reversed(delivered)]
assert [item["message_seq"] for item in sequence_history["messages"][:20]] == list(range(anchor + 20, anchor, -1))
status, sequence_events = read("/api/v1/events/since?channel_id=channel&after_seq=0&limit=200", session["session_token"])
assert status == 200
event_messages = [item for item in sequence_events["events"] if item["message_id"] in {message["message_id"] for message in delivered}]
assert [item["message_seq"] for item in event_messages] == list(range(anchor + 1, anchor + 21))
status, time_history = read("/api/v1/messages?channel_id=channel&limit=1", session["session_token"])
assert status == 200 and "message_seq" not in time_history["messages"][0]
assert read("/api/v1/messages?channel_id=channel&order=unknown", session["session_token"])[0] == 400
assert read("/api/v1/messages/since?channel_id=other-channel&after_seq=0", session["session_token"])[0] == 403
assert read("/api/v1/messages/since?channel_id=channel&after_seq=" + str(cursor + 1), session["session_token"])[0] == 400
readonly_invite = {"space_id": "space", "agent_id": "agent", "channels": [{"channel_id": "channel", "read": True, "send": False, "presence": False}], "expires_in_seconds": 3600, "max_uses": 1}
status, readonly_ticket = request_api("/api/v1/invitations", readonly_invite, owner_token)
assert status == 201
status, readonly_agent = send(readonly_ticket["invitation_token"])
assert status == 201
status, readonly_session = request_api("/api/v1/sessions", {"role": "reader", "code": "RO-SOCKET", "model": "test"}, readonly_agent["agent_token"])
assert status == 201
socket_env = dict(os.environ, OFFORA_TEST_SESSION_TOKEN=session["session_token"], OFFORA_TEST_SESSION_ID=session["session_id"], OFFORA_TEST_READONLY_TOKEN=readonly_session["session_token"])
subprocess.run(["node", "tests/socket_integration.mjs"], env=socket_env, check=True, timeout=30)
sql("INSERT INTO sessions (id,space_id,credential_id,token_hash,role,code,model) SELECT lpad(to_hex(n+100000),64,'0'),'space',(SELECT credential_id FROM sessions WHERE id='" + session["session_id"] + "'),decode(lpad(to_hex(n+200000),64,'0'),'hex'),'tester','PAGE'||lpad(n::text,3,'0'),'test' FROM generate_series(1,201) AS n;")
status, members_first = read("/api/v1/sessions?channel_id=channel", session["session_token"])
assert status == 200 and len(members_first["sessions"]) == 200 and members_first["next_cursor"]
status, members_second = read("/api/v1/sessions?channel_id=channel&cursor=" + members_first["next_cursor"], session["session_token"])
combined = members_first["sessions"] + members_second["sessions"]
assert status == 200 and members_second["next_cursor"] is None
assert sum(item["code"].startswith("PAGE") for item in combined) == 201
assert len({item["session_id"] for item in combined}) == len(combined)
assert read("/api/v1/sessions?channel_id=channel&cursor=", session["session_token"])[0] == 400
assert read("/api/v1/sessions?channel_id=other-channel&cursor=PAGE001", session["session_token"])[0] == 403
status, last_member = request_api("/api/v1/sessions", {"role": "tester", "code": "ZZZ-PAGE", "model": "test"}, credential)
assert status == 201
client_env = dict(os.environ, PYTHONPATH="clients/python", OFFORA_PAGED_SESSION_ID=last_member["session_id"], OFFORA_PAGED_SESSION_TOKEN=last_member["session_token"])
client_test = "from offora_client import OfforaClient; import os; c=OfforaClient(os.environ['OFFORA_TEST_URL'],'channel',os.environ['OFFORA_PAGED_SESSION_ID'],os.environ['OFFORA_PAGED_SESSION_TOKEN']); c.__enter__(); members=c.list_sessions()['sessions']; assert len(members)>200 and any(m['session_id']==c.session_id for m in members); c.__exit__(None,None,None)"
subprocess.run([sys.executable, "-c", client_test], env=client_env, check=True, timeout=15)
sql(f"""WITH inserted AS (
    INSERT INTO conversations (id,space_id,channel_id,created_by,client_message_id,summary,expires_in_seconds,expires_at,created_at,ended_at)
    SELECT repeat(md5('history-page-' || n),2),'space','channel','{session['session_id']}', 'history-page-' || n, '分頁測試 ' || n,3600,now()+interval '1 hour',now()-interval '30 days',now()-n*interval '1 second'
    FROM generate_series(1,201) n RETURNING id,space_id,created_by
) INSERT INTO conversation_participants (space_id,conversation_id,session_id) SELECT space_id,id,created_by FROM inserted;""")
history_path = "/api/v1/conversations?channel_id=channel&status=ended"
status, legacy = read(history_path, session["session_token"])
assert status == 200 and len(legacy["conversations"]) == 200 and "next_cursor" not in legacy
status, first_page = read(history_path + "&page=1", session["session_token"])
assert status == 200 and len(first_page["conversations"]) == 200 and first_page["next_cursor"]
status, second_page = read(history_path + "&page=1&cursor=" + first_page["next_cursor"], session["session_token"])
history = first_page["conversations"] + second_page["conversations"]
assert status == 200 and sum(item["summary"].startswith("分頁測試 ") for item in history) == 201
assert len({item["conversation_id"] for item in history}) == len(history)
assert read(history_path + "&page=1&cursor=" + "f" * 64, session["session_token"])[0] == 400
assert read("/api/v1/conversations?channel_id=external-channel&status=ended&page=1", session["session_token"])[0] == 403
sql(f"""WITH inserted AS (
    INSERT INTO conversations (id,space_id,channel_id,created_by,client_message_id,summary,expires_in_seconds,expires_at,created_at)
    SELECT repeat(md5('active-page-' || n),2),'space','channel','{session['session_id']}', 'active-page-' || n, '進行測試 ' || n,3600,now()+interval '1 hour',now()-n*interval '1 second'
    FROM generate_series(1,201) n RETURNING id,space_id,created_by
) INSERT INTO conversation_participants (space_id,conversation_id,session_id) SELECT space_id,id,created_by FROM inserted;""")
active_path = "/api/v1/conversations?channel_id=channel&status=active&page=1"
status, active_first = read(active_path, session["session_token"])
assert status == 200 and len(active_first["conversations"]) == 200 and active_first["next_cursor"]
status, active_second = read(active_path + "&cursor=" + active_first["next_cursor"], session["session_token"])
active_history = active_first["conversations"] + active_second["conversations"]
assert status == 200 and sum(item["summary"].startswith("進行測試 ") for item in active_history) == 201
assert len({item["conversation_id"] for item in active_history}) == len(active_history)
assert all(item.get("last_activity") for item in active_history)
intent = {"channel_id": "channel", "client_message_id": "disconnect-intent", "participants": [session["session_id"]], "summary": "失聯測試", "expires_in_seconds": 300}
status, before_disconnect = request_api('/api/v1/conversations', intent, session['session_token'])
assert status == 201
assert next(item for item in read(open_path, session['session_token'])[1]['conversations'] if item['conversation_id'] == before_disconnect['conversation_id'])['gathering'] is True
next_heartbeat = int(sql("SELECT heartbeat_seq FROM sessions WHERE id='" + session['session_id'] + "';")) + 1
sql("UPDATE sessions SET last_heartbeat_at=now()-interval '100 seconds' WHERE id='" + session['session_id'] + "';")
assert request_api(heartbeat_path, {'channel_id': 'channel', 'sequence': next_heartbeat}, session['session_token'])[0] == 200
assert next(item for item in read(open_path, session['session_token'])[1]['conversations'] if item['conversation_id'] == before_disconnect['conversation_id'])['gathering'] is False
status, after_disconnect = request_api('/api/v1/conversations', {**intent, 'client_message_id': 'disconnect-new-intent'}, session['session_token'])
assert status == 201
assert next(item for item in read(open_path, session['session_token'])[1]['conversations'] if item['conversation_id'] == after_disconnect['conversation_id'])['gathering'] is True
sql("UPDATE channel_grants SET can_read=false WHERE channel_id='channel';")
assert read("/api/v1/messages?channel_id=channel", session["session_token"])[0] == 403
assert read("/api/v1/messages/since?channel_id=channel&after_seq=0", session["session_token"])[0] == 403
assert request_api("/api/v1/messages", {**reply, "client_message_id": "blind-reply"}, session["session_token"])[0] == 403
assert request_api("/api/v1/messages", {**message, "client_message_id": "write-only"}, session["session_token"])[0] == 201
revoke_path = "/api/v1/spaces/space/agents/external-agent/revoke"
assert request_api(revoke_path, {}, external_token)[0] == 403
assert request_api(revoke_path, {})[0] == 401
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
    revoke_future = executor.submit(request_api, revoke_path, {}, owner_token)
    redeem_future = executor.submit(send, pending_invite["invitation_token"])
    assert revoke_future.result()[0] == 200
    race_status, race_result = redeem_future.result()
assert race_status in (201, 401)
if race_status == 201:
    assert request_api("/api/v1/sessions", {"role": "external", "code": "E3", "model": "test"}, race_result["agent_token"])[0] == 401
assert request_api(revoke_path, {}, owner_token)[0] == 200
assert send(pending_invite["invitation_token"])[0] == 401
assert request_api("/api/v1/sessions", {"role": "external", "code": "E2", "model": "test"}, external["agent_token"])[0] == 401
assert request_api("/api/v1/messages", {**external_message, "client_message_id": "after-revoke"}, external_session["session_token"])[0] == 401
assert read("/api/v1/messages?channel_id=channel", external_session["session_token"])[0] == 401
assert request_api("/api/v1/messages", {**message, "client_message_id": "not-revoked"}, session["session_token"])[0] == 201
sql(f"UPDATE owner_credentials SET revoked_at=now() WHERE token_hash=decode('{owner_digest}', 'hex');")
assert read("/api/v1/sessions?channel_id=channel", observer_token)[0] == 401
assert request_api(revoke_path, {}, owner_token)[0] == 401
assert request_api("/api/v1/invitations", invite_body, owner_token)[0] == 401
sql(f"UPDATE agent_credentials SET revoked_at=now() WHERE token_hash=decode('{digest}', 'hex');")
assert request_api("/api/v1/sessions", {**session_body, "code": "D4"}, credential)[0] == 401
assert request_api("/api/v1/messages", {**message, "client_message_id": "after-revoke"}, session["session_token"])[0] == 401
assert read("/api/v1/messages?channel_id=channel", session["session_token"])[0] == 401
print("邀請、session、訊息重送、分頁、讀寫權限及撤銷拒絕通過")
