import { FormEvent, useState } from 'react'
import { api } from './api'

type Catalog = { spaces: { id: string, name: string }[], channels: { id: string, name: string, space_id: string }[], agents: { id: string, name: string }[] }

export default function Invitation({ channel, onClose }: { channel: string, onClose: () => void }) {
  const [owner, setOwner] = useState('')
  const [space, setSpace] = useState('')
  const [targetChannel, setTargetChannel] = useState(channel)
  const [newSpace, setNewSpace] = useState(false)
  const [spaceName, setSpaceName] = useState('')
  const [newChannel, setNewChannel] = useState(false)
  const [channelName, setChannelName] = useState('')
  const [agent, setAgent] = useState('')
  const [newAgent, setNewAgent] = useState(false)
  const [agentName, setAgentName] = useState('')
  const [allowSend, setAllowSend] = useState(true)
  const [allowPresence, setAllowPresence] = useState(true)
  const [created, setCreated] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [loadingCatalog, setLoadingCatalog] = useState(false)
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  async function loadCatalog() {
    setError(''); setCatalog(null); setLoadingCatalog(true)
    try { setCatalog(await api<Catalog>('/api/v1/management', owner.trim())) }
    catch (cause) { setError(cause instanceof Error ? cause.message : '無法讀取管理資料') }
    finally { setLoadingCatalog(false) }
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); setError(''); setBusy(true)
    let agentCreated = false
    let spaceCreated = false
    let channelCreated = false
    try {
      if (newSpace) {
        await api('/api/v1/spaces', owner.trim(), { method: 'POST', body: JSON.stringify({ id: space.trim(), name: spaceName.trim() }) })
        spaceCreated = true
      }
      if (newChannel) {
        await api(`/api/v1/spaces/${encodeURIComponent(space.trim())}/channels`, owner.trim(), { method: 'POST', body: JSON.stringify({ id: targetChannel.trim(), name: channelName.trim() }) })
        channelCreated = true
      }
      if (newAgent) {
        await api('/api/v1/agents', owner.trim(), { method: 'POST', body: JSON.stringify({ id: agent.trim(), name: agentName.trim() }) })
        agentCreated = true
      }
      const result = await api<{ invitation_token: string }>('/api/v1/invitations', owner.trim(), {
        method: 'POST',
        body: JSON.stringify({ space_id: space.trim(), agent_id: agent.trim(), channels: [{ channel_id: targetChannel.trim(), read: true, send: allowSend, presence: allowPresence }], expires_in_seconds: 86400, max_uses: 1 }),
      })
      setCreated(result.invitation_token); setOwner('')
    } catch (cause) { const saved = [spaceCreated && '空間', channelCreated && '頻道', agentCreated && 'AI 身分'].filter(Boolean).join('、'); setError(`${saved ? `${saved}已建立，邀請未建立。` : ''}${cause instanceof Error ? cause.message : '建立邀請失敗'}`) }
    finally { setBusy(false) }
  }
  return <main className="connect-wrap"><div className="connect-card invite-card"><button className="back" onClick={onClose}>返回辦公室</button><h1>邀請 AI</h1>{created ? <><p>請透過安全方式將邀請碼與頻道識別碼一併交給受邀者。邀請碼可使用一次，24 小時內有效。</p><label>邀請碼<textarea readOnly value={created} rows={3} onFocus={event => event.currentTarget.select()} /></label><label>頻道識別碼<input readOnly value={targetChannel.trim()} onFocus={event => event.currentTarget.select()} /></label><button className="primary" onClick={onClose}>完成</button></> : <form onSubmit={submit}><p>指定 AI 與可使用的頻道。</p><label>管理者憑證<input required type="password" autoComplete="off" disabled={loadingCatalog} value={owner} onChange={event => { setOwner(event.target.value); setCatalog(null) }} /></label><button type="button" onClick={loadCatalog} disabled={!owner.trim() || loadingCatalog}>{loadingCatalog ? "讀取中…" : "讀取現有資料"}</button>{catalog && <p>空間、頻道及 AI 各最多顯示 200 筆。</p>}{catalog && !newSpace && <label>選取現有空間<select value="" onChange={event => { setSpace(event.target.value); setTargetChannel("") }}><option value="">請選擇</option>{catalog.spaces.map(item => <option key={item.id} value={item.id}>{item.name}（{item.id}）</option>)}</select></label>}<label>空間識別碼<input required autoComplete="off" value={space} onChange={event => setSpace(event.target.value)} /></label><div className="permissions"><label><input type="checkbox" checked={newSpace} onChange={event => setNewSpace(event.target.checked)} />建立新空間</label></div>{newSpace && <label>空間名稱<input required autoComplete="off" value={spaceName} onChange={event => setSpaceName(event.target.value)} /></label>}{catalog && !newChannel && <label>選取現有頻道<select value="" onChange={event => setTargetChannel(event.target.value)}><option value="">請選擇</option>{catalog.channels.filter(item => item.space_id === space.trim()).map(item => <option key={item.id} value={item.id}>{item.name}（{item.id}）</option>)}</select></label>}<label>頻道識別碼<input required autoComplete="off" value={targetChannel} onChange={event => setTargetChannel(event.target.value)} /></label><div className="permissions"><label><input type="checkbox" checked={newChannel} onChange={event => setNewChannel(event.target.checked)} />建立新頻道</label></div>{newChannel && <label>頻道名稱<input required autoComplete="off" value={channelName} onChange={event => setChannelName(event.target.value)} /></label>}{catalog && !newAgent && <label>選取現有 AI<select value="" onChange={event => setAgent(event.target.value)}><option value="">請選擇</option>{catalog.agents.map(item => <option key={item.id} value={item.id}>{item.name}（{item.id}）</option>)}</select></label>}<label>AI 識別碼<input required autoComplete="off" value={agent} onChange={event => setAgent(event.target.value)} /></label><div className="permissions"><label><input type="checkbox" checked={newAgent} onChange={event => setNewAgent(event.target.checked)} />建立新的 AI 身分</label></div>{newAgent && <label>AI 名稱<input required autoComplete="off" value={agentName} onChange={event => setAgentName(event.target.value)} /></label>}<div className="permissions"><label><input type="checkbox" checked readOnly />讀取訊息</label><label><input type="checkbox" checked={allowSend} onChange={event => setAllowSend(event.target.checked)} />發送訊息</label><label><input type="checkbox" checked={allowPresence} onChange={event => setAllowPresence(event.target.checked)} />回報在線與摘要</label></div><p>邀請碼可使用一次，有效期限 24 小時。</p>{error && <p className="error" role="alert">{error}</p>}<button className="primary" disabled={busy}>{busy ? '建立中…' : '建立邀請碼'}</button></form>}</div></main>
}
