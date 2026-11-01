import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Grid, type Rect } from './navigation.ts'
import { SCENE_PROPS, OFFICE_PROPS, SOLID, NON_SOLID, DESK_FRONT, SIT_LIFT, WALK_LIMIT_TOP, ROOM_BOTTOM, benchItems, sceneItems, stripBottom, footprint, type SceneName } from './scene.ts'

const WIDTH = 3840
const HEIGHT = stripBottom(5) + 70
const root = new URL('../public/assets/', import.meta.url)
const aspect = (name: SceneName) => {
  const folder = (SCENE_PROPS as readonly string[]).includes(name) ? 'scene-v1' : 'office-v2'
  const file = readFileSync(new URL(`${folder}/${name}.png`, root))
  return file.readUInt32BE(16) / file.readUInt32BE(20)
}

function build() {
  const bench = benchItems(WIDTH, 5)
  const built = sceneItems(WIDTH, bench)
  const solids: { name: SceneName, rect: Rect }[] = []
  for (const item of built.items) {
    if (!item.solid) continue
    const rect = footprint(item.name, item.x, item.bottom, item.height)
    if (rect) solids.push({ name: item.name, rect })
  }
  const obstacles: Rect[] = [...solids.map(s => s.rect), ...built.walls.map(w => w.rect), ...built.screens.map(s => ({ x: s.rect.x, y: s.rect.y + s.rect.h - 30, w: s.rect.w, h: 30 })), { x: 0, y: 0, w: WIDTH, h: WALK_LIMIT_TOP }]
  const grid = new Grid({ left: 65, right: WIDTH - 65, top: WALK_LIMIT_TOP, bottom: HEIGHT - 60 }, obstacles)
  return { bench, built, solids, obstacles, grid }
}

const reach = (grid: Grid, from: { x: number, y: number }, to: { x: number, y: number }) => {
  const path = grid.path(from, to)
  const end = path[path.length - 1]
  return path.length > 1 && Math.hypot(end.x - to.x, end.y - to.y) < 1
}

test('every solid object blocks its own centre and edges', () => {
  const { solids, grid } = build()
  assert.ok(solids.length > 80)
  for (const { name, rect } of solids) {
    const points = [[0.5, 0.5], [0.05, 0.5], [0.95, 0.5], [0.5, 0.05], [0.5, 0.95]]
    for (const [px, py] of points) assert.equal(grid.free(rect.x + rect.w * px, rect.y + rect.h * py), false, `${name} at ${rect.x},${rect.y}`)
  }
})

test('no walking path passes through any obstacle', () => {
  const { obstacles, grid } = build()
  const from = grid.nearestFree({ x: WIDTH / 2, y: ROOM_BOTTOM + 70 })
  let checked = 0
  for (let i = 0; i < 400; i++) {
    const to = grid.nearestFree({ x: 120 + (i * 977) % (WIDTH - 240), y: 260 + (i * 613) % (HEIGHT - 340) })
    const path = grid.path(from, to)
    for (let k = 1; k < path.length; k++) {
      const a = path[k - 1]
      const b = path[k]
      const steps = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 4)
      for (let s = 0; s <= steps; s++) {
        const x = a.x + (b.x - a.x) * s / steps
        const y = a.y + (b.y - a.y) * s / steps
        checked++
        assert.ok(!obstacles.some(r => x > r.x && x < r.x + r.w && y > r.y && y < r.y + r.h), `path ${i} enters obstacle at ${x},${y}`)
      }
    }
  }
  assert.ok(checked > 10000)
})

test('every room door and every seat can be reached from the spawn', () => {
  const { built, bench, grid } = build()
  const from = grid.nearestFree({ x: WIDTH / 2, y: ROOM_BOTTOM + 70 })
  for (const room of built.rooms) {
    const door = room.x + room.w / 2
    assert.ok(reach(grid, from, { x: door, y: ROOM_BOTTOM + 40 }), `door ${door}`)
    assert.ok(reach(grid, from, { x: door, y: ROOM_BOTTOM - 70 }), `inside ${door}`)
  }
  for (const seat of bench.seats) assert.ok(reach(grid, from, grid.nearestFree({ x: seat.x, y: seat.chair + 50 })), `seat ${seat.x},${seat.chair}`)
  assert.ok(bench.seats.length >= 30)
})

test('every seat is reachable at its exact sitting spot once its chair is taken', () => {
  const { bench, built, grid } = build()
  const taken = new Set(bench.seats.map(seat => `${seat.x},${seat.chair}`))
  const rest = built.items.filter(item => item.solid && !taken.has(`${item.x},${item.bottom}`)).map(item => footprint(item.name, item.x, item.bottom, item.height)).filter((rect): rect is Rect => rect !== undefined)
  const open = new Grid(grid.bounds, [...rest, ...built.walls.map(w => w.rect), ...built.screens.map(s => ({ x: s.rect.x, y: s.rect.y + s.rect.h - 30, w: s.rect.w, h: 30 })), { x: 0, y: 0, w: WIDTH, h: WALK_LIMIT_TOP }])
  const from = open.nearestFree({ x: WIDTH / 2, y: ROOM_BOTTOM + 70 })
  for (const seat of bench.seats) assert.ok(reach(open, from, { x: seat.x, y: seat.chair - SIT_LIFT }), `sitting spot ${seat.x},${seat.chair}`)
})

test('every asset is either solid or on the explicit non-solid list', () => {
  for (const name of [...SCENE_PROPS, ...OFFICE_PROPS]) {
    const solid = SOLID[name] !== undefined
    const free = NON_SOLID.includes(name)
    const wall = ['wall-tile', 'window'].includes(name)
    assert.ok(solid !== free || wall, `${name} must be classified exactly once`)
  }
  for (const name of NON_SOLID) assert.equal(SOLID[name], undefined, name)
})

test('every solid footprint sits on the sprite base and has a real size', () => {
  for (const name of Object.keys(SOLID) as SceneName[]) {
    const rect = footprint(name, 500, 800, 100)
    assert.ok(rect, name)
    const front = name.startsWith('desk-') || name === 'standing-desk' ? DESK_FRONT : 0
    assert.equal(Math.round(rect.y + rect.h - front), 800, `${name} base`)
    assert.ok(rect.w > 100 * aspect(name) * 0.25, `${name} width`)
    assert.ok(rect.x >= 500 - 50 * aspect(name) - 1 && rect.x + rect.w <= 500 + 50 * aspect(name) + 1, `${name} inside sprite`)
  }
})

test('negative control: a sealed target is unreachable and a wall stops a path', () => {
  const { grid, obstacles } = build()
  const from = grid.nearestFree({ x: WIDTH / 2, y: ROOM_BOTTOM + 70 })
  const sealed = new Grid(grid.bounds, [...obstacles, { x: 1000, y: 1000, w: 400, h: 20 }, { x: 1000, y: 1180, w: 400, h: 20 }, { x: 1000, y: 1000, w: 20, h: 200 }, { x: 1380, y: 1000, w: 20, h: 200 }])
  assert.equal(reach(sealed, from, { x: 1200, y: 1100 }), false)
  const rooms = build().built.rooms
  assert.equal(grid.clear({ x: 500, y: ROOM_BOTTOM + 70 }, { x: 1500, y: ROOM_BOTTOM + 70 }), true)
  assert.equal(grid.clear({ x: rooms[1].x + 40, y: 300 }, { x: rooms[1].x - 40, y: 300 }), false)
})

test('every asset used by the scene has an image', () => {
  for (const name of [...SCENE_PROPS, ...OFFICE_PROPS]) assert.ok(aspect(name) > 0, name)
})
