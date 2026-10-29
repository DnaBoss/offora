import os
import sys
import threading
import uuid

sys.path.insert(0, 'clients/python')
from offora_client import OfforaClient

client = OfforaClient(os.environ['OFFORA_TEST_URL'], os.environ['OFFORA_TEST_CHANNEL'], os.environ['OFFORA_TEST_SESSION_ID'], os.environ['OFFORA_TEST_SESSION_TOKEN'])
start = client.read_events(0, 1)['latest_seq']
stop = threading.Event()
received = threading.Event()
result = []
seen = []
acknowledged = []
message = 'watch-' + uuid.uuid4().hex


def handle(events, next_seq):
    acknowledged.append(next_seq)
    for event in events:
        if (event['payload'] or {}).get('text') == message:
            seen.append(event['seq'])
            received.set()


def run():
    try:
        result.append(client.watch_events(start, handle, stop))
    except Exception as error:
        result.append(error)


worker = threading.Thread(target=run, daemon=True)
worker.start()
client.send(message, message)
assert received.wait(10), result
stop.set()
worker.join(5)
assert not worker.is_alive()
assert len(seen) == 1 and result == [acknowledged[-1]] and result[0] >= seen[0]
assert client.watch_events(result[0], handle, stop) == result[0]

calls = []


def fail(events, next_seq):
    calls.append((next_seq, [event['event_id'] for event in events]))
    raise OSError('test failure')


try:
    client.watch_events(start, fail, threading.Event())
    raise AssertionError('handler error was ignored')
except RuntimeError as error:
    assert str(error) == '事件處理失敗' and len(calls) == 1

replayed = []
replay_stop = threading.Event()


def replay(events, next_seq):
    replayed.append((next_seq, [event['event_id'] for event in events]))
    replay_stop.set()


assert client.watch_events(start, replay, replay_stop) == calls[0][0]
assert replayed == calls
print('Python event subscription, stop, handler failure and replay passed')
