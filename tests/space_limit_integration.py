import hashlib
import json
import os
import subprocess
import urllib.error
import urllib.request

container = os.environ["OFFORA_TEST_DB_CONTAINER"]
database = os.environ["OFFORA_TEST_DB_NAME"]
base = os.environ["OFFORA_TEST_URL"]
tokens = ["a" * 64, "b" * 64, "c" * 64]


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def sql(query):
    subprocess.run(["docker", "exec", "-i", container, "psql", "-U", "postgres", "-d", database, "-v", "ON_ERROR_STOP=1"], input=query, text=True, capture_output=True, check=True)


sql("INSERT INTO agent_credentials (id,agent_id,space_id,token_hash) VALUES ('limit-a','agent','space',decode('" + digest('d' * 64) + "','hex')),('limit-b','agent','extra-space',decode('" + digest('e' * 64) + "','hex'));")
sql("INSERT INTO owner_credentials (id,owner_id,token_hash) VALUES ('limit-owner','owner',decode('" + digest('1' * 64) + "','hex')); INSERT INTO invitations (id,space_id,agent_id,token_hash,expires_at,max_uses) VALUES ('limit-invite','space','agent',decode('" + digest('2' * 64) + "','hex'),now()+interval '1 hour',1);")
for index, token in enumerate(tokens):
    space, credential = ("space", "limit-a") if index < 2 else ("extra-space", "limit-b")
    sql(f"INSERT INTO sessions (id,space_id,credential_id,token_hash,role,code,model) VALUES ('limit-{index}','{space}','{credential}',decode('{digest(token)}','hex'),'test','limit-{index}','test');")


def request(token):
    req = urllib.request.Request(base + "/api/v1/messages", data=b"{}", headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=5) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as response:
        return response.code, json.load(response)


def post(path, body, token=None):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    req = urllib.request.Request(base + path, data=json.dumps(body).encode(), headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=5) as response:
            return response.status, response.headers.get("Retry-After"), json.load(response)
    except urllib.error.HTTPError as response:
        return response.code, response.headers.get("Retry-After"), json.load(response)


for index in range(1800):
    assert request(tokens[index % 2])[0] == 400
status, body = request(tokens[0])
assert status == 429 and body["error"]["code"] == "rate_limited"
assert request(tokens[2])[0] == 400
invite = {"space_id": "space", "agent_id": "agent", "channels": [{"channel_id": "channel", "read": True, "send": True, "presence": False}], "expires_in_seconds": 3600, "max_uses": 1}
for path, body, token in [
    ("/api/v1/invitations", invite, "1" * 64),
    ("/api/v1/invitations/redeem", {"invitation_token": "2" * 64}, None),
    ("/api/v1/spaces/space/channels", {"id": "blocked-channel", "name": "Blocked"}, "1" * 64),
    ("/api/v1/spaces/space/agents/agent/revoke", {}, "1" * 64),
]:
    status, retry, body = post(path, body, token)
    assert status == 429 and retry == "60" and body["error"]["retryable"] is True
result = subprocess.run(["docker", "exec", container, "psql", "-U", "postgres", "-d", database, "-tAc", "SELECT uses FROM invitations WHERE id='limit-invite'"], capture_output=True, text=True, check=True)
assert result.stdout.strip() == "0"
print("同空間 session、管理者與邀請共用額度，其他空間仍可請求")
