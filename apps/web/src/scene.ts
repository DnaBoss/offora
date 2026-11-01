import type { Rect } from './navigation.ts'
import { hash } from './layout.ts'

export const WALL_HEIGHT = 210
export const WALK_LIMIT_TOP = WALL_HEIGHT + 16
export const SCENE_PROPS = ['wall-tile', 'window', 'bookshelf', 'kitchen', 'fridge', 'cabinet-small', 'palm-tall', 'palm-areca', 'plant-mid', 'rug-green', 'rug-pink', 'meeting', 'sofa-left', 'sofa-right', 'coffee-table', 'side-table', 'bar', 'whiteboard', 'painting', 'pendant'] as const
export const OFFICE_PROPS = ['blackboard', 'whiteboard-wheel', 'flipchart', 'screen', 'coffee-machine', 'bins', 'moss-wall', 'coatrack', 'reception', 'desk-oak', 'desk-terracotta', 'desk-blue', 'chair-dark', 'chair-orange', 'filing-cabinet', 'bookcase-cream', 'server-rack', 'meeting-round'] as const
export type SceneName = typeof SCENE_PROPS[number] | typeof OFFICE_PROPS[number]
export type SceneItem = { name: SceneName, x: number, bottom: number, height: number, solid?: boolean, layer?: 'rug' | 'top' }
export const SOLID: Partial<Record<SceneName, [number, number]>> = {
  bookshelf: [1, 0.45],
  kitchen: [1, 0.55],
  fridge: [1, 0.4],
  'cabinet-small': [1, 0.55],
  'palm-tall': [0.6, 0.45],
  'palm-areca': [0.6, 0.45],
  'plant-mid': [0.6, 0.45],
  meeting: [1, 0.8],
  'sofa-left': [1, 0.65],
  'sofa-right': [1, 0.65],
  'coffee-table': [1, 0.75],
  'side-table': [1, 0.6],
  bar: [1, 0.75],
  whiteboard: [1, 0.6],
  blackboard: [1, 0.3],
  'whiteboard-wheel': [1, 0.25],
  flipchart: [0.7, 0.2],
  'coffee-machine': [1, 0.5],
  bins: [1, 0.5],
  coatrack: [0.5, 0.3],
  reception: [1, 0.6],
  'desk-oak': [1, 0.9],
  'desk-terracotta': [1, 0.9],
  'desk-blue': [1, 0.9],
  'chair-dark': [0.6, 0.35],
  'chair-orange': [0.6, 0.35],
  'filing-cabinet': [1, 0.5],
  'bookcase-cream': [1, 0.4],
  'server-rack': [1, 0.35],
  'meeting-round': [0.95, 0.55]
}
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
    item('chair-dark', cx, 495, 72),
    item('plant-mid', room.x + 45, 345, 118),
    item('palm-areca', room.x + room.w - 45, 360, 130)
  ]
}
export const BENCH_FIRST = 900
export const BENCH_STRIDE = 270
export const BENCH_MIN_ROWS = 5
export const benchRow = (row: number) => BENCH_FIRST + row * BENCH_STRIDE
export const BENCH_DESKS: SceneName[] = ['desk-oak', 'desk-terracotta', 'desk-blue']
export const BENCH_CHAIRS: SceneName[] = ['chair-dark', 'chair-orange']
export const DESK_FRONT = 26
export const BENCH_PITCH = 146
export const SIT_LIFT = -22
export const ZOOM = 1.5
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
          { name: BENCH_CHAIRS[(n + group + row) % BENCH_CHAIRS.length], x, bottom: y + 62, height: 72, solid: true }
        )
        seats.push({ x, desk: y, chair: y + 62 })
      }
      if (size > 1) screens.push({ rect: { x: cursor - 7, y: y - 108, w: 12, h: 124 } }, { rect: { x: cursor + span - 5, y: y - 108, w: 12, h: 124 } })
      const gap = 90 + hash(group * 17 + row * 5) % 110
      const extra = gap >= 140 && hash(group * 3 + row) % 3 > 0 ? [{ name: ['plant-mid', 'filing-cabinet', 'palm-areca'][hash(group + row) % 3] as SceneName, x: cursor + span + gap / 2, bottom: y, height: 110, solid: true }] : []
      items.push(...extra)
      cursor += span + gap
      group++
    }
    items.push({ name: 'palm-areca', x: 75, bottom: baseline + 10, height: 140, solid: true }, { name: 'plant-mid', x: width - 75, bottom: baseline + 10, height: 130, solid: true })
  }
  return { items, screens, seats, rows }
}
export function sceneItems(width: number, bench: Bench) {
  const rooms = roomsLayout(width)
  const items: SceneItem[] = []
  rooms.forEach((room, index) => items.push(...roomItems(room, index)))
  items.push(...bench.items)
  return { items, rooms, walls: roomWalls(rooms), screens: bench.screens }
}
export function footprint(name: SceneName, x: number, bottom: number, width: number, height: number): Rect | undefined {
  const fraction = SOLID[name]
  if (!fraction) return undefined
  const front = name.startsWith('desk-') ? DESK_FRONT : 0
  return { x: x - width * fraction[0] / 2, y: bottom - height * fraction[1], w: width * fraction[0], h: height * fraction[1] + front }
}
