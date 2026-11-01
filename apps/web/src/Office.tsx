import { useEffect, useRef, useState } from 'react'
import { Application, Assets, Container, Graphics, Rectangle, Sprite, Text, Texture, TilingSprite } from 'pixi.js'
import type { Conversation, Member } from './types'
import { Grid, along, length, type Point, type Rect } from './navigation'
import { layoutDesks, type Spot } from './layout'

const WORLD_WIDTH = 1280
const FIGURE_SIZE = 130
const BACKGROUND_WIDTH = 1604
const BACKGROUND_HEIGHT = 981
const LEAVES = [[1066, 116, 70, 90], [1440, 20, 100, 90]]
const HEAD_SOURCE_HEIGHT = 615
const HEAD_HEIGHT = Math.round(HEAD_SOURCE_HEIGHT * 1280 / BACKGROUND_WIDTH)
const HEAD_OBSTACLES: Rect[] = [{ x: 0, y: 0, w: 1280, h: 215 }, { x: 0, y: 215, w: 90, h: 400 }, { x: 1190, y: 215, w: 90, h: 400 }, { x: 96, y: 263, w: 115, h: 112 }, { x: 90, y: 400, w: 51, h: 69 }, { x: 234, y: 378, w: 59, h: 80 }, { x: 310, y: 287, w: 225, h: 165 }, { x: 863, y: 215, w: 58, h: 64 }, { x: 862, y: 279, w: 84, h: 184 }, { x: 948, y: 410, w: 48, h: 53 }, { x: 958, y: 315, w: 92, h: 80 }, { x: 1065, y: 279, w: 70, h: 152 }, { x: 1100, y: 236, w: 62, h: 43 }]

function place([x, y, width, height]: number[]) {
  return { left: `${x / BACKGROUND_WIDTH * 100}%`, top: `${y / BACKGROUND_HEIGHT * 100}%`, width: `${width / BACKGROUND_WIDTH * 100}%`, height: `${height / BACKGROUND_HEIGHT * 100}%` }
}
const DESK_WIDTH = 138
const PROPS: Record<Spot['kind'], [string, number]> = {
  plantBig: ['plant-big', 116],
  plantSmall: ['plant-small', 80],
  plantTall: ['plant-big', 96],
  shelf: ['shelf', 95],
  cabinet: ['cabinet', 85],
  lamp: ['lamp', 95]
}
const FRAME_WIDTH = 160
const FRAME_HEIGHT = 256
const FIGURE_PIXELS = 236
const FEET_Y = 68
const WALK_SEQUENCE = [0, 1, 2, 1]
const WALK_STEP_MS = 130
const WALK_SPEED = 260

type Facing = 'down' | 'up' | 'side'
type Rig = { body: Container, sprite: Sprite, facing: Facing, frames: Record<Facing, Texture[]>, seed: number }

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
  body.addChild(sprite)
  return { body, sprite, facing: 'down', frames, seed }
}

function face(rig: Rig, dx: number, dy: number) {
  const facing: Facing = Math.abs(dy) > Math.abs(dx) ? (dy < 0 ? 'up' : 'down') : 'side'
  rig.body.scale.x = facing === 'side' && dx < 0 ? -1 : 1
  rig.facing = facing
}

function pose(rig: Rig, walking: boolean, now: number) {
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
  const world = useRef({ height: 440, spawnY: 340 })
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
      await app.init({ backgroundAlpha: 0, resizeTo: element, antialias: false, resolution: window.devicePixelRatio || 1, autoDensity: true })
      if (!active) { app.destroy(true); return }
      initialized = true
      const textures = await Promise.all([1, 2, 3, 4, 5, 6].map(number => `/assets/people-v${number}.png`).map(path => Assets.load(path)))
      const background = await Assets.load('/assets/office-background-v1.png')
      const floorTexture = await Assets.load('/assets/floor-v1.png')
      if (!active) return
      const deskTexture = await Assets.load('/assets/furniture-v1/desk.png')
      const headTexture = new Texture({ source: background.source, frame: new Rectangle(0, 0, BACKGROUND_WIDTH, HEAD_SOURCE_HEIGHT) })
      const parts = textures.map(texture => cutFrames(texture))
      const props = Object.fromEntries(await Promise.all(Object.entries(PROPS).map(async ([name, [file]]) => [name, await Assets.load(`/assets/furniture-v1/${file}.png`)]))) as Record<keyof typeof PROPS, Texture>
      sceneTextures = [headTexture, ...parts.flatMap(item => [...item.down, ...item.up, ...item.side])]
      motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)')
      setLoadError(false)
      element.appendChild(app.canvas)
      const player = new Container({ eventMode: 'none' })
      const playerRig = buildRig(parts[5], 3.1, 0xbfe3ff)
      const playerLabel = new Text({ text: '你（觀察者）', style: { fontFamily: 'sans-serif', fontSize: 13, fontWeight: 'bold', fill: '#193241', stroke: { color: '#bfe3ff', width: 4 } } })
      playerLabel.anchor.set(0.5, 0)
      playerLabel.y = 70
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
        if (grid) walker.route = grid.path({ x: walker.x, y: walker.y }, { x: event.global.x - app.stage.x, y: event.global.y - app.stage.y }).slice(1)
      })
      const walk = () => {
        const grid = navigation.current
        if (!grid) return
        const worldHeight = world.current.height
        const width = WORLD_WIDTH
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
        element.dataset.player = `${Math.round(walker.x)},${Math.round(walker.y)}`
        const viewWidth = app.screen.width
        const viewHeight = app.screen.height
        app.stage.x = viewWidth >= width ? (viewWidth - width) / 2 : -Math.max(0, Math.min(width - viewWidth, walker.x - viewWidth / 2))
        app.stage.y = viewHeight >= worldHeight ? (viewHeight - worldHeight) / 2 : -Math.max(0, Math.min(worldHeight - viewHeight, walker.y - viewHeight / 2))
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
        const width = WORLD_WIDTH
        const layout = groupLayout(width, conversations)
        const groupColumns = layout.columns
        const speakers = members.filter(member => member.presence !== 'offline' && speaking.includes(member.session_id) && !conversations.some(item => item.participants.includes(member.session_id)))
        const speakersPerRow = Math.max(1, Math.floor(width / 160))
        const groupX = (slot: number) => width * (groupColumns === 1 ? 0.5 : slot % 2 === 0 ? 0.27 : 0.73)
        const moves: { id: string, person: Container, rig: Rig, path: Point[], total: number }[] = []
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
        for (const member of members) {
          if (!appearances.current.has(member.session_id)) {
            const counts = textures.map((_, index) => [...appearances.current.values()].filter(value => value === index).length)
            appearances.current.set(member.session_id, counts.indexOf(Math.min(...counts)))
          }
          if (member.presence === 'offline') { seats.current.delete(member.session_id); continue }
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
        const deskLayout = layoutDesks(totalSeats, width)
        const speakerRows = Math.ceil(speakers.length / speakersPerRow)
        const height = Math.max(440 + HEAD_HEIGHT, HEAD_HEIGHT + 280 + Math.ceil(conversations.length / groupColumns) * layout.stride + speakerRows * 190 + deskLayout.height)
        world.current.height = height
        world.current.spawnY = Math.max(HEAD_HEIGHT + 40, height - 40)
        const deskTop = height - deskLayout.height
        const floor = new TilingSprite({ texture: floorTexture, width, height: height - HEAD_HEIGHT })
        floor.y = HEAD_HEIGHT
        app.stage.addChild(floor)
        const head = new Sprite(headTexture)
        head.scale.set(width / BACKGROUND_WIDTH)
        app.stage.addChild(head)
        obstacles.push(...HEAD_OBSTACLES)
        const prop = (name: keyof typeof PROPS, x: number, bottom: number, solid = true) => {
          const sprite = new Sprite(props[name])
          sprite.anchor.set(0.5, 1)
          sprite.scale.set(PROPS[name][1] / props[name].height)
          sprite.position.set(x, bottom)
          app.stage.addChild(sprite)
          if (solid) obstacles.push({ x: x - sprite.width / 2 + 6, y: bottom - sprite.height / 2, w: sprite.width - 12, h: sprite.height / 2 })
        }
        for (const spot of deskLayout.spots) prop(spot.kind, spot.x, deskTop + spot.y + 45)
        for (const member of members) {
          if (member.presence === 'offline') continue
          const index = seats.current.get(member.session_id) ?? 0
          const seat = deskLayout.desks[index]
          const x = seat.x
          const y = deskTop + seat.y
          obstacles.push({ x: x - DESK_WIDTH / 2, y: y - 88, w: DESK_WIDTH, h: 58 })
          const desk = new Container({ x, y, eventMode: 'static', cursor: 'pointer' })
          const deskImage = new Sprite(deskTexture)
          deskImage.anchor.set(0.5, 1)
          deskImage.y = 17
          deskImage.scale.set(DESK_WIDTH / deskTexture.width)
          desk.addChild(deskImage)
          const away = speaking.includes(member.session_id) || conversations.some(item => item.participants.includes(member.session_id))
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
        const grid = new Grid({ left: 65, right: width - 65, top: 90, bottom: Math.max(90, height - 60) }, obstacles)
        navigation.current = grid
        element.dataset.obstacles = JSON.stringify(obstacles)
        members.filter(member => member.presence !== 'offline').forEach(member => {
          const index = seats.current.get(member.session_id) ?? 0
          const seat = deskLayout.desks[index] ?? { x: width / 2, y: 100 }
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
          const y = discussion ? HEAD_HEIGHT + 205 + Math.floor(slot / groupColumns) * layout.stride + participantRow * 190 : isSpeaking ? HEAD_HEIGHT + 150 + Math.ceil(conversations.length / groupColumns) * layout.stride + speakerRow * 190 : deskTop + seat.y
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
          label.y = 70
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
          const path = grid.path(previous, { x, y })
          moves.push({ id: member.session_id, person, rig, path, total: length(path) })
        })
        const shortTitles = new Map(conversations.map(item => [item.conversation_id, shorten(item.summary, 10)]))
        const titleCounts = new Map<string, number>()
        for (const title of shortTitles.values()) titleCounts.set(title, (titleCounts.get(title) ?? 0) + 1)
        for (const discussion of conversations) {
          const slot = discussionSlots.current.get(discussion.conversation_id) ?? 0
          const shortTitle = shortTitles.get(discussion.conversation_id) ?? ''
          const displayTitle = (titleCounts.get(shortTitle) ?? 0) > 1 ? `${shortTitle} ·${slot + 1}` : shortTitle
          const badge = new Container({ x: groupX(slot), y: HEAD_HEIGHT + 50 + Math.floor(slot / groupColumns) * layout.stride, eventMode: 'static', cursor: 'pointer' })
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
          const elapsed = (now - started) / 1000
          for (const move of moves) {
            const travelled = reducedMotion ? move.total : Math.min(move.total, elapsed * WALK_SPEED)
            const at = along(move.path, travelled)
            const walking = !reducedMotion && travelled < move.total
            if (walking) {
              const ahead = along(move.path, Math.min(move.total, travelled + 6))
              if (Math.hypot(ahead.x - at.x, ahead.y - at.y) > 0.5) face(move.rig, ahead.x - at.x, ahead.y - at.y)
            }
            move.person.position.set(at.x, at.y)
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
  }, [members, conversations, speaking, speech, onSelect, onSelectConversation, pauseMotion, attempt])
  return <div className="office-canvas"><div className={`office-fx${pauseMotion ? ' paused' : ''}`} aria-hidden="true">{LEAVES.map((box, index) => <i key={`l${index}`} className="leaf-sway" style={{ ...place(box), backgroundSize: `${BACKGROUND_WIDTH / box[2] * 100}% ${BACKGROUND_HEIGHT / box[3] * 100}%`, backgroundPosition: `${box[0] / (BACKGROUND_WIDTH - box[2]) * 100}% ${box[1] / (BACKGROUND_HEIGHT - box[3]) * 100}%`, animationDelay: `${index * -1.1}s` }} />)}</div><div className="office-stage" ref={root} aria-hidden="true" />{loadError && <div className="office-error" role="alert"><span>辦公室畫面載入失敗</span><button onClick={() => { setLoadError(false); setAttempt(value => value + 1) }}>重新載入畫面</button></div>}</div>
}
