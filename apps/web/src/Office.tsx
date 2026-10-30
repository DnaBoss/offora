import { useEffect, useRef, useState } from 'react'
import { Application, Assets, Container, Graphics, Rectangle, Sprite, Text, Texture, TilingSprite } from 'pixi.js'
import type { Conversation, Member } from './types'

const WORLD_WIDTH = 1280
const FIGURE_SIZE = 130
const HIP = 0.618
const LEFT_LEG_X = 0.455
const RIGHT_LEG_X = 0.55

type Parts = { upper: Texture, left: Texture, right: Texture, width: number, hip: number }
type Rig = { body: Container, upper: Sprite, left: Sprite, right: Sprite, seed: number }

function cutParts(texture: Texture): Parts {
  const width = texture.width
  const hip = Math.round(texture.height * HIP)
  const half = Math.round(width / 2)
  const frame = (x: number, y: number, w: number, h: number) => new Texture({ source: texture.source, frame: new Rectangle(x, y, w, h) })
  return { upper: frame(0, 0, width, hip), left: frame(0, hip, half, texture.height - hip), right: frame(half, hip, width - half, texture.height - hip), width, hip }
}

function buildRig(parts: Parts, texture: Texture, seed: number): Rig {
  const scaleX = FIGURE_SIZE / parts.width
  const scaleY = FIGURE_SIZE / texture.height
  const body = new Container()
  const upper = new Sprite(parts.upper)
  upper.anchor.set(0.5, 1)
  upper.scale.set(scaleX, scaleY)
  upper.y = -FIGURE_SIZE / 2 + parts.hip * scaleY
  const leg = (part: Texture, legX: number, offset: number) => {
    const sprite = new Sprite(part)
    sprite.anchor.set((legX * parts.width - offset) / part.width, 0)
    sprite.scale.set(scaleX, scaleY)
    sprite.x = (legX - 0.5) * FIGURE_SIZE
    sprite.y = upper.y
    return sprite
  }
  const left = leg(parts.left, LEFT_LEG_X, 0)
  const right = leg(parts.right, RIGHT_LEG_X, Math.round(parts.width / 2))
  body.addChild(left, right, upper)
  return { body, upper, left, right, seed }
}

function pose(rig: Rig, walking: boolean, now: number) {
  if (walking) {
    const swing = Math.sin(now / 110 + rig.seed)
    rig.left.rotation = swing * 0.5
    rig.right.rotation = -swing * 0.5
    rig.left.y = rig.upper.y - Math.max(0, swing) * 5
    rig.right.y = rig.upper.y - Math.max(0, -swing) * 5
    rig.body.y = -Math.abs(swing) * 4
    rig.body.rotation = swing * 0.03
    return
  }
  rig.left.rotation = 0
  rig.right.rotation = 0
  rig.left.y = rig.upper.y
  rig.right.y = rig.upper.y
  rig.body.rotation = 0
  rig.body.y = Math.sin(now / 450 + rig.seed) * 1.5
}

function shorten(value: string, limit: number) {
  const characters = Array.from(value)
  if (characters.length <= limit) return value
  const first = Math.ceil((limit - 1) / 2)
  const last = Math.floor((limit - 1) / 2)
  return `${characters.slice(0, first).join('')}…${characters.slice(-last).join('')}`
}

function groupLayout(width: number, conversations: Conversation[]) {
  const columns = width >= 700 ? 2 : 1
  const groupWidth = columns === 1 ? width : width * 0.46
  const perRow = Math.max(1, Math.floor(groupWidth / 160))
  const largest = Math.max(1, ...conversations.map(item => item.participants.length))
  return { columns, perRow, stride: 255 + (Math.ceil(largest / perRow) - 1) * 190 }
}

export default function Office({ members, conversations, speaking, speech, onSelect, onSelectConversation, pauseMotion }: { members: Member[], conversations: Conversation[], speaking: string[], speech: Record<string, string>, onSelect: (id: string) => void, onSelectConversation: (id: string) => void, pauseMotion: boolean }) {
  const root = useRef<HTMLDivElement>(null)
  const [loadError, setLoadError] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const world = useRef({ height: 440 })
  const positions = useRef(new Map<string, { x: number, y: number }>())
  const seats = useRef(new Map<string, number>())
  const appearances = useRef(new Map<string, number>())
  const discussionSlots = useRef(new Map<string, number>())
  useEffect(() => {
    const element = root.current
    if (!element) return
    const office = element.closest('.office') as HTMLElement | null
    if (!office) return
    let active = true
    let initialized = false
    let sceneTextures: Texture[] = []
    let motionPreference: MediaQueryList | undefined
    let motionChanged: (() => void) | undefined
    let keyDown: ((event: KeyboardEvent) => void) | undefined
    let keyUp: ((event: KeyboardEvent) => void) | undefined
    const app = new Application()
    void (async () => {
      await app.init({ backgroundAlpha: 0, resizeTo: element, antialias: false, resolution: window.devicePixelRatio || 1, autoDensity: true })
      if (!active) { app.destroy(true); return }
      initialized = true
      const textures = await Promise.all(['/assets/worker-v1.png', '/assets/worker-v2.png', '/assets/worker-v3.png', '/assets/worker-v4.png', '/assets/worker-v5.png', '/assets/worker-v6.png'].map(path => Assets.load(path)))
      const background = await Assets.load('/assets/office-background-v1.png')
      if (!active) return
      const deskTexture = new Texture({ source: background.source, frame: new Rectangle(932, 660, 205, 220) })
      const floorTexture = new Texture({ source: background.source, frame: new Rectangle(770, 280, 200, 200) })
      const parts = textures.map(texture => cutParts(texture))
      sceneTextures = [deskTexture, floorTexture, ...parts.flatMap(item => [item.upper, item.left, item.right])]
      motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)')
      setLoadError(false)
      element.appendChild(app.canvas)
      const player = new Container({ eventMode: 'none' })
      const playerSprite = new Sprite(textures[5])
      playerSprite.anchor.set(0.5)
      playerSprite.width = 130
      playerSprite.height = 130
      playerSprite.tint = 0xbfe3ff
      const playerLabel = new Text({ text: '你（觀察者）', style: { fontFamily: 'sans-serif', fontSize: 13, fontWeight: 'bold', fill: '#193241', stroke: { color: '#bfe3ff', width: 4 } } })
      playerLabel.anchor.set(0.5, 0)
      playerLabel.y = 47
      player.addChild(playerSprite, playerLabel)
      const walker = { x: -1, y: -1, tx: -1, ty: -1 }
      const pressed = new Set<string>()
      const keyAxis = () => ({
        x: (pressed.has('ArrowRight') || pressed.has('d') ? 1 : 0) - (pressed.has('ArrowLeft') || pressed.has('a') ? 1 : 0),
        y: (pressed.has('ArrowDown') || pressed.has('s') ? 1 : 0) - (pressed.has('ArrowUp') || pressed.has('w') ? 1 : 0)
      })
      const typing = (target: EventTarget | null) => target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
      const keyNames = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'w', 'a', 's', 'd']
      keyDown = (event: KeyboardEvent) => {
        const key = event.key.length === 1 ? event.key.toLowerCase() : event.key
        if (!keyNames.includes(key) || typing(event.target) || event.ctrlKey || event.metaKey || event.altKey) return
        pressed.add(key)
        walker.tx = -1
        event.preventDefault()
      }
      keyUp = (event: KeyboardEvent) => { pressed.delete(event.key.length === 1 ? event.key.toLowerCase() : event.key) }
      window.addEventListener('keydown', keyDown)
      window.addEventListener('keyup', keyUp)
      app.stage.eventMode = 'static'
      app.stage.hitArea = new Rectangle(-100000, -100000, 200000, 200000)
      app.stage.on('pointertap', event => { walker.tx = event.global.x - app.stage.x; walker.ty = event.global.y - app.stage.y })
      const walk = () => {
        const worldHeight = world.current.height
        const width = WORLD_WIDTH
        if (walker.x < 0) { walker.x = width / 2; walker.y = Math.max(100, worldHeight - 100) }
        const step = Math.min(app.ticker.deltaMS, 50) / 1000 * 280
        const axis = keyAxis()
        if (axis.x || axis.y) {
          const length = Math.hypot(axis.x, axis.y)
          walker.x += axis.x / length * step
          walker.y += axis.y / length * step
        } else if (walker.tx >= 0) {
          const dx = walker.tx - walker.x
          const dy = walker.ty - walker.y
          const distance = Math.hypot(dx, dy)
          if (distance <= step) { walker.x = walker.tx; walker.y = walker.ty; walker.tx = -1 } else { walker.x += dx / distance * step; walker.y += dy / distance * step }
        }
        walker.x = Math.max(65, Math.min(width - 65, walker.x))
        walker.y = Math.max(90, Math.min(Math.max(90, worldHeight - 60), walker.y))
        player.x = walker.x
        player.y = walker.y
        const viewWidth = app.screen.width
        const viewHeight = app.screen.height
        app.stage.x = viewWidth >= width ? (viewWidth - width) / 2 : -Math.max(0, Math.min(width - viewWidth, walker.x - viewWidth / 2))
        app.stage.y = viewHeight >= worldHeight ? (viewHeight - worldHeight) / 2 : -Math.max(0, Math.min(worldHeight - viewHeight, walker.y - viewHeight / 2))
      }
      app.ticker.add(walk)
      const redraw = () => {
        app.stage.removeChildren()
        app.ticker.stop()
        app.ticker.remove(animate)
        const width = WORLD_WIDTH
        const columns = Math.max(1, Math.floor(width / 160))
        const layout = groupLayout(width, conversations)
        const groupColumns = layout.columns
        const speakers = members.filter(member => member.presence !== 'offline' && speaking.includes(member.session_id) && !conversations.some(item => item.participants.includes(member.session_id)))
        const speakersPerRow = Math.max(1, Math.floor(width / 160))
        const groupX = (slot: number) => width * (groupColumns === 1 ? 0.5 : slot % 2 === 0 ? 0.27 : 0.73)
        const rigs: { rig: Rig, walking: boolean }[] = []
        const moves: { id: string, person: Container, from: { x: number, y: number }, to: { x: number, y: number } }[] = []
        const reducedMotion = pauseMotion || motionPreference?.matches === true
        const currentIds = new Set(conversations.map(item => item.conversation_id))
        for (const id of discussionSlots.current.keys()) if (!currentIds.has(id)) discussionSlots.current.delete(id)
        for (const [id, slot] of discussionSlots.current) if (slot >= conversations.length) discussionSlots.current.delete(id)
        for (const item of conversations) {
          if (discussionSlots.current.has(item.conversation_id)) continue
          const used = new Set(discussionSlots.current.values())
          let slot = 0
          while (used.has(slot)) slot++
          discussionSlots.current.set(item.conversation_id, slot)
        }
        const memberIds = new Set(members.map(member => member.session_id))
        for (const id of seats.current.keys()) if (!memberIds.has(id)) { seats.current.delete(id); positions.current.delete(id); appearances.current.delete(id) }
        for (const member of members) {
          if (!appearances.current.has(member.session_id)) {
            const counts = textures.map((_, index) => [...appearances.current.values()].filter(value => value === index).length)
            appearances.current.set(member.session_id, counts.indexOf(Math.min(...counts)))
          }
          if (seats.current.has(member.session_id)) continue
          const used = new Set(seats.current.values())
          let seat = 0
          while (used.has(seat)) seat++
          seats.current.set(member.session_id, seat)
        }
        const shortNames = new Map(members.map(member => [member.session_id, `${shorten(member.role, 6)} ${shorten(member.code, 10)}`]))
        const nameCounts = new Map<string, number>()
        for (const name of shortNames.values()) nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1)
        const displayName = (member: Member, index: number) => {
          const name = shortNames.get(member.session_id) ?? ''
          return (nameCounts.get(name) ?? 0) > 1 ? `${name} ·${index + 1}` : name
        }
        const totalSeats = Math.max(0, ...[...seats.current.values()].map(value => value + 1))
        const seatRows = Math.ceil(totalSeats / columns)
        const speakerRows = Math.ceil(speakers.length / speakersPerRow)
        const height = Math.max(440, 280 + Math.ceil(conversations.length / groupColumns) * layout.stride + speakerRows * 190 + Math.ceil(Math.max(members.length, totalSeats) / columns) * 190)
        world.current.height = height
        if (seatRows) {
          const floor = new TilingSprite({ texture: floorTexture, width, height: seatRows * 190 })
          floor.y = height - seatRows * 190 - 10
          app.stage.addChild(floor)
        }
        for (const member of members) {
          const index = seats.current.get(member.session_id) ?? 0
          const x = (index % columns + 0.5) * width / columns
          const y = height - 100 - (seatRows - 1 - Math.floor(index / columns)) * 190
          const desk = new Container({ x, y, eventMode: 'static', cursor: 'pointer' })
          const deskImage = new Sprite(deskTexture)
          deskImage.anchor.set(0.5)
          deskImage.y = -53
          deskImage.width = 130
          deskImage.height = 140
          desk.addChild(deskImage)
          const away = member.presence !== 'offline' && (speaking.includes(member.session_id) || conversations.some(item => item.participants.includes(member.session_id)))
          if (away) {
            const name = new Text({ text: displayName(member, index), style: { fontFamily: 'sans-serif', fontSize: 12, fontWeight: 'bold', fill: '#fff8e6', stroke: { color: '#754623', width: 3 } } })
            name.anchor.set(0.5)
            if (name.width > 120) name.scale.set(120 / name.width)
            name.y = -59
            desk.addChild(name)
          }
          desk.on('pointertap', () => onSelect(member.session_id))
          app.stage.addChild(desk)
        }
        members.forEach(member => {
          const index = seats.current.get(member.session_id) ?? 0
          const col = index % columns
          const row = Math.floor(index / columns)
          const discussionIndex = member.presence === "offline" ? -1 : conversations.findIndex(item => item.participants.includes(member.session_id))
          const discussion = conversations[discussionIndex]
          const isSpeaking = !discussion && member.presence !== 'offline' && speaking.includes(member.session_id)
          const slot = discussion ? discussionSlots.current.get(discussion.conversation_id) ?? 0 : 0
          const discussionCount = conversations.filter(item => item.participants.includes(member.session_id)).length
          const participantIndex = discussion ? discussion.participants.indexOf(member.session_id) : 0
          const participantRow = Math.floor(participantIndex / layout.perRow)
          const rowCount = discussion ? Math.min(layout.perRow, discussion.participants.length - participantRow * layout.perRow) : 1
          const speakerIndex = speakers.findIndex(item => item.session_id === member.session_id)
          const speakerRow = Math.floor(speakerIndex / speakersPerRow)
          const speakersInRow = Math.min(speakersPerRow, speakers.length - speakerRow * speakersPerRow)
          const x = discussion ? Math.max(75, Math.min(width - 75, groupX(slot) + (participantIndex % layout.perRow - (rowCount - 1) / 2) * 160)) : isSpeaking ? width * 0.5 + (speakerIndex % speakersPerRow - (speakersInRow - 1) / 2) * 160 : (col + 0.5) * width / columns
          const y = discussion ? 205 + Math.floor(slot / groupColumns) * layout.stride + participantRow * 190 : isSpeaking ? 150 + Math.ceil(conversations.length / groupColumns) * layout.stride + speakerRow * 190 : height - 100 - (seatRows - 1 - row) * 190
          const previous = positions.current.get(member.session_id) ?? { x, y }
          const person = new Container({ x: previous.x, y: previous.y, eventMode: 'static', cursor: 'pointer' })
          const look = appearances.current.get(member.session_id) ?? 0
          const rig = buildRig(parts[look], textures[look], index * 1.7)
          rig.body.alpha = member.presence === 'offline' ? 0.45 : 1
          rigs.push({ rig, walking: Math.hypot(x - previous.x, y - previous.y) > 1 })
          person.addChild(rig.body)
          const activity = discussionCount > 1 ? `（${discussionCount} 場）` : isSpeaking ? '（剛發話）' : ''
          const presence = member.presence === 'offline' ? '（離線）' : member.presence === 'reconnecting' ? '（重連中）' : ''
          const label = new Text({ text: displayName(member, index), style: { fontFamily: 'sans-serif', fontSize: 13, fontWeight: 'bold', fill: '#193241', stroke: { color: '#fff8e6', width: 4 } } })
          label.anchor.set(0.5, 0)
          if (label.width > 145) label.scale.set(145 / label.width)
          label.y = 47
          person.addChild(label)
          if (activity || presence) {
            const status = new Text({ text: `${activity}${presence}`, style: { fontFamily: 'sans-serif', fontSize: 11, fontWeight: 'bold', fill: '#193241', stroke: { color: '#fff8e6', width: 4 } } })
            status.anchor.set(0.5, 0)
            if (status.width > 145) status.scale.set(145 / status.width)
            status.y = 62
            person.addChild(status)
          }
          const message = speech[member.session_id]
          if (!message && member.presence !== 'offline' && (member.summary || member.progress !== null)) {
            if (member.summary) {
              const work = new Text({ text: shorten(member.summary, 14), style: { fontFamily: 'sans-serif', fontSize: 12, fill: '#193241', stroke: { color: '#fff8e6', width: 4 } } })
              work.anchor.set(0.5)
              if (work.width > 145) work.scale.set(145 / work.width)
              work.y = -92
              person.addChild(work)
            }
            if (member.progress !== null) {
              person.addChild(new Graphics().roundRect(-50, -80, 100, 8, 4).fill({ color: 0xe4d9c0 }).stroke({ color: 0x866b49, width: 1 }))
              if (member.progress > 0) person.addChild(new Graphics().roundRect(-50, -80, member.progress, 8, 4).fill({ color: 0x3e9b6b }))
            }
          }
          if (message && member.presence !== 'offline') {
            const characters = Array.from(message.trim().replace(/\s+/g, ' '))
            const excerpt = characters.slice(0, 22).join('') + (characters.length > 22 ? '…' : '')
            const bubbleText = new Text({ text: excerpt, style: { fontFamily: 'sans-serif', fontSize: 12, fill: '#193241', wordWrap: true, wordWrapWidth: 130, breakWords: true } })
            bubbleText.anchor.set(0.5)
            bubbleText.y = -87
            person.addChild(new Graphics().roundRect(-73, -106, 146, 38, 8).fill({ color: 0xffffff }).stroke({ color: 0x866b49, width: 1 }))
            person.addChild(bubbleText)
          }
          person.on('pointertap', () => onSelect(member.session_id))
          app.stage.addChild(person)
          moves.push({ id: member.session_id, person, from: previous, to: { x, y } })
        })
        const shortTitles = new Map(conversations.map(item => [item.conversation_id, shorten(item.summary, 10)]))
        const titleCounts = new Map<string, number>()
        for (const title of shortTitles.values()) titleCounts.set(title, (titleCounts.get(title) ?? 0) + 1)
        for (const discussion of conversations) {
          const slot = discussionSlots.current.get(discussion.conversation_id) ?? 0
          const shortTitle = shortTitles.get(discussion.conversation_id) ?? ''
          const displayTitle = (titleCounts.get(shortTitle) ?? 0) > 1 ? `${shortTitle} ·${slot + 1}` : shortTitle
          const badge = new Container({ x: groupX(slot), y: 50 + Math.floor(slot / groupColumns) * layout.stride, eventMode: 'static', cursor: 'pointer' })
          badge.addChild(new Graphics().roundRect(-75, -16, 150, 32, 6).fill({ color: 0xfff8e6 }).stroke({ color: 0x866b49, width: 1 }))
          const title = new Text({ text: displayTitle, style: { fontFamily: 'sans-serif', fontSize: 13, fill: '#193241' } })
          title.anchor.set(0.5)
          if (title.width > 138) title.scale.set(138 / title.width)
          badge.addChild(title)
          badge.on('pointertap', () => onSelectConversation(discussion.conversation_id))
          app.stage.addChild(badge)
        }
        app.stage.addChild(player)
        const started = performance.now()
        animate = () => {
          const now = performance.now()
          const progress = reducedMotion ? 1 : Math.min((now - started) / 800, 1)
          for (const move of moves) {
            move.person.x = move.from.x + (move.to.x - move.from.x) * progress
            move.person.y = move.from.y + (move.to.y - move.from.y) * progress
            positions.current.set(move.id, { x: move.person.x, y: move.person.y })
          }
          for (const item of rigs) pose(item.rig, !reducedMotion && progress < 1 && item.walking, now)
          if (reducedMotion) app.ticker.remove(animate)
        }
        animate()
        app.ticker.add(animate)
        app.ticker.start()
      }
      let animate = () => {}
      redraw()
      motionChanged = redraw
      motionPreference.addEventListener('change', motionChanged)
    })().catch(() => { if (active) setLoadError(true) })
    return () => { active = false; if (keyDown) window.removeEventListener('keydown', keyDown); if (keyUp) window.removeEventListener('keyup', keyUp); if (motionChanged) motionPreference?.removeEventListener('change', motionChanged); if (initialized) app.destroy(true); for (const texture of sceneTextures) texture.destroy(false); sceneTextures = [] }
  }, [members, conversations, speaking, speech, onSelect, onSelectConversation, pauseMotion, attempt])
  return <div className="office-canvas"><div className="office-stage" ref={root} aria-hidden="true" />{loadError && <div className="office-error" role="alert"><span>辦公室畫面載入失敗</span><button onClick={() => { setLoadError(false); setAttempt(value => value + 1) }}>重新載入畫面</button></div>}</div>
}
