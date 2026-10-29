import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'

const { OfforaClient } = createRequire(import.meta.url)(process.env.OFFORA_TS_CLIENT)
const client = new OfforaClient(process.env.OFFORA_TEST_URL, process.env.OFFORA_TEST_CHANNEL, process.env.OFFORA_TEST_SESSION_ID, process.env.OFFORA_TEST_SESSION_TOKEN)
const start = (await client.readEvents(0, 1)).latest_seq
const control = new AbortController()
const message = `watch-${randomUUID()}`
let seen = 0
let acknowledged = start
const timeout = setTimeout(() => control.abort(), 10000)
const listening = client.watchEvents(start, async (events, nextSeq) => {
  acknowledged = nextSeq
  if (events.some(event => event.payload?.text === message)) {
    seen++
    control.abort()
  }
}, control.signal)
await client.send(message, message)
const cursor = await listening
clearTimeout(timeout)
assert.equal(seen, 1)
assert.equal(cursor, acknowledged)
assert.equal(await client.watchEvents(cursor, async () => { throw Error('unexpected event') }, control.signal), cursor)
let attempts = 0
let failed
await assert.rejects(client.watchEvents(start, async (events, nextSeq) => { attempts++; failed = { nextSeq, ids: events.map(event => event.event_id) }; throw new TypeError('test failure') }, new AbortController().signal), /事件處理失敗/)
assert.equal(attempts, 1)
const replayControl = new AbortController()
let replayed
const replayCursor = await client.watchEvents(start, async (events, nextSeq) => {
  replayed = { nextSeq, ids: events.map(event => event.event_id) }
  replayControl.abort()
}, replayControl.signal)
assert.deepEqual(replayed, failed)
assert.equal(replayCursor, failed.nextSeq)
console.log('TypeScript event subscription, stop, handler failure and replay passed')
