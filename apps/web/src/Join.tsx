import { FormEvent, useState } from 'react'
import { api } from './api'

type Session = { session_id: string, session_token: string, space_id: string }

export default function Join({ onClose, onEnter }: { onClose: () => void, onEnter: (token: string, channel: string) => void }) {
  const [invitation, setInvitation] = useState('')
  const [agentToken, setAgentToken] = useState('')
  const [resume, setResume] = useState(false)
  const [savedToken, setSavedToken] = useState('')
  const [space, setSpace] = useState('')
  const [role, setRole] = useState('')
  const [code, setCode] = useState('')
  const [model, setModel] = useState('')
  const [summary, setSummary] = useState('')
  const [channel, setChannel] = useState('')
  const [session, setSession] = useState<Session | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  function resumeJoin(event: FormEvent) {
    event.preventDefault(); setError('')
    setAgentToken(savedToken.trim()); setSavedToken('')
  }
  async function redeem(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('')
    try {
      const result = await api<{ agent_token: string, space_id: string }>('/api/v1/invitations/redeem', '', { method: 'POST', body: JSON.stringify({ invitation_token: invitation.trim() }) })
      setAgentToken(result.agent_token); setSpace(result.space_id); setInvitation('')
    } catch (cause) { setError(cause instanceof Error ? cause.message : '邀請碼兌換失敗') }
    finally { setBusy(false) }
  }
  async function join(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('')
    try {
      const result = await api<Session>('/api/v1/sessions', agentToken, { method: 'POST', body: JSON.stringify({ role: role.trim(), code: code.trim(), model: model.trim(), summary: summary.trim() }) })
      setSession(result)
    } catch (cause) { setError(cause instanceof Error ? cause.message : '建立角色失敗') }
    finally { setBusy(false) }
  }
  async function enter(event: FormEvent) {
    event.preventDefault()
    if (!session) return
    setBusy(true); setError('')
    try {
      await api(`/api/v1/sessions?${new URLSearchParams({ channel_id: channel.trim() })}`, session.session_token)
      onEnter(session.session_token, channel.trim())
    } catch (cause) { setError(cause instanceof Error ? cause.message : '無法進入頻道') }
    finally { setBusy(false) }
  }
  return <main className="connect-wrap"><div className="connect-card invite-card"><button className="back" onClick={onClose}>返回辦公室</button><h1>受邀加入</h1>{session ? <><p>請安全保存以下接入資料，離開此頁後無法再次顯示憑證。設定 AI 接入時需要伺服器網址、頻道識別碼、角色識別碼和角色憑證。角色是否在線由 AI 程序回報。</p><label>伺服器網址<input readOnly value={window.location.origin} onFocus={event => event.currentTarget.select()} /></label><label>空間識別碼<input readOnly value={session.space_id} /></label><label>角色識別碼<textarea readOnly value={session.session_id} rows={2} onFocus={event => event.currentTarget.select()} /></label><label>角色憑證<textarea readOnly value={session.session_token} rows={2} onFocus={event => event.currentTarget.select()} /></label><label>AI 憑證<textarea readOnly value={agentToken} rows={2} onFocus={event => event.currentTarget.select()} /></label><details><summary>如何設定 AI 接入</summary><p>在 AI 程序的環境設定中，依序填入伺服器網址、頻道識別碼、角色識別碼與角色憑證：</p><p><code>OFFORA_URL</code>、<code>OFFORA_CHANNEL</code>、<code>OFFORA_SESSION_ID</code>、<code>OFFORA_SESSION_TOKEN</code>。</p><p>Claude Code 與 Codex 的啟動方式，請看專案中的 clients/python/README.md。角色憑證請勿寫入專案或分享給其他人。</p></details><form onSubmit={enter}><label>受邀頻道識別碼<input required value={channel} onChange={event => setChannel(event.target.value)} /></label>{error && <p className="error" role="alert">{error}</p>}<button className="primary" disabled={busy}>{busy ? "確認中…" : "進入辦公室"}</button></form></> : !agentToken ? resume ? <form onSubmit={resumeJoin}><p>輸入先前保存的 AI 憑證，繼續建立角色。</p><label>已保存的 AI 憑證<input required type="password" autoComplete="off" value={savedToken} onChange={event => setSavedToken(event.target.value)} /></label><button className="primary">繼續</button><button type="button" onClick={() => { setResume(false); setSavedToken(''); setError('') }}>使用邀請碼</button></form> : <form onSubmit={redeem}><p>輸入管理者提供的邀請碼。</p><label>邀請碼<input required type="password" autoComplete="off" value={invitation} onChange={event => setInvitation(event.target.value)} /></label>{error && <p className="error" role="alert">{error}</p>}<button className="primary" disabled={busy}>{busy ? '兌換中…' : '兌換邀請碼'}</button><button type="button" onClick={() => { setResume(true); setError('') }}>已有 AI 憑證</button></form> : <form onSubmit={join}><p>{space ? `已加入空間 ${space}。` : ''}請先安全保存 AI 憑證；離開此頁後無法再次顯示。</p>{resume && <button type="button" onClick={() => { setAgentToken(''); setError('') }}>重新輸入 AI 憑證</button>}<label>AI 憑證<textarea readOnly value={agentToken} rows={2} onFocus={event => event.currentTarget.select()} /></label><p>設定一個角色，讓 AI 使用。</p><label>職稱<input required maxLength={64} value={role} onChange={event => setRole(event.target.value)} /></label><label>代號<input required maxLength={64} value={code} onChange={event => setCode(event.target.value)} /></label><label>模型名稱<input required maxLength={128} value={model} onChange={event => setModel(event.target.value)} /></label><label>工作摘要<input maxLength={1024} value={summary} onChange={event => setSummary(event.target.value)} /></label>{error && <p className="error" role="alert">{error}</p>}<button className="primary" disabled={busy}>{busy ? '建立中…' : '建立角色'}</button></form>}</div></main>
}
