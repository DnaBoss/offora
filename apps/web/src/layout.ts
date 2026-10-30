export type Desk = { x: number, y: number }
export type Spot = { x: number, y: number, kind: 'plantBig' | 'plantSmall' | 'plantTall' | 'shelf' | 'cabinet' | 'lamp' }
export type Layout = { desks: Desk[], spots: Spot[], rows: number, height: number }

export const DESK_PITCH = 140
export const ROW_STRIDE = 280
const MARGIN = 100
const FIRST_ROW = 100
const KINDS: Spot['kind'][] = ['plantBig', 'plantSmall', 'plantTall', 'shelf', 'cabinet', 'lamp']

export function hash(n: number) {
  let h = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  return (h ^ (h >>> 16)) >>> 0
}

function podSize(index: number) {
  const roll = hash(index * 7 + 3) % 10
  return roll < 3 ? 1 : roll < 7 ? 2 : 3
}

export function layoutDesks(count: number, width: number): Layout {
  const desks: Desk[] = []
  const spots: Spot[] = []
  let row = 0
  let pod = 0
  let cursor = MARGIN + hash(1) % 100
  let placedInRow = 0
  while (desks.length < count) {
    const size = Math.min(podSize(pod), count - desks.length)
    const span = size * DESK_PITCH - 10
    if (placedInRow > 0 && cursor + span > width - MARGIN) {
      const room = width - MARGIN - cursor
      if (room >= 140) spots.push({ x: cursor + room / 2, y: FIRST_ROW + row * ROW_STRIDE, kind: KINDS[hash(row * 5 + 11) % KINDS.length] })
      row++
      cursor = MARGIN + hash(row * 17 + 1) % 100
      placedInRow = 0
    }
    const drift = ((hash(pod * 31 + 7) % 3) - 1) * 16
    for (let i = 0; i < size; i++) desks.push({ x: cursor + i * DESK_PITCH + 65, y: FIRST_ROW + row * ROW_STRIDE + drift })
    cursor += span
    placedInRow++
    pod++
    const gap = 130 + hash(pod * 13 + 5) % 130
    if (gap >= 200 && desks.length < count) spots.push({ x: cursor + gap / 2, y: FIRST_ROW + row * ROW_STRIDE, kind: KINDS[hash(pod * 3 + 2) % KINDS.length] })
    cursor += gap
  }
  return { desks, spots, rows: row + 1, height: count ? (row + 1) * ROW_STRIDE : 0 }
}
