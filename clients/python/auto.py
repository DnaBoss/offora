import hashlib
import json
import os
import secrets
import webbrowser
import urllib.error
import urllib.request
from pathlib import Path

DEFAULT_URL = 'https://offora.exactlyone.dev'


def machine_secret():
    path = Path.home() / '.offora' / 'machine'
    if path.exists():
        return path.read_text().strip()
    path.parent.mkdir(mode=0o700, exist_ok=True)
    value = secrets.token_hex(32)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as handle:
        handle.write(value)
    return value


def office_key():
    explicit = os.environ.get('OFFORA_OFFICE_KEY')
    if explicit:
        return explicit
    return hashlib.sha256(('machine:' + machine_secret()).encode()).hexdigest()


def host_name():
    if os.environ.get('OFFORA_MODEL'):
        return os.environ['OFFORA_MODEL']
    if os.environ.get('CLAUDECODE'):
        return 'claude-code'
    if os.environ.get('CODEX_HOME') or os.environ.get('CODEX_SANDBOX'):
        return 'codex'
    return 'agent'


def post(base_url, path, body):
    request = urllib.request.Request(base_url + path, data=json.dumps(body).encode(), headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=10) as response:
        return json.load(response)


def auto_join(base_url):
    key = office_key()
    model = host_name()
    for _ in range(3):
        body = {
            'office_key': key,
            'role': os.environ.get('OFFORA_ROLE', 'AI'),
            'code': f'{model}-{secrets.token_hex(2)}',
            'model': model,
            'summary': os.environ.get('OFFORA_SUMMARY', ''),
        }
        try:
            return key, post(base_url, '/api/v1/auto/join', body)
        except urllib.error.HTTPError as error:
            if error.code != 409:
                raise
    raise RuntimeError('無法取得不重複的代號')


def watch_url(base_url, key):
    return f'{base_url}/#office={key}'


def open_once(url, key):
    marker = Path.home() / '.offora' / ('opened-' + hashlib.sha256(key.encode()).hexdigest()[:16])
    if marker.exists() or os.environ.get('OFFORA_NO_BROWSER'):
        return
    marker.parent.mkdir(mode=0o700, exist_ok=True)
    marker.touch()
    webbrowser.open(url)
