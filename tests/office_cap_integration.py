import hashlib
import json
import os
import secrets
import subprocess
import urllib.error
import urllib.request

container = os.environ["OFFORA_TEST_DB_CONTAINER"]
database = os.environ["OFFORA_TEST_DB_NAME"]
base = os.environ["OFFORA_TEST_URL"]


def sql(query):
    return subprocess.run(["docker", "exec", "-i", container, "psql", "-U", os.environ.get("OFFORA_TEST_DB_USER", "postgres"), "-d", database, "-v", "ON_ERROR_STOP=1", "-tA"], input=query, text=True, capture_output=True, check=True).stdout.strip()


def initialize(key):
    body = {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "cap", "version": "1"}}}
    request = urllib.request.Request(f"{base}/mcp/{key}", data=json.dumps(body).encode(), headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return response.status
    except urllib.error.HTTPError as error:
        return error.code


key = secrets.token_hex(32)
assert initialize(key) == 200
key_hash = hashlib.sha256(key.encode()).hexdigest()
space = sql(f"SELECT space_id FROM auto_offices WHERE key_hash=decode('{key_hash}','hex')")
assert space
tag = key[:8]

sql(f"""
INSERT INTO agents (id,owner_id,name) SELECT '{tag}-stale-'||n,'{space}','auto' FROM generate_series(1,200) n;
INSERT INTO agent_credentials (id,agent_id,space_id,token_hash) SELECT '{tag}-stale-c-'||n,'{tag}-stale-'||n,'{space}',sha256(('{tag}-stale-'||n)::bytea) FROM generate_series(1,200) n;
INSERT INTO sessions (id,space_id,credential_id,token_hash,role,code,model,left_at) SELECT '{tag}-stale-s-'||n,'{space}','{tag}-stale-c-'||n,sha256(('{tag}-stale-s-'||n)::bytea),'AI','{tag}-stale-'||n,'test',now() FROM generate_series(1,200) n;
""")
assert initialize(key) == 200, "離開的 AI 不該佔名額"

sql(f"""
INSERT INTO agents (id,owner_id,name) SELECT '{tag}-live-'||n,'{space}','auto' FROM generate_series(1,200) n;
INSERT INTO agent_credentials (id,agent_id,space_id,token_hash) SELECT '{tag}-live-c-'||n,'{tag}-live-'||n,'{space}',sha256(('{tag}-live-'||n)::bytea) FROM generate_series(1,200) n;
""")
assert initialize(key) == 429, "仍在場或剛要加入的 AI 滿 200 要拒絕"
print("office cap integration passed")
