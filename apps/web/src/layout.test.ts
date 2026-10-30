import assert from 'node:assert/strict'
import { test } from 'node:test'
import { layoutDesks, DESK_PITCH } from './layout.ts'

const width = 1280

test('adding members never moves existing desks', () => {
  const small = layoutDesks(7, width).desks
  const large = layoutDesks(20, width).desks
  assert.deepEqual(large.slice(0, 7).map(d => d.x), small.map(d => d.x))
})

test('desks never overlap and stay inside the room', () => {
  const { desks } = layoutDesks(30, width)
  assert.equal(desks.length, 30)
  for (const a of desks) assert.ok(a.x - 65 >= 0 && a.x + 65 <= width)
  for (let i = 0; i < desks.length; i++) for (let j = i + 1; j < desks.length; j++) {
    const dx = Math.abs(desks[i].x - desks[j].x)
    const dy = Math.abs(desks[i].y - desks[j].y)
    assert.ok(dx >= 130 || dy >= 140, `${i} and ${j} overlap`)
  }
})

test('the arrangement mixes side-by-side groups with lone desks', () => {
  const { desks } = layoutDesks(24, width)
  const groups: number[] = []
  let run = 1
  for (let i = 1; i < desks.length; i++) {
    const next = Math.abs(desks[i].x - desks[i - 1].x - DESK_PITCH) < 1 && Math.abs(desks[i].y - desks[i - 1].y) < 1
    if (next) run++
    else { groups.push(run); run = 1 }
  }
  groups.push(run)
  assert.ok(groups.includes(1) && groups.some(size => size >= 2), JSON.stringify(groups))
  assert.ok(new Set(desks.map(d => d.y)).size > 4)
})

test('aisle between rows stays wide enough to walk', () => {
  const { desks } = layoutDesks(40, width)
  const ys = [...new Set(desks.map(d => d.y))].sort((a, b) => a - b)
  for (let i = 1; i < ys.length; i++) assert.ok(ys[i] - ys[i - 1] >= 0 && (ys[i] - ys[i - 1] >= 248 || ys[i] - ys[i - 1] <= 32))
})
