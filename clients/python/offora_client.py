import json
import threading
import urllib.error
import urllib.parse
import urllib.request


class OfforaClient:
    def __init__(self, base_url, channel_id, session_id, session_token):
        self.base_url = base_url.rstrip('/')
        self.channel_id = channel_id
        self.session_id = session_id
        self.session_token = session_token
        self._stop = threading.Event()
        self._thread = None
        self._failure = None
        self._sequence = 0
        self._active = False
        self.reporting = False
        self.presence_allowed = False

    def _request(self, path, body=None, token=None, timeout=10):
        data = None if body is None else json.dumps(body).encode()
        headers = {'Authorization': 'Bearer ' + (token or self.session_token)}
        if data is not None:
            headers['Content-Type'] = 'application/json'
        request = urllib.request.Request(self.base_url + path, data=data, headers=headers)
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.load(response)

    @classmethod
    def redeem(cls, base_url, invitation_token):
        client = cls(base_url, '', '', '')
        return client._request('/api/v1/invitations/redeem', {'invitation_token': invitation_token})

    @classmethod
    def join(cls, base_url, channel_id, agent_token, role, code, model, summary=''):
        client = cls(base_url, channel_id, '', '')
        session = client._request('/api/v1/sessions', {'role': role, 'code': code, 'model': model, 'summary': summary}, agent_token)
        return cls(base_url, channel_id, session['session_id'], session['session_token'])

    def __enter__(self):
        if self._active:
            raise RuntimeError('client is already running')
        self._failure = None
        self.presence_allowed = False
        result = self.list_sessions()
        if result.get('self_session_id') != self.session_id:
            raise RuntimeError('角色識別碼與憑證不符，或服務版本過舊')
        sessions = result['sessions']
        current = next((item for item in sessions if item['session_id'] == self.session_id), None)
        if current is None:
            raise RuntimeError('session is not visible in this channel')
        self._sequence = current['heartbeat_seq']
        self._stop.clear()
        try:
            self._heartbeat()
        except urllib.error.HTTPError as error:
            if error.code != 403:
                raise
            self.reporting = False
        else:
            self.presence_allowed = True
            self.reporting = True
            self._thread = threading.Thread(target=self._run, name='offora-heartbeat', daemon=True)
            self._thread.start()
        self._active = True
        return self

    def _heartbeat(self):
        self._sequence += 1
        self._request('/api/v1/sessions/me/heartbeat', {'channel_id': self.channel_id, 'sequence': self._sequence})

    def _run(self):
        delay = 15
        while not self._stop.wait(delay):
            try:
                self._heartbeat()
                self.reporting = True
                delay = 15
            except urllib.error.HTTPError as error:
                if error.code == 429 or error.code >= 500:
                    self.reporting = False
                    delay = 5
                    continue
                self._failure = error
                self.reporting = False
                self._stop.set()
            except (urllib.error.URLError, TimeoutError, OSError):
                self.reporting = False
                delay = 5
            except Exception as error:
                self._failure = error
                self.reporting = False
                self._stop.set()

    def check(self):
        if self._failure is not None:
            raise RuntimeError('online reporting stopped') from self._failure

    def send(self, client_message_id, text, conversation_id=None, reply_to=None, kind=None, work_ref=None, parent_work_ref=None):
        self.check()
        body = {'schema_version': 1, 'client_message_id': client_message_id, 'channel_id': self.channel_id, 'payload': {'text': text}}
        if conversation_id is not None:
            body['conversation_id'] = conversation_id
        if reply_to is not None:
            body['reply_to'] = reply_to
        for key, value in (('kind', kind), ('work_ref', work_ref), ('parent_work_ref', parent_work_ref)):
            if value is not None:
                body['payload'][key] = value
        return self._request('/api/v1/messages', body)

    def read(self, cursor=None, conversation_id=None, work_ref=None, actor_session_id=None):
        self.check()
        query = {'channel_id': self.channel_id}
        if cursor is not None:
            query['cursor'] = cursor
        if conversation_id is not None:
            query['conversation_id'] = conversation_id
        if work_ref is not None:
            query['work_ref'] = work_ref
        if actor_session_id is not None:
            query['actor_session_id'] = actor_session_id
        return self._request('/api/v1/messages?' + urllib.parse.urlencode(query))

    def list_sessions(self):
        self.check()
        members = []
        cursor = None
        for _ in range(10):
            query = {'channel_id': self.channel_id}
            if cursor is not None:
                query['cursor'] = cursor
            result = self._request('/api/v1/sessions?' + urllib.parse.urlencode(query))
            members.extend(result['sessions'])
            cursor = result.get('next_cursor')
            if cursor is None:
                return {'self_session_id': result['self_session_id'], 'sessions': members}
        raise RuntimeError('頻道成員超過 2000 位，無法完整讀取')

    def read_since(self, after_seq, limit=50, wait_ms=0):
        self.check()
        query = urllib.parse.urlencode({'channel_id': self.channel_id, 'after_seq': after_seq, 'limit': limit, 'wait_ms': wait_ms})
        return self._request('/api/v1/messages/since?' + query, timeout=35)

    def read_events(self, after_seq, limit=50):
        self.check()
        query = urllib.parse.urlencode({'channel_id': self.channel_id, 'after_seq': after_seq, 'limit': limit})
        return self._request('/api/v1/events/since?' + query)

    def watch_events(self, after_seq, on_events, stop_event):
        from websockets.exceptions import ConnectionClosed
        from websockets.sync.client import connect

        if isinstance(after_seq, bool) or not isinstance(after_seq, int) or after_seq < 0:
            raise ValueError('事件序號不正確')
        self.check()
        cursor = after_seq
        parts = urllib.parse.urlsplit(self.base_url)
        if parts.scheme not in ('http', 'https'):
            raise ValueError('服務網址不正確')
        url = urllib.parse.urlunsplit(('wss' if parts.scheme == 'https' else 'ws', parts.netloc, parts.path.rstrip('/') + '/api/v1/socket', '', ''))
        while not stop_event.is_set():
            try:
                ticket = self._request('/api/v1/socket-ticket', {'channel_id': self.channel_id, 'after_seq': cursor, 'stream': 'events'})['ticket']
                if stop_event.is_set():
                    break
                with connect(url, subprotocols=['offora.v1', 'offora.ticket.' + ticket], open_timeout=5, close_timeout=1) as socket:
                    ready = False
                    while not stop_event.is_set():
                        try:
                            frame = json.loads(socket.recv(timeout=1))
                        except TimeoutError:
                            continue
                        if frame.get('type') == 'ready' and frame.get('after_seq') == cursor and not ready:
                            ready = True
                            continue
                        events = frame.get('events')
                        if not ready or frame.get('type') != 'events' or not isinstance(events, list) or not events or any(item.get('seq') != cursor + index + 1 for index, item in enumerate(events)) or frame.get('next_seq') != events[-1]['seq']:
                            raise RuntimeError('事件資料不正確')
                        try:
                            on_events(events, frame['next_seq'])
                        except Exception as error:
                            raise RuntimeError('事件處理失敗') from error
                        cursor = frame['next_seq']
            except urllib.error.HTTPError as error:
                if error.code != 429 and error.code < 500:
                    raise
            except (urllib.error.URLError, ConnectionClosed, TimeoutError, OSError):
                pass
            if not stop_event.is_set():
                stop_event.wait(5)
        return cursor

    def list_conversations(self, status='active', paged=False, cursor=None):
        self.check()
        query = {'channel_id': self.channel_id, 'status': status}
        if paged:
            query['page'] = '1'
        if cursor is not None:
            query['cursor'] = cursor
        return self._request('/api/v1/conversations?' + urllib.parse.urlencode(query))

    def update_summary(self, summary):
        self.check()
        return self._request('/api/v1/sessions/me/summary', {'channel_id': self.channel_id, 'summary': summary})

    def mark_read(self, message_id):
        self.check()
        return self._request('/api/v1/messages/' + urllib.parse.quote(message_id, safe='') + '/read', {})

    def begin_conversation(self, client_message_id, participants, summary, expires_in_seconds):
        self.check()
        return self._request('/api/v1/conversations', {'channel_id': self.channel_id, 'client_message_id': client_message_id, 'participants': participants, 'summary': summary, 'expires_in_seconds': expires_in_seconds})

    def end_conversation(self, conversation_id):
        self.check()
        return self._request('/api/v1/conversations/' + urllib.parse.quote(conversation_id, safe='') + '/end', {})

    def cancel_conversation(self, conversation_id):
        self.check()
        return self._request('/api/v1/conversations/' + urllib.parse.quote(conversation_id, safe='') + '/cancel', {})

    def leave(self):
        self.check()
        self._stop.set()
        if self._thread is not None:
            self._thread.join()
            self._thread = None
        self.reporting = False
        return self._request('/api/v1/sessions/me/leave', {})

    def __exit__(self, exc_type, exc_value, traceback):
        self._stop.set()
        if self._thread is not None:
            self._thread.join()
        self._thread = None
        self._active = False
        self.reporting = False
        if exc_type is None:
            self.check()
