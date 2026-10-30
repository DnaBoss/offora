import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Grid, length, along, RADIUS } from './navigation.ts'

const bounds = { left: 0, right: 400, top: 0, bottom: 300 }
const wall = { x: 180, y: 0, w: 40, h: 220 }

test('straight line through a wall is refused and the path goes around it', () => {
  const grid = new Grid(bounds, [wall])
  assert.equal(grid.clear({ x: 60, y: 100 }, { x: 340, y: 100 }), false)
  const path = grid.path({ x: 60, y: 100 }, { x: 340, y: 100 })
  assert.ok(path.length > 2)
  for (let i = 1; i < path.length; i++) assert.ok(grid.clear(path[i - 1], path[i]))
  assert.ok(length(path) > 280)
  for (let d = 0; d <= length(path); d += 3) {
    const p = along(path, d)
    assert.ok(!(p.x > wall.x - RADIUS && p.x < wall.x + wall.w + RADIUS && p.y < wall.y + wall.h + RADIUS))
  }
})

test('negative control: without the wall the path is a straight line', () => {
  const grid = new Grid(bounds, [])
  assert.equal(grid.path({ x: 60, y: 100 }, { x: 340, y: 100 }).length, 2)
})

test('a blocked target moves to the nearest free spot', () => {
  const grid = new Grid(bounds, [wall])
  const end = grid.path({ x: 60, y: 100 }, { x: 200, y: 100 }).at(-1)
  assert.ok(end && grid.free(end.x, end.y))
})

test('keyboard movement slides along a wall and stops at other people', () => {
  const grid = new Grid(bounds, [wall])
  const start = { x: 150, y: 100 }
  const slid = grid.move(start, 10, 10)
  assert.ok(slid.y > start.y && slid.x === start.x)
  assert.deepEqual(grid.move({ x: 60, y: 260 }, 10, 0, [{ x: 90, y: 260 }]), { x: 60, y: 260 })
})
