import json
import os
import queue
import secrets
import threading
import time
import urllib.error
import urllib.request

base = os.environ['OFFORA_TEST_URL'].rstrip('/')
connections = []


def rpc(key, session, method, params=None):
    headers = {'Content-Type': 'application/json'}
    if session:
        headers['Mcp-Session-Id'] = session
    body = {'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params or {}}
    request = urllib.request.Request(f'{base}/mcp/{key}', data=json.dumps(body).encode(), headers=headers)
    with urllib.request.urlopen(request, timeout=10) as response:
        return json.load(response), response.headers


def join(key, name):
    body, headers = rpc(key, None, 'initialize', {'protocolVersion': '2025-06-18', 'capabilities': {}, 'clientInfo': {'name': name, 'version': '1'}})
    session = headers['Mcp-Session-Id']
    connections.append((key, session))
    result = body['result']
    assert 'office_roster' in result.get('_meta', {}), 'initialize must deliver office_roster before any tool call'
    assert 'office_roster' in result['instructions'] or '在線分工表' in result['instructions']
    return session, result['_meta']['office_roster']


def tool(key, session, name, arguments):
    body, _ = rpc(key, session, 'tools/call', {'name': name, 'arguments': arguments})
    result = body['result']
    assert not result['isError'], result
    return json.loads(result['content'][0]['text'])


def leave(key, session):
    request = urllib.request.Request(f'{base}/mcp/{key}', headers={'Mcp-Session-Id': session}, method='DELETE')
    with urllib.request.urlopen(request, timeout=10) as response:
        assert response.status == 204
    connections.remove((key, session))


def forbidden(key, session, expected, origin=None):
    headers = {'Mcp-Session-Id': session, 'Accept': 'text/event-stream'}
    if origin:
        headers['Origin'] = origin
    request = urllib.request.Request(f'{base}/mcp/{key}', headers=headers)
    try:
        urllib.request.urlopen(request, timeout=5)
    except urllib.error.HTTPError as error:
        assert error.code == expected, (error.code, expected)
    else:
        raise AssertionError('unauthorized stream accepted')


def receive(response, inbox):
    try:
        for raw in response:
            line = raw.decode().strip()
            if line.startswith('data:'):
                notification = json.loads(line[5:])
                assert notification['method'] == 'notifications/message'
                inbox.put(notification['params']['data'])
    except (OSError, ValueError, AssertionError) as error:
        inbox.put(error)


def until(inbox, predicate, seconds=10):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        item = inbox.get(timeout=max(0.01, deadline - time.monotonic()))
        if isinstance(item, Exception):
            raise item
        if predicate(item):
            return item
    raise AssertionError('expected roster notification missing')


stream = None
try:
    key = secrets.token_hex(32)
    other_key = secrets.token_hex(32)
    a, initial = join(key, 'roster-a')
    assert len(initial['sessions']) == 1
    a_id = initial['sessions'][0]['session_id']
    profile = tool(key, a, 'office_describe', {'goal': '維護結帳畫面', 'computer': '測試機', 'environment': 'Linux'})
    assert profile['office_roster']['sessions'][0]['goal'] == '維護結帳畫面'
    print('PASS initial roster and profile table', flush=True)

    request = urllib.request.Request(f'{base}/mcp/{key}', headers={'Mcp-Session-Id': a, 'Accept': 'text/event-stream'})
    stream = urllib.request.urlopen(request, timeout=25)
    assert stream.headers['Content-Type'].startswith('text/event-stream')
    inbox = queue.Queue()
    reader = threading.Thread(target=receive, args=(stream, inbox), daemon=True)
    reader.start()
    until(inbox, lambda item: any(m['session_id'] == a_id for m in item['office_roster']['sessions']))

    b, b_table = join(key, 'roster-b')
    assert any(m['goal'] == '維護結帳畫面' for m in b_table['sessions'])
    b_id = next(m['session_id'] for m in b_table['sessions'] if m['session_id'] != a_id)
    until(inbox, lambda item: any(m['session_id'] == b_id for m in item['joined']))
    tool(key, b, 'office_describe', {'goal': '維護付款接口', 'computer': '另一測試機', 'environment': 'Linux'})
    until(inbox, lambda item: any(m['session_id'] == b_id and m['goal'] == '維護付款接口' for m in item['updated']))
    tool(key, b, 'office_update_summary', {'summary': '付款整合測試中', 'progress': 42})
    until(inbox, lambda item: any(m['session_id'] == b_id and m['summary'] == '付款整合測試中' and m['progress'] == 42 for m in item['office_roster']['sessions']))
    print('PASS live join, responsibility and progress broadcasts', flush=True)

    outsider, outsider_table = join(other_key, 'roster-outside')
    assert len(outsider_table['sessions']) == 1 and outsider_table['sessions'][0]['session_id'] not in (a_id, b_id)
    outsider_id = outsider_table['sessions'][0]['session_id']
    forbidden(key, outsider, 404)
    forbidden(key, a, 403, 'https://evil.example')
    forbidden(key, 'invalid-session', 404)
    print('PASS cross-office, wrong-session and origin isolation', flush=True)

    repo = 'roster-' + secrets.token_hex(6)
    tool(key, a, 'office_set_repo', {'repo_url': f'https://github.com/test/{repo}'})
    notification = until(inbox, lambda item: any(m['room'] == 'repo' for m in item['office_roster']['sessions']), seconds=20)
    assert all(m['session_id'] != outsider_id for m in notification['office_roster']['sessions'])
    assert 'session_token' not in json.dumps(notification) and 'token_hash' not in json.dumps(notification)
    leave(key, b)
    notification = until(inbox, lambda item: any(m['session_id'] == b_id for m in item['left']))
    assert all(m['session_id'] not in (b_id, outsider_id) for m in notification['office_roster']['sessions'])
    print('PASS repo roster, leave broadcast and no credential disclosure', flush=True)

    body, _ = rpc(key, a, 'logging/setLevel', {'level': 'warning'})
    assert body['result'] == {}
    tool(key, a, 'office_update_summary', {'summary': '靜音通知反例', 'progress': 60})
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        try:
            muted = inbox.get(timeout=max(0.01, deadline - time.monotonic()))
        except queue.Empty:
            break
        if isinstance(muted, Exception):
            raise muted
        assert all(m['summary'] != '靜音通知反例' for m in muted['office_roster']['sessions'])
    rpc(key, a, 'logging/setLevel', {'level': 'info'})
    tool(key, a, 'office_update_summary', {'summary': '恢復通知正例', 'progress': 70})
    until(inbox, lambda item: any(m['summary'] == '恢復通知正例' for m in item['office_roster']['sessions']))
    body, _ = rpc(key, a, 'logging/setLevel', {'level': 'invalid'})
    assert body['error']['code'] == -32602
    print('PASS notification level validation', flush=True)
    print('roster integration: 5 groups passed, 0 skipped', flush=True)
finally:
    for office_key, session in list(reversed(connections)):
        leave(office_key, session)
    if stream:
        stream.close()
