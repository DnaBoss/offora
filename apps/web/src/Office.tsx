import { useEffect, useRef, useState } from 'react'
import { Application, Assets, Container, Graphics, Rectangle, Sprite, Text, Texture, TilingSprite } from 'pixi.js'
import type { Conversation, Member } from './types'
import { Grid, along, length, type Point, type Rect } from './navigation'
import { hash } from './layout'
import { SCENE_PROPS, OFFICE_PROPS, footprint, WALL_HEIGHT, WALK_LIMIT_TOP, BAY_WIDTH, ROOM_TOP, ROOM_BOTTOM, WALL_THICK, ZOOM, SIT_LIFT, BENCH_MIN_ROWS, benchRow, benchItems, sceneItems, type SceneName, type RoomKind } from './scene'

const SIZES = [1920, 2560, 3840, 5120, 7680]
const DEFAULT_SIZE = 3840
const MIN_HEIGHT = 2160
const storedSize = () => { try { const value = Number(localStorage.getItem('offora.office.width')); return SIZES.includes(value) ? value : DEFAULT_SIZE } catch { return DEFAULT_SIZE } }
const FIGURE_SIZE = 130
const ROOM_HEIGHT = 580
const WALL_SCALE = 0.29
const FRAME_WIDTH = 160
const FRAME_HEIGHT = 256
const FIGURE_PIXELS = 236
const FEET_Y = 0
const BODY_MID = 65
const WALK_SEQUENCE = [0, 1, 2, 1]
const WALK_STEP_MS = 130
const WALK_SPEED = 260

type Facing = 'down' | 'up' | 'side'
type Rig = { body: Container, sprite: Sprite, facing: Facing, frames: Record<Facing, Texture[]>, seed: number, seated: boolean, cut: Graphics }

const FACING_ROW: Record<Facing, number> = { down: 0, up: 1, side: 2 }

function cutFrames(source: Texture): Record<Facing, Texture[]> {
  const row = (index: number) => [0, 1, 2].map(column => new Texture({ source: source.source, frame: new Rectangle(column * FRAME_WIDTH, index * FRAME_HEIGHT, FRAME_WIDTH, FRAME_HEIGHT) }))
  return { down: row(FACING_ROW.down), up: row(FACING_ROW.up), side: row(FACING_ROW.side) }
}

function buildRig(frames: Record<Facing, Texture[]>, seed: number, tint = 0xffffff): Rig {
  const body = new Container()
  const sprite = new Sprite(frames.down[1])
  sprite.anchor.set(0.5, 1)
  sprite.scale.set(FIGURE_SIZE / FIGURE_PIXELS)
  sprite.y = FEET_Y
  sprite.tint = tint
  const cut = new Graphics().rect(-100, -250, 200, 216).fill({ color: 0xffffff })
  body.addChild(sprite)
  return { body, sprite, facing: 'down', frames, seed, seated: false, cut }
}

function face(rig: Rig, dx: number, dy: number) {
  const facing: Facing = Math.abs(dy) > Math.abs(dx) ? (dy < 0 ? 'up' : 'down') : 'side'
  rig.body.scale.x = facing === 'side' && dx < 0 ? -1 : 1
  rig.facing = facing
}

function pose(rig: Rig, walking: boolean, now: number) {
  if (rig.seated && !walking) {
    if (!rig.cut.parent) rig.body.addChild(rig.cut)
    rig.body.mask = rig.cut
  } else if (rig.cut.parent) {
    rig.body.mask = null
    rig.body.removeChild(rig.cut)
  }
  if (rig.seated && !walking) {
    rig.facing = 'up'
    rig.body.scale.x = 1
    rig.sprite.texture = rig.frames.up[Math.floor(now / 260 + rig.seed) % 2 === 0 ? 0 : 2]
    rig.body.y = 0
    return
  }
  if (!walking && rig.facing !== 'down') face(rig, 0, 1)
  if (walking) {
    const step = Math.floor(now / WALK_STEP_MS + rig.seed) % WALK_SEQUENCE.length
    rig.sprite.texture = rig.frames[rig.facing][WALK_SEQUENCE[step]]
    rig.body.y = step % 2 === 0 ? 0 : -2
    return
  }
  rig.sprite.texture = rig.frames.down[1]
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
  const [size, setSize] = useState(storedSize)
  const world = useRef({ height: 440, spawnY: 340, width: size })
  const positions = useRef(new Map<string, { x: number, y: number }>())
  const seats = useRef(new Map<string, number>())
  const navigation = useRef<Grid | null>(null)
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
      await app.init({ background: 0x1b2a35, resizeTo: element, antialias: false, resolution: window.devicePixelRatio || 1, autoDensity: true })
      if (!active) { app.destroy(true); return }
      initialized = true
      const textures = await Promise.all([1, 2, 3, 4, 5, 6].map(number => `/assets/people-v${number}.png`).map(path => Assets.load(path)))
      const floorTexture = await Assets.load('/assets/floor-v1.png')
      if (!active) return
      const scene = Object.fromEntries(await Promise.all([...SCENE_PROPS.map(name => [name, `/assets/scene-v1/${name}.png`]), ...OFFICE_PROPS.map(name => [name, `/assets/office-v2/${name}.png`])].map(async ([name, url]) => [name, await Assets.load(url)]))) as Record<SceneName, Texture>
      const parts = textures.map(texture => cutFrames(texture))
      sceneTextures = [...parts.flatMap(item => [...item.down, ...item.up, ...item.side])]
      motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)')
      setLoadError(false)
      element.appendChild(app.canvas)
      const player = new Container({ eventMode: 'none' })
      const playerRig = buildRig(parts[5], 3.1, 0xbfe3ff)
      const playerLabel = new Text({ text: '你（觀察者）', style: { fontFamily: 'sans-serif', fontSize: 13, fontWeight: 'bold', fill: '#193241', stroke: { color: '#bfe3ff', width: 4 } } })
      playerLabel.anchor.set(0.5, 0)
      playerLabel.y = 4
      player.addChild(playerRig.body, playerLabel)
      const walker = { x: -1, y: -1, route: [] as Point[] }
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
        walker.route = []
        event.preventDefault()
      }
      keyUp = (event: KeyboardEvent) => { pressed.delete(event.key.length === 1 ? event.key.toLowerCase() : event.key) }
      window.addEventListener('keydown', keyDown)
      window.addEventListener('keyup', keyUp)
      app.stage.eventMode = 'static'
      app.stage.hitArea = new Rectangle(-100000, -100000, 200000, 200000)
      app.stage.on('pointertap', event => {
        const grid = navigation.current
        if (grid) walker.route = grid.path({ x: walker.x, y: walker.y }, { x: (event.global.x - app.stage.x) / ZOOM, y: (event.global.y - app.stage.y) / ZOOM }).slice(1)
      })
      const walk = () => {
        const grid = navigation.current
        if (!grid) return
        const worldHeight = world.current.height
        const width = world.current.width
        if (walker.x < 0) { const start = grid.nearestFree({ x: width / 2, y: world.current.spawnY }); walker.x = start.x; walker.y = start.y }
        const step = Math.min(app.ticker.deltaMS, 50) / 1000 * 280
        const axis = keyAxis()
        const others = [...positions.current.values()]
        const here = { x: walker.x, y: walker.y }
        let next = here
        if (axis.x || axis.y) {
          walker.route = []
          const size = Math.hypot(axis.x, axis.y)
          next = grid.move(here, axis.x / size * step, axis.y / size * step, others)
        } else if (walker.route.length) {
          const target = walker.route[0]
          const distance = Math.hypot(target.x - here.x, target.y - here.y)
          const dx = distance <= step ? target.x - here.x : (target.x - here.x) / distance * step
          const dy = distance <= step ? target.y - here.y : (target.y - here.y) / distance * step
          next = grid.move(here, dx, dy, others)
          if (next === here) walker.route = []
          else if (distance <= step) walker.route.shift()
        }
        const walking = next.x !== here.x || next.y !== here.y
        if (walking) face(playerRig, next.x - here.x, next.y - here.y)
        walker.x = next.x
        walker.y = next.y
        pose(playerRig, walking, performance.now())
        player.x = walker.x
        player.y = walker.y
        player.zIndex = walker.y
        element.dataset.player = `${Math.round(walker.x)},${Math.round(walker.y)}`
        const viewWidth = app.screen.width
        const viewHeight = app.screen.height
        const follow = (view: number, size: number, at: number) => size * ZOOM <= view ? (view - size * ZOOM) / 2 : Math.min(0, Math.max(view - size * ZOOM, view / 2 - at * ZOOM))
        app.stage.scale.set(ZOOM)
        app.stage.x = follow(viewWidth, world.current.width, walker.x)
        app.stage.y = follow(viewHeight, world.current.height, walker.y - BODY_MID)
        element.dataset.camera = `${Math.round(app.stage.x)},${Math.round(app.stage.y)}`
        const room = element.closest('.office') as HTMLElement | null
        room?.style.setProperty('--wx', `${app.stage.x}px`)
        room?.style.setProperty('--wy', `${app.stage.y}px`)
      }
      app.ticker.add(walk)
      const redraw = () => {
        app.stage.removeChildren()
        app.ticker.stop()
        app.ticker.remove(animate)
        const width = size
        world.current.width = width
        app.stage.sortableChildren = true
        const layout = groupLayout(width, conversations)
        const groupColumns = layout.columns
        const speakers = members.filter(member => member.presence !== 'offline' && speaking.includes(member.session_id) && !conversations.some(item => item.participants.includes(member.session_id)))
        const speakersPerRow = Math.max(1, Math.floor(width / 160))
        const groupX = (slot: number) => width * (groupColumns === 1 ? 0.5 : slot % 2 === 0 ? 0.27 : 0.73)
        const moves: { id: string, person: Container, rig: Rig, path: Point[], total: number, seated: boolean, chair: number }[] = []
        const obstacles: Rect[] = []
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
        for (const member of members) if (member.presence === 'offline') seats.current.delete(member.session_id)
        const needed = Math.max(members.filter(member => member.presence !== 'offline').length, ...[...seats.current.values()].map(value => value + 1))
        let bench = benchItems(width, BENCH_MIN_ROWS)
        while (bench.seats.length < needed) bench = benchItems(width, bench.rows + 1)
        for (const member of members) {
          if (!appearances.current.has(member.session_id)) {
            const counts = textures.slice(0, 5).map((_, index) => [...appearances.current.values()].filter(value => value === index).length)
            appearances.current.set(member.session_id, counts.indexOf(Math.min(...counts)))
          }
          if (member.presence === 'offline') { seats.current.delete(member.session_id); continue }
          if (seats.current.has(member.session_id)) continue
          const used = new Set(seats.current.values())
          let seat = -1
          for (let i = 0; i < bench.seats.length; i++) if (!used.has(i) && (seat < 0 || hash(i * 7 + 3) < hash(seat * 7 + 3))) seat = i
          seats.current.set(member.session_id, seat)
        }
        const shortNames = new Map(members.map(member => [member.session_id, `${shorten(member.role, 6)} ${shorten(member.code, 10)}`]))
        const nameCounts = new Map<string, number>()
        for (const name of shortNames.values()) nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1)
        const displayName = (member: Member, index: number) => {
          const name = shortNames.get(member.session_id) ?? ''
          return (nameCounts.get(name) ?? 0) > 1 ? `${name} ·${index + 1}` : name
        }
        const speakerRows = Math.ceil(speakers.length / speakersPerRow)
        const height = Math.max(MIN_HEIGHT, ROOM_HEIGHT + 280 + Math.ceil(conversations.length / groupColumns) * layout.stride + speakerRows * 190, benchRow(bench.rows - 1) + 180)
        world.current.height = height
        world.current.spawnY = ROOM_BOTTOM + 70
        const floor = new TilingSprite({ texture: floorTexture, width, height: height - WALL_HEIGHT })
        floor.y = WALL_HEIGHT
        floor.zIndex = -3
        app.stage.addChild(floor)
        const wall = new TilingSprite({ texture: scene['wall-tile'], width, height: WALL_HEIGHT })
        wall.tileScale.set(WALL_SCALE)
        wall.zIndex = -2
        app.stage.addChild(wall)
        for (let i = 0; i < Math.max(1, Math.round(width / BAY_WIDTH)); i++) {
          const windowSprite = new Sprite(scene.window)
          windowSprite.anchor.set(0.5, 0)
          windowSprite.scale.set(WALL_SCALE)
          windowSprite.position.set((i + 0.5) * width / Math.max(1, Math.round(width / BAY_WIDTH)), 42)
          windowSprite.zIndex = -2
          app.stage.addChild(windowSprite)
        }
        const addSprite = (texture: Texture, x: number, bottom: number, displayHeight: number, zIndex: number) => {
          const sprite = new Sprite(texture)
          sprite.anchor.set(0.5, 1)
          sprite.scale.set(displayHeight / texture.height)
          sprite.position.set(x, bottom)
          sprite.zIndex = zIndex
          app.stage.addChild(sprite)
          return sprite
        }
        const built = sceneItems(width, bench)
        const occupied = new Set([...seats.current.values()].map(index => `${bench.seats[index].x},${bench.seats[index].chair}`))
        for (const item of built.items) {
          const sprite = addSprite(scene[item.name], item.x, item.bottom, item.height, item.layer === 'rug' ? -1 : item.layer === 'top' ? 1000000 : item.bottom)
          const blocked = item.solid ? footprint(item.name, sprite.x, sprite.y, sprite.width, sprite.height) : undefined
          if (blocked && !occupied.has(`${item.x},${item.bottom}`)) obstacles.push(blocked)
        }
        const ROOM_TINT: Record<RoomKind, number> = { pantry: 0xf5e6c4, meeting: 0xcfe0ea, lounge: 0xe8c7cf, focus: 0xd6e3cf }
        for (const room of built.rooms) {
          const tint = new Graphics().rect(room.x, ROOM_TOP, room.w, ROOM_BOTTOM - ROOM_TOP).fill({ color: ROOM_TINT[room.kind], alpha: 0.38 })
          tint.zIndex = -2.5
          app.stage.addChild(tint)
        }
        const frame = new Graphics().rect(-8, -8, width + 16, height + 16).stroke({ color: 0x8a6a45, width: 16 })
        frame.zIndex = 2000000
        app.stage.addChild(frame)
        const RAIL = 0x5f7f92
        for (const wall of built.walls) {
          const { x, y, w, h } = wall.rect
          const drawn = new Graphics()
          if (!wall.face) drawn.rect(x + 3, y, w - 6, h).fill({ color: 0xe9dcc0 }).rect(x + 3, y, w - 6, 3).fill({ color: 0xfbf3df }).rect(x + 3, y, w - 6, h).stroke({ color: 0x8a6a45, width: 1 })
          else if (wall.style === 'glass') {
            drawn.rect(x, y - 30, w, 34).fill({ color: 0xcfe7f1, alpha: 0.3 }).rect(x, y - 30, w, 3).fill({ color: RAIL }).rect(x, y + 1, w, 3).fill({ color: RAIL })
            for (let post = x; post <= x + w; post += 72) drawn.rect(post, y - 30, 3, 34).fill({ color: RAIL })
          } else drawn.rect(x, y - 14, w, 26).fill({ color: 0xd9b27a }).rect(x, y - 14, w, 4).fill({ color: 0xf0d2a0 }).rect(x, y + 8, w, 4).fill({ color: 0x8a5a30 })
          drawn.zIndex = ROOM_BOTTOM + 40
          app.stage.addChild(drawn)
          obstacles.push(wall.rect)
        }
        for (const screen of built.screens) {
          const { x, y, w, h } = screen.rect
          const drawn = new Graphics().rect(x, y, w, h).fill({ color: 0x9fb89a }).stroke({ color: 0x5f7a5a, width: 2 })
          drawn.zIndex = y + h
          app.stage.addChild(drawn)
          obstacles.push({ x, y: y + h - 30, w, h: 30 })
        }
        obstacles.push({ x: 0, y: 0, w: width, h: WALK_LIMIT_TOP })
        const grid = new Grid({ left: 65, right: width - 65, top: WALK_LIMIT_TOP, bottom: Math.max(WALK_LIMIT_TOP, height - 60) }, obstacles)
        navigation.current = grid
        element.dataset.obstacles = JSON.stringify(obstacles)
        members.filter(member => member.presence !== 'offline').forEach(member => {
          const index = seats.current.get(member.session_id) ?? 0
          const spot = bench.seats[index]
          const seat = { x: spot.x, y: spot.chair - SIT_LIFT }
          const discussionIndex = conversations.findIndex(item => item.participants.includes(member.session_id))
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
          const x = discussion ? Math.max(75, Math.min(width - 75, groupX(slot) + (participantIndex % layout.perRow - (rowCount - 1) / 2) * 160)) : isSpeaking ? width * 0.5 + (speakerIndex % speakersPerRow - (speakersInRow - 1) / 2) * 160 : seat.x
          const y = discussion ? ROOM_HEIGHT + 205 + Math.floor(slot / groupColumns) * layout.stride + participantRow * 190 : isSpeaking ? ROOM_HEIGHT + 150 + Math.ceil(conversations.length / groupColumns) * layout.stride + speakerRow * 190 : seat.y
          const previous = positions.current.get(member.session_id) ?? { x, y }
          const person = new Container({ x: previous.x, y: previous.y, eventMode: 'static', cursor: 'pointer' })
          const look = appearances.current.get(member.session_id) ?? 0
          const rig = buildRig(parts[look], index * 1.7)
          person.addChild(rig.body)
          const activity = discussionCount > 1 ? `（${discussionCount} 場）` : isSpeaking ? '（剛發話）' : ''
          const presence = member.presence === 'reconnecting' ? '（重連中）' : ''
          const label = new Text({ text: displayName(member, index), style: { fontFamily: 'sans-serif', fontSize: 13, fontWeight: 'bold', fill: '#193241', stroke: { color: '#fff8e6', width: 4 } } })
          label.anchor.set(0.5, 0)
          if (label.width > 145) label.scale.set(145 / label.width)
          label.y = 4
          person.addChild(label)
          if (activity || presence) {
            const status = new Text({ text: `${activity}${presence}`, style: { fontFamily: 'sans-serif', fontSize: 11, fontWeight: 'bold', fill: '#193241', stroke: { color: '#fff8e6', width: 4 } } })
            status.anchor.set(0.5, 0)
            if (status.width > 145) status.scale.set(145 / status.width)
            status.y = -6
            person.addChild(status)
          }
          const message = speech[member.session_id]
          if (message && member.presence !== 'offline') {
            const characters = Array.from(message.trim().replace(/\s+/g, ' '))
            const excerpt = characters.slice(0, 22).join('') + (characters.length > 22 ? '…' : '')
            const bubbleText = new Text({ text: excerpt, style: { fontFamily: 'sans-serif', fontSize: 12, fill: '#193241', wordWrap: true, wordWrapWidth: 130, breakWords: true } })
            bubbleText.anchor.set(0.5)
            bubbleText.y = -155
            person.addChild(new Graphics().roundRect(-73, -174, 146, 38, 8).fill({ color: 0xffffff }).stroke({ color: 0x866b49, width: 1 }))
            person.addChild(bubbleText)
          }
          person.on('pointertap', () => onSelect(member.session_id))
          app.stage.addChild(person)
          const note = new Text({ text: member.summary ? shorten(member.summary, 30) : '尚未回報工作', style: { fontFamily: 'sans-serif', fontSize: 12, fill: member.summary ? '#193241' : '#7d8b92', wordWrap: true, wordWrapWidth: 122, breakWords: true, lineHeight: 15 } })
          note.position.set(-61, 6)
          const cardHeight = 12 + note.height + (member.progress !== null ? 20 : 0)
          const card = new Container({ x: spot.x, y: spot.desk - 118 - cardHeight, eventMode: 'static', cursor: 'pointer' })
          card.addChild(new Graphics().roundRect(-68, 0, 136, cardHeight, 6).fill({ color: 0xfffdf5, alpha: 0.95 }).stroke({ color: 0x866b49, width: 1 }))
          card.addChild(new Graphics().circle(60, 7, 3).fill({ color: member.presence === 'online' ? 0x3e9b6b : member.presence === 'reconnecting' ? 0xe1a636 : 0xaab4b8 }))
          card.addChild(note)
          if (member.progress !== null) {
            const barY = cardHeight - 14
            card.addChild(new Graphics().roundRect(-61, barY, 88, 8, 4).fill({ color: 0xe4d9c0 }).stroke({ color: 0x866b49, width: 1 }))
            if (member.progress > 0) card.addChild(new Graphics().roundRect(-61, barY, Math.min(88, member.progress * 0.88), 8, 4).fill({ color: 0x3e9b6b }))
            const percent = new Text({ text: `${Math.round(member.progress)}%`, style: { fontFamily: 'sans-serif', fontSize: 11, fontWeight: 'bold', fill: '#193241' } })
            percent.position.set(32, barY - 2)
            card.addChild(percent)
          }
          card.zIndex = 1500000
          card.on('pointertap', () => onSelect(member.session_id))
          app.stage.addChild(card)
          const path = grid.path(previous, { x, y })
          moves.push({ id: member.session_id, person, rig, path, total: length(path), seated: !discussion && !isSpeaking, chair: spot.chair })
        })
        const shortTitles = new Map(conversations.map(item => [item.conversation_id, shorten(item.summary, 10)]))
        const titleCounts = new Map<string, number>()
        for (const title of shortTitles.values()) titleCounts.set(title, (titleCounts.get(title) ?? 0) + 1)
        for (const discussion of conversations) {
          const slot = discussionSlots.current.get(discussion.conversation_id) ?? 0
          const shortTitle = shortTitles.get(discussion.conversation_id) ?? ''
          const displayTitle = (titleCounts.get(shortTitle) ?? 0) > 1 ? `${shortTitle} ·${slot + 1}` : shortTitle
          const badge = new Container({ x: groupX(slot), y: ROOM_HEIGHT + 50 + Math.floor(slot / groupColumns) * layout.stride, eventMode: 'static', cursor: 'pointer' })
          badge.addChild(new Graphics().roundRect(-75, -16, 150, 32, 6).fill({ color: 0xfff8e6 }).stroke({ color: 0x866b49, width: 1 }))
          const title = new Text({ text: displayTitle, style: { fontFamily: 'sans-serif', fontSize: 13, fill: '#193241' } })
          title.anchor.set(0.5)
          if (title.width > 138) title.scale.set(138 / title.width)
          badge.addChild(title)
          badge.zIndex = 2000000
          badge.on('pointertap', () => onSelectConversation(discussion.conversation_id))
          app.stage.addChild(badge)
        }
        app.stage.addChild(player)
        const started = performance.now()
        animate = () => {
          const now = performance.now()
          const elapsed = (now - started) / 1000
          for (const move of moves) {
            const travelled = reducedMotion ? move.total : Math.min(move.total, elapsed * WALK_SPEED)
            const at = along(move.path, travelled)
            const walking = !reducedMotion && travelled < move.total
            move.rig.seated = move.seated && travelled >= move.total
            if (walking) {
              const ahead = along(move.path, Math.min(move.total, travelled + 6))
              if (Math.hypot(ahead.x - at.x, ahead.y - at.y) > 0.5) face(move.rig, ahead.x - at.x, ahead.y - at.y)
            }
            move.person.position.set(at.x, at.y)
            move.person.zIndex = move.rig.seated ? move.chair + 1 : at.y
            positions.current.set(move.id, at)
            pose(move.rig, walking, now)
          }
          element.dataset.people = JSON.stringify(moves.map(move => [move.id, Math.round(positions.current.get(move.id)?.x ?? 0), Math.round(positions.current.get(move.id)?.y ?? 0)]))
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
  }, [members, conversations, speaking, speech, onSelect, onSelectConversation, pauseMotion, attempt, size])
  return <div className="office-canvas"><label className="office-size">辦公室寬度<select value={size} onChange={event => { const value = Number(event.target.value); setSize(value); try { localStorage.setItem('offora.office.width', String(value)) } catch {} }}>{SIZES.map(value => <option key={value} value={value}>{value}</option>)}</select></label><div className="office-stage" ref={root} aria-hidden="true" />{loadError && <div className="office-error" role="alert"><span>辦公室畫面載入失敗</span><button onClick={() => { setLoadError(false); setAttempt(value => value + 1) }}>重新載入畫面</button></div>}</div>
}
