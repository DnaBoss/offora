import { useEffect, useRef, useState } from 'react'
import { Application, Assets, Container, Graphics, Rectangle, Sprite, Text, Texture, TilingSprite } from 'pixi.js'
import type { Conversation, Member } from './types'
import { Grid, along, length, type Point, type Rect } from './navigation'
import { layoutDesks, type Spot } from './layout'

const SIZES = [1920, 2560, 3840, 5120, 7680]
const DEFAULT_SIZE = 3840
const storedSize = () => { try { const value = Number(localStorage.getItem('offora.office.width')); return SIZES.includes(value) ? value : DEFAULT_SIZE } catch { return DEFAULT_SIZE } }
const FIGURE_SIZE = 130
const ROOM_HEIGHT = 580
const WALL_HEIGHT = 210
const WALL_SCALE = 0.29
const WALK_LIMIT_TOP = WALL_HEIGHT + 16
const SCENE_PROPS = ['wall-tile', 'window', 'bookshelf', 'kitchen', 'fridge', 'cabinet-small', 'palm-tall', 'palm-areca', 'plant-mid', 'rug-green', 'rug-pink', 'meeting', 'sofa-left', 'sofa-right', 'coffee-table', 'side-table', 'bar', 'whiteboard', 'painting', 'pendant'] as const
type SceneName = typeof SCENE_PROPS[number]
type SceneItem = { name: SceneName, x: number, bottom: number, height: number, solid?: [number, number], layer?: 'rug' | 'top' }
function sceneItems(width: number): SceneItem[] {
  const right = (offset: number) => width - offset
  return [
    { name: 'rug-green', x: width * 0.28, bottom: 455, height: 134, layer: 'rug' },
    { name: 'rug-pink', x: width * 0.75, bottom: 455, height: 134, layer: 'rug' },
    { name: 'painting', x: width * 0.16, bottom: 150, height: 92, layer: 'top' },
    { name: 'painting', x: width * 0.86, bottom: 150, height: 92, layer: 'top' },
    { name: 'pendant', x: width * 0.28, bottom: 125, height: 125, layer: 'top' },
    { name: 'pendant', x: width * 0.75, bottom: 125, height: 125, layer: 'top' },
    { name: 'bookshelf', x: 110, bottom: 330, height: 168, solid: [0.9, 0.3] },
    { name: 'kitchen', x: 290, bottom: 330, height: 130, solid: [0.9, 0.4] },
    { name: 'fridge', x: 405, bottom: 330, height: 150, solid: [0.8, 0.28] },
    { name: 'bar', x: width * 0.5, bottom: 345, height: 96, solid: [0.96, 0.55] },
    { name: 'whiteboard', x: width * 0.5 + 270, bottom: 340, height: 124, solid: [0.5, 0.25] },
    { name: 'cabinet-small', x: right(70), bottom: 330, height: 104, solid: [0.9, 0.4] },
    { name: 'bookshelf', x: right(215), bottom: 330, height: 168, solid: [0.9, 0.3] },
    { name: 'meeting', x: width * 0.28, bottom: 495, height: 150, solid: [0.42, 0.42] },
    { name: 'sofa-left', x: width * 0.75 - 105, bottom: 500, height: 146, solid: [0.8, 0.45] },
    { name: 'sofa-right', x: width * 0.75 + 105, bottom: 500, height: 146, solid: [0.8, 0.45] },
    { name: 'coffee-table', x: width * 0.75, bottom: 488, height: 90, solid: [0.7, 0.4] },
    { name: 'side-table', x: width * 0.75 + 215, bottom: 480, height: 76, solid: [0.7, 0.3] },
    { name: 'plant-mid', x: 70, bottom: 530, height: 130, solid: [0.42, 0.2] },
    { name: 'palm-areca', x: right(105), bottom: 540, height: 140, solid: [0.4, 0.2] }
  ]
}
const DESK_WIDTH = 138
const PROPS: Record<Spot['kind'], [SceneName, number]> = {
  plantBig: ['palm-areca', 116],
  plantSmall: ['plant-mid', 96],
  plantTall: ['palm-tall', 130],
  shelf: ['bookshelf', 110],
  cabinet: ['cabinet-small', 85],
  lamp: ['plant-mid', 110]
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
      await app.init({ backgroundAlpha: 0, resizeTo: element, antialias: false, resolution: window.devicePixelRatio || 1, autoDensity: true })
      if (!active) { app.destroy(true); return }
      initialized = true
      const textures = await Promise.all([1, 2, 3, 4, 5, 6].map(number => `/assets/people-v${number}.png`).map(path => Assets.load(path)))
      const floorTexture = await Assets.load('/assets/floor-v1.png')
      if (!active) return
      const deskTexture = await Assets.load('/assets/furniture-v1/desk.png')
      const scene = Object.fromEntries(await Promise.all(SCENE_PROPS.map(async name => [name, await Assets.load(`/assets/scene-v1/${name}.png`)]))) as Record<SceneName, Texture>
      const parts = textures.map(texture => cutFrames(texture))
      sceneTextures = [...parts.flatMap(item => [...item.down, ...item.up, ...item.side])]
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
        const width = size
        world.current.width = width
        app.stage.sortableChildren = true
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
        const height = Math.max(440 + ROOM_HEIGHT, ROOM_HEIGHT + 280 + Math.ceil(conversations.length / groupColumns) * layout.stride + speakerRows * 190 + deskLayout.height)
        world.current.height = height
        world.current.spawnY = Math.max(ROOM_HEIGHT + 40, height - 40)
        const deskTop = height - deskLayout.height
        const floor = new TilingSprite({ texture: floorTexture, width, height: height - WALL_HEIGHT })
        floor.y = WALL_HEIGHT
        floor.zIndex = -3
        app.stage.addChild(floor)
        const wall = new TilingSprite({ texture: scene['wall-tile'], width, height: WALL_HEIGHT })
        wall.tileScale.set(WALL_SCALE)
        wall.zIndex = -2
        app.stage.addChild(wall)
        const windowSprite = new Sprite(scene.window)
        windowSprite.anchor.set(0.5, 0)
        windowSprite.scale.set(WALL_SCALE)
        windowSprite.position.set(width / 2, 42)
        windowSprite.zIndex = -2
        app.stage.addChild(windowSprite)
        const addSprite = (texture: Texture, x: number, bottom: number, displayHeight: number, zIndex: number) => {
          const sprite = new Sprite(texture)
          sprite.anchor.set(0.5, 1)
          sprite.scale.set(displayHeight / texture.height)
          sprite.position.set(x, bottom)
          sprite.zIndex = zIndex
          app.stage.addChild(sprite)
          return sprite
        }
        const footprint = (sprite: Sprite, fraction: [number, number]) => ({ x: sprite.x - sprite.width * fraction[0] / 2, y: sprite.y - sprite.height * fraction[1], w: sprite.width * fraction[0], h: sprite.height * fraction[1] })
        for (const item of sceneItems(width)) {
          const sprite = addSprite(scene[item.name], item.x, item.bottom, item.height, item.layer === 'rug' ? -1 : item.layer === 'top' ? 1000000 : item.bottom)
          if (item.solid) obstacles.push(footprint(sprite, item.solid))
        }
        obstacles.push({ x: 0, y: 0, w: width, h: WALK_LIMIT_TOP })
        const prop = (name: keyof typeof PROPS, x: number, bottom: number) => {
          const sprite = addSprite(scene[PROPS[name][0]], x, bottom, PROPS[name][1], bottom)
          obstacles.push(footprint(sprite, [0.5, 0.3]))
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
          desk.zIndex = y - 20
          app.stage.addChild(desk)
        }
        const grid = new Grid({ left: 65, right: width - 65, top: WALK_LIMIT_TOP, bottom: Math.max(WALK_LIMIT_TOP, height - 60) }, obstacles)
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
          const y = discussion ? ROOM_HEIGHT + 205 + Math.floor(slot / groupColumns) * layout.stride + participantRow * 190 : isSpeaking ? ROOM_HEIGHT + 150 + Math.ceil(conversations.length / groupColumns) * layout.stride + speakerRow * 190 : deskTop + seat.y
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
            if (walking) {
              const ahead = along(move.path, Math.min(move.total, travelled + 6))
              if (Math.hypot(ahead.x - at.x, ahead.y - at.y) > 0.5) face(move.rig, ahead.x - at.x, ahead.y - at.y)
            }
            move.person.position.set(at.x, at.y)
            move.person.zIndex = at.y
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
