import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'

const { OfforaClient, OfforaError } = createRequire(import.meta.url)(process.env.OFFORA_TS_CLIENT)
const base = process.env.OFFORA_TEST_URL
const owner = JSON.parse(execFileSync('target/debug/offora', ['bootstrap'], { input: JSON.stringify({ owner_id: 'owner', space_id: 'space', channel_id: 'channel', agent_id: 'agent' }), encoding: 'utf8' })).owner_token
async function invite() {
  const response = await fetch(base + '/api/v1/invitations', { method: 'POST', headers: { Authorization: `Bearer ${owner}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ space_id: 'space', agent_id: 'agent', channels: [{ channel_id: 'channel', read: true, send: true, presence: true }], expires_in_seconds: 3600, max_uses: 1 }) })
  assert.equal(response.status, 201)
  return (await response.json()).invitation_token
}
const token = await invite()
const agent = await OfforaClient.redeem(base, token)
assert.equal(agent.space_id, 'space')
await assert.rejects(() => OfforaClient.redeem(base, token), error => error instanceof OfforaError && error.status === 401)
const client = await OfforaClient.join(base, 'channel', agent.agent_token, { role: '工程師', code: 'T01', model: '測試' })
await client.send('ts-intro', 'TypeScript 已加入')
const pythonInvite = await invite()
const python = `import json, os, sys, urllib.error\nfrom offora_client import OfforaClient\nx=json.load(sys.stdin)\na=OfforaClient.redeem(x['url'], x['invitation'])\nassert a['space_id']=='space'\ntry:\n OfforaClient.redeem(x['url'], x['invitation'])\n raise AssertionError('邀請碼被重複使用')\nexcept urllib.error.HTTPError as e:\n assert e.code==401\nc=OfforaClient.join(x['url'], 'channel', a['agent_token'], '工程師', 'P01', '測試')\nwrong=OfforaClient(x['url'], 'channel', x['other'], c.session_token)\ntry:\n wrong.__enter__()\n raise AssertionError('錯誤角色識別碼被接受')\nexcept RuntimeError as e:\n assert '角色識別碼與憑證不符' in str(e)\nwith c:\n c.send('python-intro','Python 已加入')\n assert len(c.read()['messages'])==2\nprint(c.session_id)\n`
const pythonId = execFileSync('python3', ['-c', python], { input: JSON.stringify({ url: base, invitation: pythonInvite, other: client.sessionId }), env: { ...process.env, PYTHONPATH: 'clients/python' }, encoding: 'utf8' }).trim()
await assert.rejects(() => new OfforaClient(base, 'channel', pythonId, client.sessionToken).start(), /角色識別碼與憑證不符/)
await client.start()
await client.stop()
assert.equal((await client.read()).messages.length, 2)
console.log('Python 與 TypeScript 兌換、加入、發話及重複兌換拒絕通過')
