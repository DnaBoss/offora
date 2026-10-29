export type Session = { session_id: string, session_token: string, space_id: string }
export type Agent = { agent_token: string, space_id: string }
export type Member = { session_id: string, agent_id?: string, agent_name?: string, role: string, code: string, model: string, summary: string, heartbeat_seq: number, presence: string }
export type Message = { message_id: string, actor_session_id: string, actor_role?: string, actor_code?: string, readers?: { session_id: string, role: string, code: string }[], reply_excerpt?: string | null, conversation_id: string | null, reply_to: string | null, payload: { text: string, kind?: string, work_ref?: string, parent_work_ref?: string }, received_at: string }
export type Conversation = { conversation_id: string, summary: string, participants: string[], last_activity?: string, gathering?: boolean }
export type ChannelEvent = { schema_version: number, event_id: string, space_id: string, channel_id: string, seq: number, type: string, actor_session_id: string, actor_role: string, actor_code: string, readers: NonNullable<Message['readers']>, reply_excerpt: string | null, conversation_id: string | null, message_id: string | null, message_seq: number | null, occurred_at: string, payload: Message['payload'] | { role: string, code: string, model: string } | { presence: 'online' | 'offline' } | null, reply_to: string | null, summary: string | null, participants: string[] }
export type SendOptions = { conversation_id?: string, reply_to?: string, kind?: string, work_ref?: string, parent_work_ref?: string }
export type ReadOptions = { cursor?: string, conversation_id?: string, work_ref?: string, actor_session_id?: string }

export class OfforaError extends Error {
  constructor(public readonly status: number, message: string) { super(message) }
}

export class OfforaClient {
  readonly baseUrl: string
  private active = false
  private sequence = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private pending: Promise<void> | undefined
  private starting: Promise<void> | undefined
  private failure: unknown
  reporting = false
  constructor(baseUrl: string, readonly channelId: string, readonly sessionId: string, readonly sessionToken: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '')
  }

  private async request<T>(path: string, body?: object, token = this.sessionToken, signal?: AbortSignal): Promise<T> {
    const response = await fetch(this.baseUrl + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    })
    if (!response.ok) {
      const value = await response.json().catch(() => undefined)
      throw new OfforaError(response.status, value?.error?.message ?? '請求失敗')
    }
    const value = await response.json()
    return value as T
  }

  static async redeem(baseUrl: string, invitationToken: string): Promise<Agent> {
    return new OfforaClient(baseUrl, '', '', '').request<Agent>('/api/v1/invitations/redeem', { invitation_token: invitationToken })
  }

  static async join(baseUrl: string, channelId: string, agentToken: string, identity: { role: string, code: string, model: string, summary?: string }): Promise<OfforaClient> {
    const client = new OfforaClient(baseUrl, channelId, '', '')
    const session = await client.request<Session>('/api/v1/sessions', identity, agentToken)
    return new OfforaClient(baseUrl, channelId, session.session_id, session.session_token)
  }

  private query(values: Record<string, string | number | undefined>) {
    const params = new URLSearchParams({ channel_id: this.channelId })
    for (const [key, value] of Object.entries(values)) if (value !== undefined) params.set(key, String(value))
    return params.toString()
  }

  start() {
    if (this.active) throw new Error('在線回報已啟動')
    this.active = true
    this.failure = undefined
    this.starting = this.startReporting()
    return this.starting
  }

  private async startReporting() {
    try {
      const result = await this.listSessions()
      if (result.self_session_id !== this.sessionId) throw new Error('角色識別碼與憑證不符，或服務版本過舊')
      const member = result.sessions.find(item => item.session_id === this.sessionId)
      if (!this.active) return
      if (!member) throw new Error('此角色不在頻道成員清單中')
      this.sequence = member.heartbeat_seq
      try { await this.heartbeat(++this.sequence) }
      catch (error) {
        if (!(error instanceof OfforaError && error.status === 403)) throw error
        return
      }
      if (!this.active) return
      this.reporting = true
      this.scheduleHeartbeat()
    } catch (error) {
      this.active = false
      throw error
    }
  }

  private scheduleHeartbeat(delay = 15000) {
    if (!this.active) return
    this.timer = setTimeout(() => {
      this.pending = this.heartbeat(++this.sequence).then(() => {
        this.reporting = true
        this.scheduleHeartbeat()
      }).catch(error => {
        this.reporting = false
        if (error instanceof TypeError || (error instanceof OfforaError && (error.status === 429 || error.status >= 500))) {
          this.scheduleHeartbeat(5000)
        } else {
          this.failure = error
        }
      })
    }, delay)
  }

  check() { if (this.failure !== undefined) throw new Error('在線回報已停止', { cause: this.failure }) }

  async stop() {
    this.active = false
    if (this.timer !== undefined) clearTimeout(this.timer)
    await this.starting
    await this.pending
    this.starting = undefined
    this.timer = undefined
    this.pending = undefined
    this.reporting = false
    this.check()
  }

  send(clientMessageId: string, text: string, options: SendOptions = {}) {
    const { conversation_id, reply_to, ...extra } = options
    return this.request<{ message_id: string }>('/api/v1/messages', { schema_version: 1, client_message_id: clientMessageId, channel_id: this.channelId, ...(conversation_id === undefined ? {} : { conversation_id }), ...(reply_to === undefined ? {} : { reply_to }), payload: { text, ...extra } })
  }

  read(options: ReadOptions = {}) {
    return this.request<{ messages: Message[], next_cursor: string | null }>(`/api/v1/messages?${this.query(options)}`)
  }

  readSince(afterSeq: number, limit = 50, waitMs = 0) {
    return this.request<{ messages: (Message & { seq: number })[], next_seq: number, latest_seq: number, has_more: boolean }>(`/api/v1/messages/since?${this.query({ after_seq: afterSeq, limit, wait_ms: waitMs })}`)
  }

  readEvents(afterSeq: number, limit = 50) {
    return this.request<{ events: ChannelEvent[], next_seq: number, latest_seq: number, has_more: boolean }>(`/api/v1/events/since?${this.query({ after_seq: afterSeq, limit })}`)
  }

  async watchEvents(afterSeq: number, onEvents: (events: ChannelEvent[], nextSeq: number) => Promise<void>, signal: AbortSignal) {
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new Error('事件序號不正確')
    let cursor = afterSeq
    while (!signal.aborted) {
      try {
        const ticket = await this.request<{ ticket: string }>('/api/v1/socket-ticket', { channel_id: this.channelId, after_seq: cursor, stream: 'events' }, this.sessionToken, signal)
        if (signal.aborted) break
        const url = new URL('/api/v1/socket', this.baseUrl)
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
        await new Promise<void>((resolve, reject) => {
          const socket = new WebSocket(url, ['offora.v1', `offora.ticket.${ticket.ticket}`])
          let ready = false
          let pending = Promise.resolve()
          let finished = false
          const finish = (error?: unknown) => {
            if (finished) return
            finished = true
            signal.removeEventListener('abort', abort)
            if (error !== undefined) reject(error); else resolve()
          }
          const abort = () => socket.close()
          signal.addEventListener('abort', abort, { once: true })
          socket.onmessage = message => {
            pending = pending.then(async () => {
              const frame = JSON.parse(String(message.data)) as { type: string, after_seq?: number, events?: ChannelEvent[], next_seq?: number }
              if (frame.type === 'ready' && frame.after_seq === cursor && !ready) { ready = true; return }
              if (!ready || frame.type !== 'events' || !Array.isArray(frame.events) || !frame.events.length || frame.events.some((item, index) => item.seq !== cursor + index + 1) || typeof frame.next_seq !== 'number' || frame.next_seq !== frame.events[frame.events.length - 1].seq) throw new Error('事件資料不正確')
              try { await onEvents(frame.events, frame.next_seq) }
              catch (error) { throw new Error('事件處理失敗', { cause: error }) }
              cursor = frame.next_seq
            }).catch(error => { socket.close(); finish(error) })
          }
          socket.onerror = () => {}
          socket.onclose = () => { void pending.then(() => finish()) }
          if (signal.aborted) abort()
        })
      } catch (error) {
        if (signal.aborted) break
        if (!(error instanceof TypeError) && !(error instanceof OfforaError && (error.status === 429 || error.status >= 500))) throw error
      }
      if (!signal.aborted) await new Promise<void>(resolve => {
        const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve() }
        const timer = setTimeout(finish, 5000)
        signal.addEventListener('abort', finish, { once: true })
        if (signal.aborted) finish()
      })
    }
    return cursor
  }

  async listSessions() {
    const sessions: Member[] = []
    let cursor: string | undefined
    for (let page = 0; page < 10; page++) {
      const result = await this.request<{ self_session_id: string, sessions: Member[], next_cursor?: string | null }>(`/api/v1/sessions?${this.query({ cursor })}`)
      sessions.push(...result.sessions)
      if (!result.next_cursor) return { self_session_id: result.self_session_id, sessions }
      cursor = result.next_cursor
    }
    throw new Error('頻道成員超過 2000 位，無法完整讀取')
  }
  listConversations(status: 'active' | 'ended' | 'open' | 'closed' = 'active', paged = false, cursor?: string) { return this.request<{ conversations: Conversation[], next_cursor?: string | null }>(`/api/v1/conversations?${this.query({ status, page: paged ? 1 : undefined, cursor })}`) }
  heartbeat(sequence: number) { return this.request('/api/v1/sessions/me/heartbeat', { channel_id: this.channelId, sequence }) }
  updateSummary(summary: string) { return this.request('/api/v1/sessions/me/summary', { channel_id: this.channelId, summary }) }
  markRead(messageId: string) { return this.request<{ status: string }>('/api/v1/messages/' + encodeURIComponent(messageId) + '/read', {}) }
  beginConversation(clientMessageId: string, participants: string[], summary: string, expiresInSeconds: number) { return this.request<{ conversation_id: string }>('/api/v1/conversations', { channel_id: this.channelId, client_message_id: clientMessageId, participants, summary, expires_in_seconds: expiresInSeconds }) }
  endConversation(conversationId: string) { return this.request(`/api/v1/conversations/${encodeURIComponent(conversationId)}/end`, {}) }
  cancelConversation(conversationId: string) { return this.request(`/api/v1/conversations/${encodeURIComponent(conversationId)}/cancel`, {}) }
  async leave() { await this.stop(); return this.request('/api/v1/sessions/me/leave', {}) }
}
