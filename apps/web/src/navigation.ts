export type Point = { x: number, y: number }
export type Rect = { x: number, y: number, w: number, h: number }
export type Bounds = { left: number, right: number, top: number, bottom: number }

export const CELL = 20
export const RADIUS = 22
export const PERSON_GAP = 44

export class Grid {
  readonly cols: number
  readonly rows: number
  readonly bounds: Bounds
  readonly rects: Rect[]
  private readonly walkable: Uint8Array

  constructor(bounds: Bounds, rects: Rect[]) {
    this.bounds = bounds
    this.rects = rects
    this.cols = Math.max(1, Math.ceil((bounds.right - bounds.left) / CELL))
    this.rows = Math.max(1, Math.ceil((bounds.bottom - bounds.top) / CELL))
    this.walkable = new Uint8Array(this.cols * this.rows)
    for (let row = 0; row < this.rows; row++) for (let col = 0; col < this.cols; col++) {
      const center = this.center(col, row)
      this.walkable[row * this.cols + col] = this.free(center.x, center.y) ? 1 : 0
    }
  }

  free(x: number, y: number) {
    const { left, right, top, bottom } = this.bounds
    if (x < left || x > right || y < top || y > bottom) return false
    return !this.rects.some(r => x > r.x - RADIUS && x < r.x + r.w + RADIUS && y > r.y - RADIUS && y < r.y + r.h + RADIUS)
  }

  clear(a: Point, b: Point) {
    const length = Math.hypot(b.x - a.x, b.y - a.y)
    const steps = Math.max(1, Math.ceil(length / 6))
    for (let i = 1; i <= steps; i++) {
      const t = i / steps
      if (!this.free(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t)) return false
    }
    return true
  }

  private center(col: number, row: number): Point {
    return { x: this.bounds.left + (col + 0.5) * CELL, y: this.bounds.top + (row + 0.5) * CELL }
  }

  private cellOf(p: Point) {
    return {
      col: Math.max(0, Math.min(this.cols - 1, Math.floor((p.x - this.bounds.left) / CELL))),
      row: Math.max(0, Math.min(this.rows - 1, Math.floor((p.y - this.bounds.top) / CELL)))
    }
  }

  private open(col: number, row: number) {
    return col >= 0 && row >= 0 && col < this.cols && row < this.rows && this.walkable[row * this.cols + col] === 1
  }

  nearestFree(p: Point): Point {
    if (this.free(p.x, p.y)) return p
    const start = this.cellOf(p)
    for (let ring = 0; ring < Math.max(this.cols, this.rows); ring++) {
      let best: Point | undefined
      let bestDistance = Infinity
      for (let row = start.row - ring; row <= start.row + ring; row++) for (let col = start.col - ring; col <= start.col + ring; col++) {
        if (Math.max(Math.abs(col - start.col), Math.abs(row - start.row)) !== ring || !this.open(col, row)) continue
        const c = this.center(col, row)
        const distance = Math.hypot(c.x - p.x, c.y - p.y)
        if (distance < bestDistance) { best = c; bestDistance = distance }
      }
      if (best) return best
    }
    return p
  }

  path(from: Point, to: Point): Point[] {
    const goal = this.nearestFree(to)
    if (this.clear(from, goal)) return [from, goal]
    const start = this.cellOf(this.nearestFree(from))
    const end = this.cellOf(goal)
    const previous = new Int32Array(this.cols * this.rows).fill(-1)
    const startIndex = start.row * this.cols + start.col
    const endIndex = end.row * this.cols + end.col
    previous[startIndex] = startIndex
    const queue = [startIndex]
    for (let head = 0; head < queue.length && previous[endIndex] < 0; head++) {
      const index = queue[head]
      const col = index % this.cols
      const row = Math.floor(index / this.cols)
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        if (!dr && !dc) continue
        const nc = col + dc
        const nr = row + dr
        if (!this.open(nc, nr) || (dr && dc && (!this.open(col + dc, row) || !this.open(col, row + dr)))) continue
        const next = nr * this.cols + nc
        if (previous[next] >= 0) continue
        previous[next] = index
        queue.push(next)
      }
    }
    if (previous[endIndex] < 0) return [from, from]
    const cells: Point[] = []
    for (let index = endIndex; index !== startIndex; index = previous[index]) cells.unshift(this.center(index % this.cols, Math.floor(index / this.cols)))
    const points = [from, ...cells, goal]
    const smooth = [from]
    let i = 0
    while (i < points.length - 1) {
      let j = points.length - 1
      while (j > i + 1 && !this.clear(points[i], points[j])) j--
      smooth.push(points[j])
      i = j
    }
    return smooth
  }

  move(from: Point, dx: number, dy: number, others: Point[] = []): Point {
    const ok = (x: number, y: number) => this.free(x, y) && !others.some(o => Math.hypot(o.x - x, o.y - y) < PERSON_GAP)
    if (ok(from.x + dx, from.y + dy)) return { x: from.x + dx, y: from.y + dy }
    if (dx && ok(from.x + dx, from.y)) return { x: from.x + dx, y: from.y }
    if (dy && ok(from.x, from.y + dy)) return { x: from.x, y: from.y + dy }
    return from
  }
}

export function length(points: Point[]) {
  let total = 0
  for (let i = 1; i < points.length; i++) total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y)
  return total
}

export function along(points: Point[], distance: number): Point {
  let left = distance
  for (let i = 1; i < points.length; i++) {
    const segment = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y)
    if (left <= segment && segment > 0) {
      const t = left / segment
      return { x: points[i - 1].x + (points[i].x - points[i - 1].x) * t, y: points[i - 1].y + (points[i].y - points[i - 1].y) * t }
    }
    left -= segment
  }
  return points[points.length - 1]
}
