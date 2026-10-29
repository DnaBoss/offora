import { execFileSync } from 'node:child_process'

const base = process.env.OFFORA_TEST_URL
const token = process.env.OFFORA_TEST_SESSION_TOKEN
const sessionId = process.env.OFFORA_TEST_SESSION_ID
const readOnlyToken = process.env.OFFORA_TEST_READONLY_TOKEN
const container = process.env.OFFORA_TEST_DB_CONTAINER
const database = process.env.OFFORA_TEST_DB_NAME
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

async function get(path) {
  const response = await fetch(base + path, { headers })
  if (!response.ok) throw new Error(`read failed: ${response.status}`)
  return response.json()
}

async function post(path, body) {
  const response = await fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) })
  return { status: response.status, body: await response.json() }
}

async function issue(after) {
  const result = await post('/api/v1/socket-ticket', { channel_id: 'channel', after_seq: after })
  if (result.status !== 201) throw new Error(`ticket failed: ${result.status}`)
  return result.body.ticket
}

function connect(ticket, watchState = false) {
  return new Promise((resolve, reject) => {
    const url = base.replace(/^http/, 'ws') + '/api/v1/socket' + (watchState === 2 ? '?state=2' : watchState ? '?state=1' : '')
    const ws = new WebSocket(url, ['offora.v1', `offora.ticket.${ticket}`])
    const messages = []
    const waiters = []
    ws.onmessage = event => {
      const message = JSON.parse(event.data)
      if (waiters.length) waiters.shift()(message)
      else messages.push(message)
    }
    ws.onerror = () => reject(new Error('socket rejected'))
    ws.onopen = () => resolve({ ws, next: () => messages.length ? Promise.resolve(messages.shift()) : new Promise(done => waiters.push(done)) })
  })
}

async function timed(promise) {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('socket timeout')), 5000) })])
  } finally {
    clearTimeout(timer)
  }
}

async function send(id) {
  const result = await post('/api/v1/messages', { schema_version: 1, client_message_id: id, channel_id: 'channel', payload: { text: id } })
  if (result.status !== 201) throw new Error(`send failed: ${result.status}`)
}

async function command(socket, requestId, body, operation = 'send_message') {
  socket.ws.send(JSON.stringify({ request_id: requestId, operation, body }))
  for (;;) {
    const frame = await timed(socket.next())
    if (frame.type === 'response' && frame.request_id === requestId) return frame
  }
}

function setRead(value) {
  const sql = `UPDATE channel_grants SET can_read=${value} WHERE channel_id='channel' AND credential_id=(SELECT credential_id FROM sessions WHERE id='${sessionId}')`
  execFileSync('docker', ['exec', container, 'psql', '-U', 'postgres', '-d', database, '-v', 'ON_ERROR_STOP=1', '-c', sql], { stdio: 'ignore' })
}

const baseline = await get('/api/v1/messages/since?channel_id=channel&after_seq=0&limit=1')
const ticket = await issue(baseline.latest_seq)
const first = await connect(ticket)
if (first.ws.protocol !== 'offora.v1' || (await timed(first.next())).after_seq !== baseline.latest_seq) throw new Error('wrong handshake')
const watching = await connect(await issue(baseline.latest_seq), true)
await timed(watching.next())
let watchedEvents = 0
let legacyEvents = 0
watching.ws.addEventListener('message', event => { if (JSON.parse(event.data).type === 'conversation_changed') watchedEvents++ })
first.ws.addEventListener('message', event => { if (JSON.parse(event.data).type === 'conversation_changed') legacyEvents++ })
const otherBody = { channel_id: 'private-channel', client_message_id: 'socket-other-conversation', participants: [sessionId], summary: '其他頻道', expires_in_seconds: 60 }
const otherConversation = await post('/api/v1/conversations', otherBody)
if (otherConversation.status !== 201) throw new Error('other conversation failed')
await new Promise(resolve => setTimeout(resolve, 250))
if (watchedEvents !== 0 || legacyEvents !== 0) throw new Error('other channel notification leaked')
const conversationBody = { ...otherBody, channel_id: 'channel', client_message_id: 'socket-conversation', summary: '目前頻道' }
const conversation = await post('/api/v1/conversations', conversationBody)
if (conversation.status !== 201 || (await timed(watching.next())).type !== 'conversation_changed') throw new Error('conversation notification missing')
if ((await post('/api/v1/conversations', conversationBody)).status !== 200) throw new Error('conversation retry failed')
await new Promise(resolve => setTimeout(resolve, 250))
if (watchedEvents !== 1 || legacyEvents !== 0) throw new Error('retry or legacy notification incorrect')
if ((await post('/api/v1/conversations/' + conversation.body.conversation_id + '/end', {})).status !== 200 || (await timed(watching.next())).type !== 'conversation_changed') throw new Error('end notification missing')
const members = await connect(await issue(baseline.latest_seq), 2)
await timed(members.next())
let memberEvents = 0
let oldMemberEvents = 0
members.ws.addEventListener('message', event => { if (JSON.parse(event.data).type === 'member_changed') memberEvents++ })
watching.ws.addEventListener('message', event => { if (JSON.parse(event.data).type === 'member_changed') oldMemberEvents++ })
const summaryBody = { channel_id: 'channel', summary: '即時摘要' }
if ((await post('/api/v1/sessions/me/summary', summaryBody)).status !== 200 || (await timed(members.next())).type !== 'member_changed') throw new Error('summary notification missing')
if ((await post('/api/v1/sessions/me/summary', summaryBody)).status !== 200) throw new Error('summary retry failed')
await new Promise(resolve => setTimeout(resolve, 250))
if (memberEvents !== 1 || oldMemberEvents !== 0) throw new Error('summary retry or old version notification incorrect')
execFileSync('docker', ['exec', container, 'psql', '-U', 'postgres', '-d', database, '-v', 'ON_ERROR_STOP=1', '-c', `UPDATE sessions SET last_heartbeat_at=now()-interval '31 seconds' WHERE id='${sessionId}'`], { stdio: 'ignore' })
const own = (await get('/api/v1/sessions?channel_id=channel')).sessions.find(item => item.session_id === sessionId)
const heartbeat = { channel_id: 'channel', sequence: own.heartbeat_seq + 1 }
if ((await post('/api/v1/sessions/me/heartbeat', heartbeat)).status !== 200 || (await timed(members.next())).type !== 'member_changed') throw new Error('online notification missing')
if ((await post('/api/v1/sessions/me/heartbeat', { ...heartbeat, sequence: heartbeat.sequence + 1 })).status !== 200) throw new Error('regular heartbeat failed')
await new Promise(resolve => setTimeout(resolve, 250))
if (memberEvents !== 2 || oldMemberEvents !== 0) throw new Error('regular heartbeat or old version notification incorrect')
members.ws.close()
watching.ws.close()
await post('/api/v1/conversations/' + otherConversation.body.conversation_id + '/end', {})
await send('socket-live')
const message = await timed(first.next())
if (message.messages.length !== 1 || message.next_seq !== baseline.latest_seq + 1) throw new Error('missing live message')
const body = { schema_version: 1, client_message_id: 'socket-write', channel_id: 'channel', payload: { text: '由連線發話' } }
const written = await command(first, 'write-1', body)
if (written.status !== 201 || !written.body.message_id) throw new Error('socket send failed')
if ((await command(first, 'read-1', { message_id: written.body.message_id }, 'mark_read')).status !== 200) throw new Error('socket read acknowledgement failed')
if ((await post('/api/v1/messages/' + written.body.message_id + '/read', {})).status !== 200) throw new Error('HTTP retry of socket acknowledgement failed')
if ((await command(first, 'read-invalid', { message_id: 'bad' }, 'mark_read')).status !== 400) throw new Error('invalid acknowledgement accepted')
if ((await command(first, 'read-forged', { message_id: written.body.message_id, session_id: 'other' }, 'mark_read')).status !== 400) throw new Error('forged reader accepted')
const privateMessage = await post('/api/v1/messages', { ...body, channel_id: 'private-channel', client_message_id: 'socket-private-read' })
if (privateMessage.status !== 201) throw new Error('private message failed')
if ((await command(first, 'read-other-channel', { message_id: privateMessage.body.message_id }, 'mark_read')).status !== 403) throw new Error('cross-channel acknowledgement accepted')
const repeated = await command(first, 'write-2', body)
if (repeated.status !== 200 || repeated.body.message_id !== written.body.message_id) throw new Error('socket retry changed message')
const httpRepeated = await post('/api/v1/messages', body)
if (httpRepeated.status !== 200 || httpRepeated.body.message_id !== written.body.message_id) throw new Error('HTTP and socket retry differ')
if ((await command(first, 'write-3', { ...body, payload: { text: '不同內容' } })).status !== 409) throw new Error('conflicting retry accepted')
if ((await command(first, 'write-4', { ...body, client_message_id: 'forged', actor_session_id: 'fake' })).status !== 400) throw new Error('forged sender accepted')
if ((await command(first, 'write-5', { ...body, client_message_id: 'cross-channel', channel_id: 'other-channel' })).status !== 403) throw new Error('cross-channel send accepted')
if ((await command(first, 'write-missing', { schema_version: 1, client_message_id: 'missing-channel', payload: { text: '測試' } })).status !== 400) throw new Error('missing channel accepted')
if ((await command(first, 'write-6', { ...body, client_message_id: 'large-valid', payload: { text: 'a'.repeat(16384) } })).status !== 201) throw new Error('valid large message rejected')
if ((await command(first, 'write-7', { ...body, client_message_id: 'large-invalid', payload: { text: 'a'.repeat(16385) } })).status !== 413) throw new Error('oversized text accepted')
const latest = (await get('/api/v1/messages/since?channel_id=channel&after_seq=0&limit=1')).latest_seq
const readonlyResponse = await fetch(base + '/api/v1/socket-ticket', { method: 'POST', headers: { ...headers, Authorization: `Bearer ${readOnlyToken}` }, body: JSON.stringify({ channel_id: 'channel', after_seq: latest }) })
if (readonlyResponse.status !== 201) throw new Error('read-only ticket rejected')
const readonlySocket = await connect((await readonlyResponse.json()).ticket)
await timed(readonlySocket.next())
if ((await command(readonlySocket, 'readonly-read', { message_id: written.body.message_id }, 'mark_read')).status !== 200) throw new Error('read-only acknowledgement failed')
const acknowledged = (await get('/api/v1/messages?channel_id=channel')).messages.find(item => item.message_id === written.body.message_id)
if (acknowledged.readers.length !== 2 || !acknowledged.readers.some(item => item.session_id === sessionId)) throw new Error('acknowledgements not persisted')
if ((await command(readonlySocket, 'read-only-send', { ...body, client_message_id: 'read-only-send' })).status !== 403) throw new Error('read-only sender accepted')
readonlySocket.ws.close()
let replayRejected = false
try { await connect(ticket) } catch { replayRejected = true }
if (!replayRejected) throw new Error('ticket reuse accepted')
if ((await post('/api/v1/socket-ticket', { channel_id: 'other-channel', after_seq: 0 })).status !== 403) throw new Error('uninvited channel accepted')
if ((await post('/api/v1/socket-ticket', { channel_id: 'channel', after_seq: latest + 1 })).status !== 400) throw new Error('future cursor accepted')
const raceTicket = await issue(latest)
const races = await Promise.allSettled([connect(raceTicket), connect(raceTicket)])
const opened = races.filter(result => result.status === 'fulfilled')
if (opened.length !== 1) throw new Error('ticket race accepted more than once')
opened[0].value.ws.close()
const expiredTicket = await issue(latest)
execFileSync('docker', ['exec', container, 'psql', '-U', 'postgres', '-d', database, '-v', 'ON_ERROR_STOP=1', '-c', `UPDATE socket_tickets SET expires_at=now()-interval '1 second' WHERE session_id='${sessionId}'`], { stdio: 'ignore' })
let expiredRejected = false
try { await connect(expiredTicket) } catch { expiredRejected = true }
if (!expiredRejected) throw new Error('expired ticket accepted')
first.ws.close()
for (let index = 0; index < 3; index++) await send(`socket-offline-${index}`)
const second = await connect(await issue(latest))
await timed(second.next())
const recovered = await timed(second.next())
if (recovered.messages.length !== 3 || recovered.next_seq !== latest + 3) throw new Error('missing reconnect messages')
const eventAnchor = (await get('/api/v1/events/since?channel_id=channel&after_seq=0&limit=1')).latest_seq
async function eventSocket(after) {
  const ticket = await post('/api/v1/socket-ticket', { channel_id: 'channel', after_seq: after, stream: 'events' })
  if (ticket.status !== 201) throw new Error('event ticket failed')
  const socket = await connect(ticket.body.ticket)
  if ((await timed(socket.next())).after_seq !== after) throw new Error('event handshake failed')
  return socket
}
const eventLive = await eventSocket(eventAnchor)
const eventConversation = await post('/api/v1/conversations', { channel_id: 'channel', client_message_id: 'event-socket-conversation', participants: [sessionId], summary: '事件連線', expires_in_seconds: 300 })
if (eventConversation.status !== 201) throw new Error('event conversation failed')
const liveFrame = await timed(eventLive.next())
if (liveFrame.type !== 'events' || liveFrame.events[0].type !== 'conversation.intent') throw new Error('event stream missing conversation')
eventLive.ws.close()
if ((await post('/api/v1/conversations/' + eventConversation.body.conversation_id + '/end', {})).status !== 200) throw new Error('event end failed')
const eventResume = await eventSocket(liveFrame.next_seq)
const eventReplay = await timed(eventResume.next())
if (eventReplay.type !== 'events' || eventReplay.events[0].type !== 'conversation.ended' || eventReplay.events[0].seq !== liveFrame.next_seq + 1) throw new Error('event reconnect missing')
eventResume.ws.close()
try {
  setRead('false')
  const closed = new Promise(resolve => { second.ws.onclose = () => resolve(true) })
  if (!await timed(closed)) throw new Error('revoked connection remains')
} finally {
  setRead('true')
}
console.log('即時訊息、票證重用拒絕、斷線補讀及撤銷後關閉通過')
