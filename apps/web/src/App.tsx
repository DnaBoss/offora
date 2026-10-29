import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Office from './Office'
import Invitation from './Invitation'
import Join from './Join'
import { api, ApiError } from './api'
import type { Conversation, Member, Message } from './types'

const messageKinds: Record<string, string> = { message: '訊息', update: '進度', question: '問題', answer: '回覆', proposal: '建議' }
const connectionKey = 'offora.connection.v1'

function savedConnection(): { token: string, channel: string, observer?: boolean } | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(connectionKey) || 'null')
    return typeof value?.token === 'string' && value.token && typeof value.channel === 'string' && value.channel ? value : null
  } catch { return null }
}

export default function App() {
  const [saved] = useState(savedConnection)
  const [inviteOpen, setInviteOpen] = useState(false)
  const [joinOpen, setJoinOpen] = useState(false)
  const [token, setToken] = useState(saved?.token || '')
  const [channel, setChannel] = useState(saved?.channel || '')
  const [connected, setConnected] = useState(saved !== null)
  const [observerMode, setObserverMode] = useState(saved?.observer === true)
  const [members, setMembers] = useState<Member[]>([])
  const [conversations, setConversations] = useState<Conversation[]>([])
  const gatheringConversations = useMemo(() => {
    const present = new Set(members.filter(member => member.presence !== 'offline').map(member => member.session_id))
    return conversations.filter(item => item.gathering !== false && item.participants.some(id => present.has(id)))
  }, [members, conversations])
  const [endedConversations, setEndedConversations] = useState<Conversation[]>([])
  const [endedCursor, setEndedCursor] = useState<string | null>(null)
  const [loadingEnded, setLoadingEnded] = useState(false)
  const endedLoaded = useRef(false)
  const endedPaged = useRef(false)
  const endedHead = useRef<string | null>(null)
  const endedGapAnchor = useRef<string | null>(null)
  const [endedNotice, setEndedNotice] = useState('')
  const [messages, setMessages] = useState<Message[]>([])
  const [speaking, setSpeaking] = useState<string[]>([])
  const speakingUntil = useRef(new Map<string, number>())
  const [speech, setSpeech] = useState<Record<string, string>>({})
  const speechUntil = useRef(new Map<string, { text: string, until: number }>())
  const [olderMessages, setOlderMessages] = useState<Message[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [historyNotice, setHistoryNotice] = useState('')
  const [streamError, setStreamError] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [selectedConversation, setSelectedConversation] = useState<string | null>(null)
  const [workFilter, setWorkFilter] = useState('')
  const [workDraft, setWorkDraft] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [pauseMotion, setPauseMotion] = useState(false)
  useEffect(() => {
    let remembered: string | null = null
    try { remembered = localStorage.getItem('offora.office') } catch { remembered = null }
    const key = new URLSearchParams(location.hash.slice(1)).get('office') || remembered
    if (!key || saved !== null) return
    if (location.hash) history.replaceState(null, '', location.pathname)
    setBusy(true)
    fetch('/api/v1/auto/watch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ office_key: key }) })
      .then(async response => {
        const result = await response.json()
        if (!response.ok) throw new Error(result?.error?.message || '無法進入辦公室')
        try { localStorage.setItem('offora.office', key) } catch { void 0 }
        setToken(result.session_token); setChannel(result.channel_id); setConnected(true)
      })
      .catch(cause => setError(cause instanceof Error ? cause.message : '無法進入辦公室'))
      .finally(() => setBusy(false))
  }, [])
  useEffect(() => {
    try {
      if (connected) sessionStorage.setItem(connectionKey, JSON.stringify({ token: token.trim(), channel: channel.trim(), observer: observerMode }))
      else sessionStorage.removeItem(connectionKey)
    } catch { setError('無法保存分頁連線，重新整理後需重新輸入憑證。') }
  }, [connected, token, channel, observerMode])
  const requestSequence = useRef(0)
  const connectionGeneration = useRef(0)
  const recentMessages = useRef<Message[]>([])
  const historyStarted = useRef(false)
  const scope = useRef<{ member: string | null, conversation: string | null, workRef: string }>({ member: null, conversation: null, workRef: '' })
  const selectScope = useCallback((member: string | null, conversation: string | null, workRef = scope.current.workRef) => {
    if (scope.current.member === member && scope.current.conversation === conversation && scope.current.workRef === workRef) return
    scope.current = { member, conversation, workRef }
    requestSequence.current++; connectionGeneration.current++
    recentMessages.current = []; historyStarted.current = false
    setHistoryNotice('')
    setMessages([]); setOlderMessages([]); setNextCursor(null); setLoadingOlder(false)
    setSelected(member); setSelectedConversation(conversation); setWorkFilter(workRef)
  }, [])
  const selectMember = useCallback((id: string) => selectScope(id, null), [selectScope])
  const selectConversation = useCallback((id: string) => selectScope(null, id), [selectScope])
  const refresh = useCallback(async (currentToken: string, currentChannel: string, signal?: AbortSignal) => {
    const sequence = ++requestSequence.current
    const anchor = recentMessages.current[0]?.message_id
    const query = `?channel_id=${encodeURIComponent(currentChannel)}`
    const historyQuery = new URLSearchParams({ channel_id: currentChannel, order: 'sequence' })
    if (scope.current.member) historyQuery.set('actor_session_id', scope.current.member)
    if (scope.current.conversation) historyQuery.set('conversation_id', scope.current.conversation)
    if (scope.current.workRef) historyQuery.set('work_ref', scope.current.workRef)
    const loadMembers = async () => {
      const members: Member[] = []
      let cursor: string | null = null
      for (let page = 0; page < 10; page++) {
        const params = new URLSearchParams({ channel_id: currentChannel })
        if (cursor) params.set('cursor', cursor)
        const result = await api<{ sessions: Member[], next_cursor?: string | null }>(`/api/v1/sessions?${params}`, currentToken, { signal })
        members.push(...result.sessions)
        cursor = result.next_cursor ?? null
        if (!cursor) return { sessions: members }
      }
      throw new Error('頻道成員超過 2000 位，無法完整顯示')
    }
    const loadConversations = async () => {
      const items: Conversation[] = []
      let cursor: string | null = null
      for (let page = 0; page < 10; page++) {
        const params = new URLSearchParams({ channel_id: currentChannel, status: 'open', page: '1' })
        if (cursor) params.set('cursor', cursor)
        const result = await api<{ conversations: Conversation[], next_cursor: string | null }>(`/api/v1/conversations?${params}`, currentToken, { signal })
        items.push(...result.conversations)
        cursor = result.next_cursor
        if (!cursor) return { conversations: items.sort((a, b) => (b.last_activity ?? '').localeCompare(a.last_activity ?? '') || b.conversation_id.localeCompare(a.conversation_id)) }
      }
      throw new Error('進行中的交談超過 2000 組，無法完整顯示')
    }
    const [people, history, discussions, ended] = await Promise.all([
      loadMembers(),
      api<{ messages: Message[], next_cursor: string | null }>(`/api/v1/messages?${historyQuery}`, currentToken, { signal }),
      loadConversations(),
      api<{ conversations: Conversation[], next_cursor: string | null }>(`/api/v1/conversations${query}&status=closed&page=1`, currentToken, { signal }),
    ])
    if (signal?.aborted || sequence !== requestSequence.current) return false
    const endedBatch = [...ended.conversations]
    let endedNext = ended.next_cursor
    let endedPages = 1
    while (endedHead.current && endedNext && !endedBatch.some(item => item.conversation_id === endedHead.current) && endedPages < 10) {
      const params = new URLSearchParams({ channel_id: currentChannel, status: 'closed', page: '1', cursor: endedNext })
      const page = await api<{ conversations: Conversation[], next_cursor: string | null }>(`/api/v1/conversations?${params}`, currentToken, { signal })
      if (signal?.aborted || sequence !== requestSequence.current) return false
      endedBatch.push(...page.conversations)
      endedNext = page.next_cursor
      endedPages++
    }
    const endedGap = Boolean(endedHead.current && endedNext && !endedBatch.some(item => item.conversation_id === endedHead.current))
    let batch = history.messages
    let cursor = history.next_cursor
    let pages = 1
    if (historyStarted.current) {
      while (cursor && pages < 10 && (!anchor || !batch.some(message => message.message_id === anchor))) {
        historyQuery.set('cursor', cursor)
        const page = await api<{ messages: Message[], next_cursor: string | null }>(`/api/v1/messages?${historyQuery}`, currentToken, { signal })
        if (signal?.aborted || sequence !== requestSequence.current) return false
        batch = [...batch, ...page.messages]
        cursor = page.next_cursor
        pages++
      }
      if (cursor && (!anchor || !batch.some(message => message.message_id === anchor))) {
        recentMessages.current = []
        setOlderMessages([])
        setNextCursor(cursor)
        setHistoryNotice('新訊息較多，請載入較早訊息以查看完整紀錄。')
      } else {
        const latest = new Map(batch.map(message => [message.message_id, message]))
        batch = [...new Map([...batch, ...recentMessages.current].map(message => [message.message_id, message])).values()].map(message => latest.get(message.message_id) ?? message).sort((a, b) => b.message_seq - a.message_seq)
      }
    }
    if (batch.length > 500) {
      batch = batch.slice(0, 500)
      setOlderMessages([])
      setNextCursor(batch[batch.length - 1].message_id)
      setHistoryNotice('已保留最近 500 則，請載入較早訊息查看其他紀錄。')
    }
    setMembers(previous => JSON.stringify(previous) === JSON.stringify(people.sessions) ? previous : people.sessions)
    recentMessages.current = batch
    setMessages(previous => JSON.stringify(previous) === JSON.stringify(batch) ? previous : batch)
    if (!historyStarted.current) { setNextCursor(history.next_cursor); historyStarted.current = true }
    setConversations(previous => JSON.stringify(previous) === JSON.stringify(discussions.conversations) ? previous : discussions.conversations)
    setEndedConversations(previous => [...endedBatch, ...previous.filter(item => !endedBatch.some(current => current.conversation_id === item.conversation_id))])
    if (endedGap) { endedGapAnchor.current = endedHead.current; setEndedCursor(endedNext); endedPaged.current = true; setEndedNotice('新增的已結束交談較多，請載入較早交談查看其餘紀錄。') }
    else if (!endedLoaded.current || !endedPaged.current) setEndedCursor(ended.next_cursor)
    endedLoaded.current = true
    endedHead.current = ended.conversations[0]?.conversation_id ?? null
    return true
  }, [])
  useEffect(() => {
    if (!connected) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let cursor: number | null = null
    const currentToken = token.trim()
    const currentChannel = channel.trim()
    const readEvents = (after: number, limit: number) => {
      const query = new URLSearchParams({ channel_id: currentChannel, after_seq: String(after), limit: String(limit) })
      return api<{ latest_seq: number }>(`/api/v1/events/since?${query}`, currentToken, { signal: controller.signal })
    }
    const receive = (messages: Message[]) => {
      const now = Date.now()
      for (const message of messages) {
        if (!message.conversation_id && now - Date.parse(message.received_at) < 15000) speakingUntil.current.set(message.actor_session_id, now + 15000)
        if (now - Date.parse(message.received_at) < 15000) speechUntil.current.set(message.actor_session_id, { text: message.payload.text, until: now + 15000 })
      }
      setSpeaking([...speakingUntil.current.keys()])
      setSpeech(Object.fromEntries([...speechUntil.current].map(([id, value]) => [id, value.text])))
      const incoming = messages.filter(message => (!scope.current.member || message.actor_session_id === scope.current.member) && (!scope.current.conversation || message.conversation_id === scope.current.conversation) && (!scope.current.workRef || message.payload.work_ref === scope.current.workRef))
      if (!incoming.length) return
      let batch = [...new Map([...incoming.reverse(), ...recentMessages.current].map(message => [message.message_id, message])).values()]
      if (batch.length > 500) {
        batch = batch.slice(0, 500)
        setOlderMessages([])
        setNextCursor(batch[batch.length - 1].message_id)
        setHistoryNotice('已保留最近 500 則，請載入較早訊息查看其他紀錄。')
      }
      recentMessages.current = batch
      setMessages(batch)
    }
    const run = async () => {
      while (!controller.signal.aborted) {
        try {
          if (cursor === null) {
            const checkpoint = await readEvents(0, 1)
            if (!await refresh(currentToken, currentChannel, controller.signal)) continue
            cursor = checkpoint.latest_seq
          }
          const result = await api<{ ticket: string }>('/api/v1/socket-ticket', currentToken, { method: 'POST', body: JSON.stringify({ channel_id: currentChannel, after_seq: cursor, stream: 'events' }), signal: controller.signal })
          if (controller.signal.aborted) return
          await new Promise<void>((resolve, reject) => {
            const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
            const socket = new WebSocket(`${protocol}//${location.host}/api/v1/socket`, ['offora.v1', `offora.ticket.${result.ticket}`])
            let ready = false
            let finished = false
            const finish = (error?: Error) => {
              if (finished) return
              finished = true
              controller.signal.removeEventListener('abort', abort)
              if (error) reject(error); else resolve()
            }
            const abort = () => { socket.close(); finish() }
            controller.signal.addEventListener('abort', abort, { once: true })
            socket.onmessage = event => {
              try {
                const frame = JSON.parse(event.data) as { type: string, after_seq?: number, events?: { seq: number, type: string, message_id: string | null, message_seq: number | null, actor_session_id: string, actor_role: string, actor_code: string, readers: Message['readers'], reply_excerpt: string | null, conversation_id: string | null, reply_to: string | null, occurred_at: string, payload: Message['payload'] | null }[], next_seq?: number }
                if (frame.type === 'ready' && frame.after_seq === cursor) { ready = true; setStreamError(''); void refresh(currentToken, currentChannel, controller.signal).catch(() => { if (!controller.signal.aborted) setStreamError('交談更新失敗，正在重試。') }); return }
                if (!ready || frame.type !== 'events' || !Array.isArray(frame.events) || !frame.events.length || typeof cursor !== 'number' || frame.events.some((item, index) => item.seq !== cursor! + index + 1) || frame.next_seq !== frame.events[frame.events.length - 1].seq) throw new Error('invalid frame')
                const messages: Message[] = []
                for (const item of frame.events) {
                  if (item.type !== 'conversation.message') continue
                  if (!item.message_id || typeof item.message_seq !== 'number' || !item.payload || typeof item.payload.text !== 'string') throw new Error('invalid message')
                  messages.push({ message_id: item.message_id, message_seq: item.message_seq, actor_session_id: item.actor_session_id, actor_role: item.actor_role, actor_code: item.actor_code, readers: item.readers, reply_excerpt: item.reply_excerpt, conversation_id: item.conversation_id, reply_to: item.reply_to, received_at: item.occurred_at, payload: item.payload })
                }
                receive(messages)
                if (frame.events.some(item => item.type !== 'conversation.message')) void refresh(currentToken, currentChannel, controller.signal).then(updated => { if (updated) setStreamError('') }).catch(() => { if (!controller.signal.aborted) setStreamError('狀態更新失敗，正在重試。') })
                cursor = frame.next_seq
              } catch { socket.close(); finish(new Error('invalid message')) }
            }
            socket.onerror = () => {}
            socket.onclose = () => finish(controller.signal.aborted ? undefined : new Error('connection closed'))
          })
        } catch (cause) {
          if (controller.signal.aborted) return
          if (cause instanceof ApiError && [400, 401, 403].includes(cause.status)) {
            setStreamError(`訊息更新已停止：${cause.message}`)
            return
          }
          setStreamError('訊息更新中斷，正在重試。')
          await new Promise<void>(resolve => {
            const finish = () => { if (timer) clearTimeout(timer); controller.signal.removeEventListener('abort', finish); resolve() }
            timer = setTimeout(finish, 5000)
            controller.signal.addEventListener('abort', finish, { once: true })
          })
        }
      }
    }
    void run()
    return () => { controller.abort(); if (timer) clearTimeout(timer) }
  }, [connected, token, channel, refresh])
  useEffect(() => {
    if (!connected) { speakingUntil.current.clear(); speechUntil.current.clear(); setSpeaking([]); setSpeech({}); return }
    const timer = setInterval(() => {
      const now = Date.now()
      let changed = false
      for (const [id, until] of speakingUntil.current) if (until <= now) { speakingUntil.current.delete(id); changed = true }
      if (changed) setSpeaking([...speakingUntil.current.keys()])
      let speechChanged = false
      for (const [id, value] of speechUntil.current) if (value.until <= now) { speechUntil.current.delete(id); speechChanged = true }
      if (speechChanged) setSpeech(Object.fromEntries([...speechUntil.current].map(([id, value]) => [id, value.text])))
    }, 1000)
    return () => clearInterval(timer)
  }, [connected])
  useEffect(() => {
    if (!connected) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    const update = async () => {
      try { await refresh(token.trim(), channel.trim(), controller.signal); if (!controller.signal.aborted) setError('') }
      catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '更新失敗') }
      if (!controller.signal.aborted) timer = setTimeout(update, 5000)
    }
    timer = setTimeout(update, 5000)
    return () => { controller.abort(); clearTimeout(timer) }
  }, [connected, token, channel, refresh])
  useEffect(() => {
    if (!connected) return
    const controller = new AbortController()
    void refresh(token.trim(), channel.trim(), controller.signal).catch(cause => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '更新失敗')
    })
    return () => controller.abort()
  }, [connected, token, channel, selected, selectedConversation, workFilter, refresh])
  async function connect(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('')
    try {
      const credential = observerMode ? (await api<{ session_token: string }>('/api/v1/observers', token.trim(), { method: 'POST', body: JSON.stringify({ channel_id: channel.trim() }) })).session_token : token.trim()
      await refresh(credential, channel.trim()); setToken(credential); setConnected(true)
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : '連線失敗') }
    finally { setBusy(false) }
  }
  async function reload() {
    setBusy(true); setError('')
    try { await refresh(token.trim(), channel.trim()) }
    catch (cause) { setError(cause instanceof Error ? cause.message : '更新失敗') }
    finally { setBusy(false) }
  }
  async function loadOlder() {
    if (!nextCursor) return
    const generation = connectionGeneration.current
    setLoadingOlder(true); setError('')
    try {
      const query = new URLSearchParams({ channel_id: channel.trim(), cursor: nextCursor, order: 'sequence' })
      if (scope.current.member) query.set('actor_session_id', scope.current.member)
      if (scope.current.conversation) query.set('conversation_id', scope.current.conversation)
      if (scope.current.workRef) query.set('work_ref', scope.current.workRef)
      const history = await api<{ messages: Message[], next_cursor: string | null }>(`/api/v1/messages?${query}`, token.trim())
      if (generation !== connectionGeneration.current) return
      setOlderMessages(previous => [...previous, ...history.messages])
      if (!history.next_cursor) setHistoryNotice('')
      setNextCursor(history.next_cursor)
    } catch (cause) { if (generation === connectionGeneration.current) setError(cause instanceof Error ? cause.message : '讀取較早訊息失敗') }
    finally { if (generation === connectionGeneration.current) setLoadingOlder(false) }
  }
  async function loadOlderConversations() {
    if (!endedCursor || loadingEnded) return
    const generation = connectionGeneration.current
    setLoadingEnded(true)
    try {
      const params = new URLSearchParams({ channel_id: channel.trim(), status: 'closed', page: '1', cursor: endedCursor })
      const result = await api<{ conversations: Conversation[], next_cursor: string | null }>(`/api/v1/conversations?${params}`, token.trim())
      if (generation !== connectionGeneration.current) return
      setEndedConversations(previous => [...new Map([...previous, ...result.conversations].map(item => [item.conversation_id, item])).values()])
      if (endedGapAnchor.current && (result.conversations.some(item => item.conversation_id === endedGapAnchor.current) || !result.next_cursor)) { endedGapAnchor.current = null; setEndedNotice('') }
      endedPaged.current = true
      setEndedCursor(result.next_cursor)
    } catch (cause) { if (generation === connectionGeneration.current) setError(cause instanceof Error ? cause.message : '讀取較早交談失敗') }
    finally { setLoadingEnded(false) }
  }
  function disconnect() { if (connected && observerMode) void api('/api/v1/sessions/me/leave', token.trim(), { method: 'POST', body: '{}' }).catch(() => setError('觀察連線未能正常結束，請稍後再試。')); setObserverMode(false); requestSequence.current++; connectionGeneration.current++; scope.current = { member: null, conversation: null, workRef: '' }; recentMessages.current = []; historyStarted.current = false; endedLoaded.current = false; endedPaged.current = false; endedHead.current = null; endedGapAnchor.current = null; setEndedNotice(''); setEndedCursor(null); setLoadingEnded(false); setHistoryNotice(''); setStreamError(''); setConnected(false); setToken(''); setChannel(''); setMembers([]); setMessages([]); setOlderMessages([]); setNextCursor(null); setLoadingOlder(false); setConversations([]); setEndedConversations([]); setSelected(null); setSelectedConversation(null); setWorkFilter(''); setWorkDraft(''); setError('') }
  const selectedMember = members.find(member => member.session_id === selected)
  const currentConversation = [...conversations, ...endedConversations].find(item => item.conversation_id === selectedConversation)
  const allMessages = [...new Map([...messages, ...olderMessages].map(message => [message.message_id, message])).values()]
  const selectedHistory = allMessages.find(message => message.actor_session_id === selected && message.actor_role && message.actor_code)
  const selectedLabel = selectedMember ? `${selectedMember.role} ${selectedMember.code}` : selectedHistory ? `${selectedHistory.actor_role} ${selectedHistory.actor_code}（已離開）` : selected ? '已離開的成員' : '全部成員'
  const visible = selectedConversation ? allMessages.filter(message => message.conversation_id === selectedConversation) : selected ? allMessages.filter(message => message.actor_session_id === selected) : allMessages
  return <div className="app">
    <header className="top"><div className="brand"><span className="brand-icon">✣</span> AI OFFICE</div><div className="top-space">{connected ? channel : '尚未選擇頻道'}</div><div className="top-right"><span className={connected ? 'dot green' : 'dot'} />{connected ? '資料已載入' : '尚未載入'}<button className="outline" onClick={() => { setJoinOpen(false); setInviteOpen(true) }}>邀請 AI</button><button className="outline" onClick={() => { setInviteOpen(false); setJoinOpen(true) }}>受邀加入</button>{connected && <button className="outline" onClick={disconnect}>切換頻道</button>}</div></header>
    {inviteOpen ? <Invitation channel={channel} onClose={() => setInviteOpen(false)} /> : joinOpen ? <Join onClose={() => setJoinOpen(false)} onEnter={(nextToken, nextChannel) => { disconnect(); setToken(nextToken); setChannel(nextChannel); setConnected(true); setJoinOpen(false) }} /> : !connected ? <main className="connect-wrap"><div className="connect-card"><h1>{busy ? '進入辦公室…' : 'AI OFFICE'}</h1>{error && <p className="error" role="alert">{error}</p>}</div></main> : <div className="layout">
      <aside className="sidebar"><h2>協作空間</h2><div className="active-channel">⌂　{channel}</div><div className="sidebar-heading">進行中的交談 <span>{conversations.length}</span></div>{conversations.map(item => <button key={item.conversation_id} className={`member ${selectedConversation === item.conversation_id ? 'selected' : ''}`} onClick={() => selectScope(null, item.conversation_id)}>{item.summary}{item.gathering === false ? "（已停止集合）" : ""}</button>)}<div className="sidebar-heading">已結束的交談 <span>{endedConversations.length}</span></div>{endedConversations.map(item => <button key={item.conversation_id} className={`member ${selectedConversation === item.conversation_id ? "selected" : ""}`} onClick={() => selectScope(null, item.conversation_id)}>{item.summary}</button>)}{endedNotice && <p className="sidebar-note" role="status">{endedNotice}</p>}{endedCursor && <button className="member" onClick={loadOlderConversations} disabled={loadingEnded}>{loadingEnded ? "讀取中…" : "載入較早交談"}</button>}<div className="sidebar-heading">頻道成員 <span>{members.length}</span></div><button className={`member ${!selected && !selectedConversation ? 'selected' : ''}`} onClick={() => selectScope(null, null)}>全部成員</button>{members.map((member, index) => <button key={member.session_id} className={`member ${selected === member.session_id ? 'selected' : ''}`} onClick={() => selectMember(member.session_id)}><span className={`avatar avatar-${index % 4}`}>{member.code.slice(0, 1)}</span><span>{member.role} {member.code} {conversations.filter(item => item.participants.includes(member.session_id)).length > 1 && <small>（{conversations.filter(item => item.participants.includes(member.session_id)).length} 場交談）</small>} <small>{({ online: "在線", reconnecting: "重連中", offline: "離線", unknown: "未回報" } as const)[member.presence]}{member.presence !== "offline" && speaking.includes(member.session_id) && !conversations.some(item => item.participants.includes(member.session_id)) ? "・剛發話" : ""}</small></span></button>)}<p className="sidebar-note">在線狀態依 AI 定期回報顯示</p></aside>
      <main className="main"><div className="view-bar"><strong>辦公室</strong><span>{members.length} 位成員</span><button onClick={() => setPauseMotion(value => !value)} aria-pressed={pauseMotion}>{pauseMotion ? "恢復動畫" : "暫停動畫"}</button><button onClick={reload} disabled={busy}>更新資料</button></div><div className="office"><Office members={members} conversations={gatheringConversations} speaking={speaking} speech={speech} onSelect={selectMember} onSelectConversation={selectConversation} pauseMotion={pauseMotion} /></div><div className="status-strip"><span>● 成員資料</span><span>{gatheringConversations.length} 組正在集合</span><span>{streamError || "訊息持續更新；成員每 5 秒更新"}</span></div><div className="activity"><strong>最近訊息</strong><span>{messages.length ? `目前載入 ${messages.length} 則` : '尚無訊息'}</span></div></main>
      <aside className="conversation"><div className="conversation-head"><h2>交談紀錄</h2><span>{currentConversation?.summary ?? (selectedConversation ? '已結束的交談' : selectedLabel)}</span>{(selected || selectedConversation) && <button onClick={() => selectScope(null, null)}>顯示全部</button>}</div>{selectedMember && <div className="profile"><strong>{selectedMember.role} {selectedMember.code}</strong><span>AI 身分：{selectedMember.agent_name || "尚未提供"}{selectedMember.agent_id ? `（${selectedMember.agent_id}）` : ""}</span><span>模型：{selectedMember.model}</span><span>最後回報：{selectedMember.last_heartbeat_at ? new Date(selectedMember.last_heartbeat_at).toLocaleString("zh-TW") : "尚未回報"}</span><span>{selectedMember.summary || '尚無工作摘要'}</span></div>}<form className="work-filter" onSubmit={event => { event.preventDefault(); selectScope(selected, selectedConversation, workDraft.trim()) }}><label htmlFor="work-filter">工作參照</label><div><input id="work-filter" maxLength={128} value={workDraft} onChange={event => setWorkDraft(event.target.value)} placeholder="輸入工作參照" /><button>篩選</button>{workFilter && <button type="button" onClick={() => { setWorkDraft(''); selectScope(selected, selectedConversation, '') }}>清除</button>}</div></form><div className="messages" aria-live="polite">{historyNotice && <p role="status">{historyNotice}</p>}{nextCursor && <button className="load-older" onClick={loadOlder} disabled={loadingOlder}>{loadingOlder ? "讀取中…" : "載入較早訊息"}</button>}{visible.length === 0 ? <p className="empty">沒有符合的訊息</p> : [...visible].reverse().map(message => { const author = members.find(member => member.session_id === message.actor_session_id); const original = message.reply_to ? allMessages.find(item => item.message_id === message.reply_to) : undefined; const kind = typeof message.payload.kind === 'string' && Object.prototype.hasOwnProperty.call(messageKinds, message.payload.kind) ? messageKinds[message.payload.kind] : undefined; const work = typeof message.payload.work_ref === 'string' ? message.payload.work_ref : ''; const parentWork = typeof message.payload.parent_work_ref === 'string' ? message.payload.parent_work_ref : ''; return <article className="message" key={message.message_id}><div><button className="message-author" onClick={() => selectMember(message.actor_session_id)} aria-label={`查看 ${message.actor_role && message.actor_code ? `${message.actor_role} ${message.actor_code}` : author ? `${author.role} ${author.code}` : '此成員'}的訊息`}>{message.actor_role && message.actor_code ? `${message.actor_role} ${message.actor_code}` : author ? `${author.role} ${author.code}` : '其他成員'}</button><time>{new Date(message.received_at).toLocaleString('zh-TW')}</time></div>{(kind || work || parentWork) && <div className="message-meta">{kind && <span>{kind}</span>}{work && <span>工作：{work}</span>}{parentWork && <span>上層工作：{parentWork}</span>}</div>}{message.reply_to && <div className="reply-reference">{original ? `回覆：${original.payload.text.slice(0, 100)}` : message.reply_excerpt != null ? `回覆：${message.reply_excerpt}` : '回覆其他訊息'}</div>}<p>{message.payload.text}</p>{Boolean(message.readers?.length) && <div className="message-meta">已讀：{message.readers?.map(reader => `${reader.role} ${reader.code}`).join("、")}</div>}</article> })}</div>{error && <p className="error" role="alert">{error}</p>}<p className="footer-note">顯示已保存的訊息；訊息送達不代表對方已讀。</p></aside>
    </div>}
  </div>
}
