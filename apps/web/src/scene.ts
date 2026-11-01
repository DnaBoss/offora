import type { Rect } from './navigation.ts'
import { hash } from './layout.ts'
import bounds from './asset-bounds.json' with { type: 'json' }

export const WALL_HEIGHT = 210
export const WALK_LIMIT_TOP = WALL_HEIGHT + 16
export const SCENE_PROPS = ['wall-tile', 'window', 'bookshelf', 'kitchen', 'fridge', 'cabinet-small', 'palm-tall', 'palm-areca', 'plant-mid', 'rug-green', 'rug-pink', 'meeting', 'sofa-left', 'sofa-right', 'coffee-table', 'side-table', 'bar', 'whiteboard', 'painting', 'pendant'] as const
export const OFFICE_PROPS = ['blackboard', 'whiteboard-wheel', 'flipchart', 'screen', 'coffee-machine', 'bins', 'moss-wall', 'coatrack', 'reception', 'desk-oak', 'desk-terracotta', 'desk-blue', 'chair-back-dark', 'chair-back-orange', 'filing-cabinet', 'bookcase-cream', 'server-rack', 'meeting-round', 'printer', 'water-cooler', 'lockers', 'vending', 'cafe-table', 'beanbags', 'floor-lamp', 'standing-desk', 'low-shelf', 'planter-box', 'kitchenette', 'phone-booth', 'fiddle-fig', 'archive-boxes', 'armchair', 'wide-bookshelf'] as const
export type SceneName = typeof SCENE_PROPS[number] | typeof OFFICE_PROPS[number]
export type SceneItem = { name: SceneName, x: number, bottom: number, height: number, solid?: boolean, layer?: 'rug' | 'top' }
export const SOLID: Partial<Record<SceneName, number>> = {
  bookshelf: 0.45,
  kitchen: 0.55,
  fridge: 0.4,
  'cabinet-small': 0.55,
  'palm-tall': 0.45,
  'palm-areca': 0.45,
  'plant-mid': 0.45,
  meeting: 0.8,
  'sofa-left': 0.65,
  'sofa-right': 0.65,
  'coffee-table': 0.75,
  'side-table': 0.6,
  bar: 0.75,
  whiteboard: 0.6,
  blackboard: 0.3,
  'whiteboard-wheel': 0.25,
  flipchart: 0.2,
  'coffee-machine': 0.5,
  bins: 0.5,
  coatrack: 0.3,
  reception: 0.6,
  'desk-oak': 0.9,
  'desk-terracotta': 0.9,
  'desk-blue': 0.9,
  'chair-back-dark': 0.35,
  'chair-back-orange': 0.35,
  'filing-cabinet': 0.5,
  'bookcase-cream': 0.4,
  'server-rack': 0.35,
  'meeting-round': 0.55,
  printer: 0.6,
  'water-cooler': 0.4,
  lockers: 0.35,
  vending: 0.35,
  'cafe-table': 0.5,
  beanbags: 0.6,
  'floor-lamp': 0.3,
  'standing-desk': 0.9,
  'low-shelf': 0.5,
  'planter-box': 0.6,
  kitchenette: 0.4,
  'phone-booth': 0.5,
  'fiddle-fig': 0.45,
  'archive-boxes': 0.6,
  armchair: 0.6,
  'wide-bookshelf': 0.4
}
export const NON_SOLID: SceneName[] = ['wall-tile', 'window', 'rug-green', 'rug-pink', 'painting', 'pendant', 'screen', 'moss-wall']
export const BAY_WIDTH = 1280
export const ROOM_TOP = WALL_HEIGHT
export const ROOM_BOTTOM = WALL_HEIGHT + 420
export const DOOR_WIDTH = 150
export const WALL_THICK = 12
export type RoomKind = 'pantry' | 'meeting' | 'lounge' | 'focus'
export type Room = { x: number, w: number, kind: RoomKind }
export const ROOM_KINDS: [RoomKind, number][] = [['pantry', 460], ['meeting', 500], ['lounge', 460], ['meeting', 500], ['focus', 260]]
export function roomsLayout(width: number): Room[] {
  const rooms: Room[] = []
  let x = 0
  for (let i = 0; ; i++) {
    const [kind, w] = ROOM_KINDS[i % ROOM_KINDS.length]
    if (x + w > width - 240) break
    rooms.push({ x, w, kind })
    x += w
  }
  if (rooms.length && rooms[rooms.length - 1].kind === 'focus') rooms.pop()
  const last = rooms[rooms.length - 1]
  if (last) last.w = width - last.x
  return rooms
}
export type Wall = { rect: Rect, style: 'wall' | 'glass' | 'low', face: boolean }
export function roomWalls(rooms: Room[]): Wall[] {
  const walls: Wall[] = []
  rooms.forEach((room, index) => {
    if (index > 0) walls.push({ rect: { x: room.x - WALL_THICK / 2, y: ROOM_TOP, w: WALL_THICK, h: ROOM_BOTTOM - ROOM_TOP + WALL_THICK }, style: 'wall', face: false })
    const style = room.kind === 'meeting' || room.kind === 'focus' ? 'glass' : 'low'
    const door = room.x + room.w / 2
    walls.push(
      { rect: { x: room.x + WALL_THICK / 2, y: ROOM_BOTTOM, w: door - DOOR_WIDTH / 2 - room.x - WALL_THICK / 2, h: WALL_THICK }, style, face: true },
      { rect: { x: door + DOOR_WIDTH / 2, y: ROOM_BOTTOM, w: room.x + room.w - WALL_THICK / 2 - door - DOOR_WIDTH / 2, h: WALL_THICK }, style, face: true }
    )
  })
  return walls
}
export function roomItems(room: Room, index: number): SceneItem[] {
  const cx = room.x + room.w / 2
  const odd = index % 2 === 1
  const item = (name: SceneName, x: number, bottom: number, height: number, solid = true): SceneItem => ({ name, x, bottom, height, solid })
  const rug = (name: SceneName, x: number, bottom: number, height: number): SceneItem => ({ name, x, bottom, height, layer: 'rug' })
  if (room.kind === 'pantry') return [
    item('kitchen', room.x + 85, 335, 130),
    item('fridge', room.x + 195, 335, 150),
    item('coffee-machine', room.x + 300, 335, 112),
    item('bar', cx + 40, 520, 96),
    item('bins', room.x + room.w - 55, 340, 58),
    item('plant-mid', room.x + room.w - 50, 580, 118),
    { name: 'painting', x: room.x + room.w - 130, bottom: 150, height: 92, layer: 'top' }
  ]
  if (room.kind === 'meeting') return [
    rug(odd ? 'rug-pink' : 'rug-green', cx, 560, 160),
    item('meeting-round', cx, 520, 190),
    odd ? item('blackboard', room.x + 95, 345, 130) : item('whiteboard-wheel', room.x + 95, 345, 135),
    { name: 'screen', x: cx + 70, bottom: 300, height: 115, layer: 'top' },
    item('plant-mid', room.x + room.w - 50, 345, 118)
  ]
  if (room.kind === 'lounge') return [
    rug('rug-pink', cx, 530, 160),
    item('sofa-left', cx - 95, 430, 140),
    item('sofa-right', cx + 95, 430, 140),
    item('coffee-table', cx, 490, 80),
    item('bookcase-cream', room.x + 75, 340, 165),
    item('palm-tall', room.x + room.w - 55, 350, 140),
    { name: 'painting', x: cx, bottom: 150, height: 92, layer: 'top' }
  ]
  return [
    item('desk-oak', cx, 430, 100),
    item('chair-back-dark', cx, 495, CHAIR_HEIGHT),
    item('plant-mid', room.x + 45, 345, 118),
    item('palm-areca', room.x + room.w - 45, 360, 130)
  ]
}
export const BENCH_FIRST = 900
export const BENCH_STRIDE = 270
export const BENCH_MIN_ROWS = 5
export const benchRow = (row: number) => BENCH_FIRST + row * BENCH_STRIDE
export const BENCH_DESKS: SceneName[] = ['desk-oak', 'desk-terracotta', 'desk-blue']
export const BENCH_CHAIRS: SceneName[] = ['chair-back-dark', 'chair-back-orange']
export const CHAIR_HEIGHT = 84
export const DESK_FRONT = 26
export const BENCH_PITCH = 146
export const SIT_LIFT = 8
export const ZOOM = 1
const aspectOf = (name: SceneName) => (bounds as unknown as Record<string, { aspect: number }>)[name].aspect
const HUB_ITEMS: { name: SceneName, height: number, drop: number }[] = [
  { name: 'plant-mid', height: 110, drop: 0 },
  { name: 'filing-cabinet', height: 110, drop: 0 },
  { name: 'palm-areca', height: 120, drop: 0 },
  { name: 'printer', height: 84, drop: 0 },
  { name: 'water-cooler', height: 112, drop: 0 },
  { name: 'lockers', height: 120, drop: 0 },
  { name: 'fiddle-fig', height: 120, drop: 0 },
  { name: 'low-shelf', height: 84, drop: 0 },
  { name: 'floor-lamp', height: 120, drop: 0 },
  { name: 'archive-boxes', height: 64, drop: 0 },
  { name: 'planter-box', height: 70, drop: 0 }
]
const MARGIN_ITEMS: { name: SceneName, height: number }[] = [
  { name: 'palm-areca', height: 140 },
  { name: 'fiddle-fig', height: 130 },
  { name: 'plant-mid', height: 130 },
  { name: 'floor-lamp', height: 130 },
  { name: 'lockers', height: 130 }
]
export type Screen = { rect: Rect }
export type BenchSeat = { x: number, desk: number, chair: number }
export type Bench = { items: SceneItem[], screens: Screen[], seats: BenchSeat[], rows: number }
export function benchItems(width: number, rows: number): Bench {
  const items: SceneItem[] = []
  const screens: Screen[] = []
  const seats: BenchSeat[] = []
  for (let row = 0; row < rows; row++) {
    const baseline = benchRow(row)
    let cursor = 130 + hash(row * 7 + 1) % 120
    let group = 0
    const drift = ((hash(row * 3 + 9) % 3) - 1) * 18
    while (true) {
      const size = [4, 2, 5, 1, 3, 2][hash(row * 31 + group * 5 + 2) % 6]
      const span = size * BENCH_PITCH
      if (cursor + span > width - 130) break
      const y = baseline + drift + ((hash(group * 11 + row) % 3) - 1) * 14
      const palette = hash(row * 13 + group * 3) % BENCH_DESKS.length
      for (let n = 0; n < size; n++) {
        const x = cursor + n * BENCH_PITCH + BENCH_PITCH / 2
        items.push(
          { name: BENCH_DESKS[(palette + (size > 1 ? 0 : 1)) % BENCH_DESKS.length], x, bottom: y, height: 112, solid: true },
          { name: BENCH_CHAIRS[(n + group + row) % BENCH_CHAIRS.length], x, bottom: y + 62, height: CHAIR_HEIGHT, solid: true }
        )
        seats.push({ x, desk: y, chair: y + 62 })
      }
      if (size > 1) screens.push({ rect: { x: cursor - 7, y: y - 108, w: 12, h: 124 } }, { rect: { x: cursor + span - 5, y: y - 108, w: 12, h: 124 } })
      const gap = 90 + hash(group * 17 + row * 5) % 110
      const pick = HUB_ITEMS.filter(hub => hub.height * aspectOf(hub.name) <= gap - 24)
      const hub = pick.length && hash(group * 3 + row) % 4 > 0 ? pick[hash(group * 5 + row * 3) % pick.length] : undefined
      const extra = hub ? [{ name: hub.name, x: cursor + span + gap / 2, bottom: y + hub.drop, height: hub.height, solid: true }] : []
      items.push(...extra)
      cursor += span + gap
      group++
    }
    const left = MARGIN_ITEMS[hash(row * 7 + 2) % MARGIN_ITEMS.length]
    const right = MARGIN_ITEMS[hash(row * 11 + 5) % MARGIN_ITEMS.length]
    items.push({ name: left.name, x: 75, bottom: baseline + 10, height: left.height, solid: true }, { name: right.name, x: width - 75, bottom: baseline + 10, height: right.height, solid: true })
  }
  return { items, screens, seats, rows }
}
export const stripBottom = (rows: number) => benchRow(rows - 1) + 240
const STRIP_ITEMS: { name: SceneName, height: number }[] = [
  { name: 'lockers', height: 130 },
  { name: 'wide-bookshelf', height: 130 },
  { name: 'vending', height: 130 },
  { name: 'kitchenette', height: 112 },
  { name: 'phone-booth', height: 140 },
  { name: 'armchair', height: 96 },
  { name: 'cafe-table', height: 96 },
  { name: 'beanbags', height: 84 },
  { name: 'fiddle-fig', height: 130 },
  { name: 'standing-desk', height: 104 },
  { name: 'water-cooler', height: 112 },
  { name: 'printer', height: 90 }
]
export function stripItems(width: number, rows: number): SceneItem[] {
  const items: SceneItem[] = []
  let cursor = 150
  let last = -1
  for (let i = 0; ; i++) {
    let index = hash(i * 7 + rows) % STRIP_ITEMS.length
    if (index === last) index = (index + 1) % STRIP_ITEMS.length
    const { name, height } = STRIP_ITEMS[index]
    const w = height * aspectOf(name)
    if (cursor + w > width - 130) break
    items.push({ name, x: cursor + w / 2, bottom: stripBottom(rows), height, solid: true })
    cursor += w + 40 + hash(i * 3 + 1) % 50
    last = index
  }
  return items
}
export function sceneItems(width: number, bench: Bench) {
  const rooms = roomsLayout(width)
  const items: SceneItem[] = []
  rooms.forEach((room, index) => items.push(...roomItems(room, index)))
  items.push(...bench.items, ...stripItems(width, bench.rows))
  return { items, rooms, walls: roomWalls(rooms), screens: bench.screens }
}
export function footprint(name: SceneName, x: number, bottom: number, height: number): Rect | undefined {
  const depth = SOLID[name]
  const info = (bounds as unknown as Record<string, { aspect: number, bands: ([number, number] | null)[] }>)[name]
  if (depth === undefined || !info) return undefined
  const first = Math.round((1 - depth) * 10)
  const spans = info.bands.slice(first).filter((band): band is [number, number] => band !== null)
  if (!spans.length) return undefined
  const left = Math.min(...spans.map(span => span[0]))
  const right = Math.max(...spans.map(span => span[1]))
  const width = height * info.aspect
  const front = name.startsWith('desk-') || name === 'standing-desk' ? DESK_FRONT : 0
  return { x: x - width / 2 + left * width, y: bottom - height * (1 - first / 10), w: (right - left) * width, h: height * (1 - first / 10) + front }
}
