import type { Rect } from './navigation.ts'
import { hash } from './layout.ts'
import bounds from './asset-bounds.json' with { type: 'json' }

export const WALL_HEIGHT = 210
export const WALK_LIMIT_TOP = WALL_HEIGHT + 16
export const SCENE_PROPS = ['wall-tile', 'window', 'bookshelf', 'kitchen', 'fridge', 'cabinet-small', 'palm-tall', 'palm-areca', 'plant-mid', 'rug-green', 'rug-pink', 'meeting', 'sofa-left', 'sofa-right', 'coffee-table', 'side-table', 'bar', 'whiteboard', 'painting', 'pendant'] as const
export const OFFICE_PROPS = ['blackboard', 'whiteboard-wheel', 'flipchart', 'screen', 'coffee-machine', 'bins', 'moss-wall', 'coatrack', 'reception', 'desk-oak', 'desk-terracotta', 'desk-blue', 'chair-back-dark', 'chair-back-orange', 'filing-cabinet', 'bookcase-cream', 'server-rack', 'meeting-round', 'printer', 'water-cooler', 'lockers', 'vending', 'cafe-table', 'beanbags', 'floor-lamp', 'standing-desk', 'low-shelf', 'planter-box', 'kitchenette', 'phone-booth', 'fiddle-fig', 'archive-boxes', 'armchair', 'wide-bookshelf', 'desk-side-oak', 'desk-side-blue', 'chair-side-dark', 'chair-side-orange', 'desk-north-oak', 'desk-north-blue', 'chair-front-dark', 'chair-front-orange'] as const
export type SceneName = typeof SCENE_PROPS[number] | typeof OFFICE_PROPS[number]
export type SceneItem = { name: SceneName, x: number, bottom: number, height: number, solid?: boolean, layer?: 'rug' | 'top', flip?: boolean }
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
  'wide-bookshelf': 0.4,
  'desk-side-oak': 0.9,
  'desk-side-blue': 0.9,
  'chair-side-dark': 0.35,
  'chair-side-orange': 0.35,
  'desk-north-oak': 0.45,
  'desk-north-blue': 0.45,
  'chair-front-dark': 0.3,
  'chair-front-orange': 0.3
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
export const BENCH_STRIDE = 310
export const BENCH_MIN_ROWS = 5
export const benchRow = (row: number) => BENCH_FIRST + row * BENCH_STRIDE
export const BENCH_DESKS: SceneName[] = ['desk-oak', 'desk-terracotta', 'desk-blue']
export const BENCH_CHAIRS: SceneName[] = ['chair-back-dark', 'chair-back-orange']
export const CHAIR_HEIGHT = 84
export const DESK_FRONT = 12
export const BENCH_PITCH = 146
const SIDE_DESKS: SceneName[] = ['desk-side-oak', 'desk-side-blue']
const SIDE_CHAIRS: SceneName[] = ['chair-side-dark', 'chair-side-orange']
const SIDE_DESK_HEIGHT = 108
const SIDE_CHAIR_HEIGHT = 80
const SIDE_SPAN = 290
const NORTH_DESKS: SceneName[] = ['desk-north-oak', 'desk-north-blue']
const NORTH_CHAIRS: SceneName[] = ['chair-front-dark', 'chair-front-orange']
const NORTH_DESK_HEIGHT = 100
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
export type SeatFacing = 'up' | 'down' | 'left' | 'right'
export const STAND_OFFSET = 56

export function standPoint(seat: BenchSeat) {
  if (seat.facing === 'up') return { x: seat.chairX, y: seat.chair + STAND_OFFSET }
  if (seat.facing === 'down') return { x: seat.chairX, y: seat.chair - CHAIR_HEIGHT - 20 }
  return { x: seat.chairX + (seat.facing === 'right' ? -STAND_OFFSET : STAND_OFFSET), y: seat.chair }
}

export function chairAt(seats: BenchSeat[], x: number, y: number) {
  return seats.findIndex(seat => Math.abs(x - seat.chairX) <= 34 && y >= seat.chair - CHAIR_HEIGHT && y <= seat.chair + 10)
}

export type BenchSeat = { x: number, desk: number, card: number, y: number, z: number, facing: SeatFacing, chairX: number, chair: number }
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
      const side = hash(row * 19 + group * 7 + 4) % 4 === 0
      const north = !side && hash(row * 23 + group * 11 + 1) % 3 === 0
      const size = side ? 1 : [4, 2, 5, 1, 3, 2][hash(row * 31 + group * 5 + 2) % 6]
      const span = side ? SIDE_SPAN : size * BENCH_PITCH
      if (cursor + span > width - 130) break
      const y = baseline + drift + ((hash(group * 11 + row) % 3) - 1) * 14
      if (side) {
        const tone = hash(row * 5 + group) % 2
        const desk = SIDE_DESKS[tone]
        const chair = SIDE_CHAIRS[(row + group) % 2]
        const mid = cursor + span / 2
        const deskWidth = SIDE_DESK_HEIGHT * aspectOf(desk)
        const chairWidth = SIDE_CHAIR_HEIGHT * aspectOf(chair)
        const reach = deskWidth + chairWidth / 2 + 14
        const cb = y - 8
        items.push(
          { name: desk, x: mid - deskWidth / 2, bottom: y, height: SIDE_DESK_HEIGHT, solid: true },
          { name: desk, x: mid + deskWidth / 2, bottom: y, height: SIDE_DESK_HEIGHT, solid: true, flip: true },
          { name: chair, x: mid - reach, bottom: cb, height: SIDE_CHAIR_HEIGHT, solid: true },
          { name: chair, x: mid + reach, bottom: cb, height: SIDE_CHAIR_HEIGHT, solid: true, flip: true }
        )
        seats.push({ x: mid - reach, desk: y, card: y - 150, y: cb - 6, z: cb + 1, facing: 'right', chairX: mid - reach, chair: cb }, { x: mid + reach, desk: y, card: y - 150, y: cb - 6, z: cb + 1, facing: 'left', chairX: mid + reach, chair: cb })
        cursor += span + 130 + hash(group * 17 + row * 5) % 110
        group++
        continue
      }
      const palette = hash(row * 13 + group * 3) % BENCH_DESKS.length
      for (let n = 0; n < size; n++) {
        const x = cursor + n * BENCH_PITCH + BENCH_PITCH / 2
        if (north) {
          const desk = NORTH_DESKS[(row + group) % 2]
          items.push(
            { name: desk, x, bottom: y, height: NORTH_DESK_HEIGHT, solid: true },
            { name: NORTH_CHAIRS[(n + group + row) % 2], x, bottom: y - 78, height: CHAIR_HEIGHT, solid: true }
          )
          seats.push({ x, desk: y, card: y - 232, y: y - 86, z: y - 77, facing: 'down', chairX: x, chair: y - 78 })
          continue
        }
        items.push(
          { name: BENCH_DESKS[(palette + (size > 1 ? 0 : 1)) % BENCH_DESKS.length], x, bottom: y, height: 112, solid: true },
          { name: BENCH_CHAIRS[(n + group + row) % BENCH_CHAIRS.length], x, bottom: y + 62, height: CHAIR_HEIGHT, solid: true }
        )
        seats.push({ x, desk: y, card: y - 118, y: y + 62 - SIT_LIFT, z: y + 62 - 1, facing: 'up', chairX: x, chair: y + 62 })
      }
      if (size > 1 && !north) screens.push({ rect: { x: cursor - 7, y: y - 108, w: 12, h: 124 } }, { rect: { x: cursor + span - 5, y: y - 108, w: 12, h: 124 } })
      const gap = 130 + hash(group * 17 + row * 5) % 110
      const pick = HUB_ITEMS.filter(hub => hub.height * aspectOf(hub.name) <= gap - 90)
      const hub = pick.length && hash(group * 3 + row) % 2 > 0 ? pick[hash(group * 5 + row * 3) % pick.length] : undefined
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
    cursor += w + 90 + hash(i * 3 + 1) % 60
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
export function footprint(name: SceneName, x: number, bottom: number, height: number, flip = false): Rect | undefined {
  const depth = SOLID[name]
  const info = (bounds as unknown as Record<string, { aspect: number, bands: ([number, number] | null)[] }>)[name]
  if (depth === undefined || !info) return undefined
  const first = Math.round((1 - depth) * 10)
  const spans = info.bands.slice(first).filter((band): band is [number, number] => band !== null)
  if (!spans.length) return undefined
  const lo = Math.min(...spans.map(span => span[0]))
  const hi = Math.max(...spans.map(span => span[1]))
  const left = flip ? 1 - hi : lo
  const right = flip ? 1 - lo : hi
  const width = height * info.aspect
  const front = name.startsWith('desk-') || name === 'standing-desk' ? DESK_FRONT : 0
  return { x: x - width / 2 + left * width, y: bottom - height * (1 - first / 10), w: (right - left) * width, h: height * (1 - first / 10) + front }
}
