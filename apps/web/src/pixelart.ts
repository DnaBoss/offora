import { Texture } from 'pixi.js'

const SCALE = 6
const TILE_SCALE = 4
export const WALL_HEIGHT = 192
export const HEAD_HEIGHT = 450

type Op = [string, number, number, number, number]
export type PropKind = 'plantBig' | 'plantSmall' | 'plantTall' | 'shelf' | 'cabinet' | 'lamp'
export type HeadKind = 'fridge' | 'shelf' | 'counter' | 'bookcase' | 'cabinet' | 'plantBig' | 'rugGreen' | 'rugPurple' | 'roundTable' | 'stool' | 'sofa' | 'coffeeTable' | 'window' | 'picture' | 'clock'
export type HeadItem = { kind: HeadKind, x: number, bottom: number, foot: number }

function paint(w: number, h: number, ops: Op[], scale = SCALE): Texture {
  const canvas = document.createElement('canvas')
  canvas.width = w * scale
  canvas.height = h * scale
  const context = canvas.getContext('2d')
  if (context) for (const [color, x, y, width, height] of ops) {
    context.fillStyle = color
    context.fillRect(x * scale, y * scale, width * scale, height * scale)
  }
  const texture = Texture.from(canvas)
  texture.source.scaleMode = 'nearest'
  return texture
}

function floorTile(): Texture {
  const line = '#cb9360'
  const ops: Op[] = [['#d9a066', 0, 0, 32, 16], [line, 0, 7, 32, 1], [line, 0, 15, 32, 1], [line, 11, 0, 1, 7], [line, 26, 8, 1, 7], ['#e2ac72', 2, 2, 6, 1], ['#e2ac72', 15, 4, 8, 1], ['#e2ac72', 4, 10, 9, 1], ['#e2ac72', 18, 12, 6, 1], ['#d29a62', 24, 1, 5, 1], ['#d29a62', 1, 5, 4, 1], ['#d29a62', 14, 9, 5, 1], ['#d29a62', 28, 13, 3, 1]]
  return paint(32, 16, ops, TILE_SCALE)
}

function wallTile(): Texture {
  return paint(16, 16, [['#f0dcb4', 0, 0, 16, 16], ['#e6cf9e', 0, 0, 1, 16], ['#e6cf9e', 8, 0, 1, 16], ['#f7e8c6', 4, 3, 1, 1], ['#f7e8c6', 12, 9, 1, 1]], TILE_SCALE)
}

function plant(w: number, h: number, pot: number, leaf: string): Texture {
  const ops: Op[] = [['#8a5530', Math.floor((w - 6) / 2), h - pot, 6, pot], ['#a06a3e', Math.floor((w - 6) / 2), h - pot, 6, 1]]
  const top = h - pot
  for (let y = 0; y < top; y++) {
    const span = Math.max(2, Math.round(w * (0.45 + 0.55 * Math.sin(Math.PI * (y + 1) / (top + 1)))))
    ops.push([y % 2 ? leaf : '#3f8f4a', Math.floor((w - span) / 2), y, span, 1])
  }
  ops.push(['#6fc26b', Math.floor(w / 2) - 1, 1, 2, 1], ['#2f6f3a', Math.floor(w / 2), top - 2, 1, 2])
  return paint(w, h, ops)
}

function shelf(w: number, h: number): Texture {
  const ops: Op[] = [['#7a4a28', 0, 0, w, h], ['#a06a3e', 1, 1, w - 2, h - 2]]
  const books = ['#c2503f', '#3f7fc2', '#e0b341', '#4f9f6a', '#8a5fb8', '#e8e0cf']
  for (let row = 0; row < Math.floor((h - 2) / 6); row++) {
    const y = 2 + row * 6
    ops.push(['#5e3a1e', 1, y + 5, w - 2, 1])
    for (let x = 2; x < w - 2; x += 2) ops.push([books[(x + row * 3) % books.length], x, y + (x % 3 === 0 ? 1 : 0), 1, x % 3 === 0 ? 4 : 5])
  }
  return paint(w, h, ops)
}

function cabinet(w: number, h: number): Texture {
  return paint(w, h, [['#6f7f8f', 0, 0, w, h], ['#8fa1b2', 1, 1, w - 2, h - 2], ['#6f7f8f', 1, Math.floor(h / 2), w - 2, 1], ['#e8eef3', Math.floor(w / 2) - 1, Math.floor(h / 4), 2, 1], ['#e8eef3', Math.floor(w / 2) - 1, Math.floor(h * 3 / 4), 2, 1]])
}

function lamp(): Texture {
  return paint(6, 16, [['#f6e08a', 0, 0, 6, 4], ['#fff3b8', 1, 1, 4, 2], ['#5a4a3a', 3, 4, 1, 10], ['#5a4a3a', 1, 14, 5, 2]])
}

function desk(): Texture {
  const ops: Op[] = [
    ['#2b3a47', 9, 0, 14, 10], ['#6fd0d9', 10, 1, 12, 8], ['#a6ecf0', 11, 2, 5, 1], ['#4aa8b4', 11, 5, 9, 1], ['#4aa8b4', 11, 7, 6, 1],
    ['#2b3a47', 14, 10, 4, 2], ['#2b3a47', 12, 12, 8, 1],
    ['#a56d3c', 1, 13, 30, 3], ['#c98f55', 1, 13, 30, 1], ['#8a5530', 2, 16, 2, 8], ['#8a5530', 28, 16, 2, 8], ['#8a5530', 1, 16, 30, 1],
    ['#3d4b57', 8, 14, 14, 1], ['#e8e0cf', 25, 11, 3, 2], ['#c2503f', 25, 11, 3, 1],
    ['#3f5a7a', 8, 23, 16, 8], ['#4f6f95', 9, 24, 14, 3], ['#2d4259', 8, 31, 16, 1], ['#2d4259', 11, 32, 2, 2], ['#2d4259', 19, 32, 2, 2]
  ]
  return paint(32, 35, ops)
}

function counter(): Texture {
  return paint(28, 14, [['#8a5530', 0, 3, 28, 11], ['#c98f55', 0, 3, 28, 2], ['#a56d3c', 1, 6, 26, 7], ['#6f4524', 13, 6, 1, 7], ['#e8e0cf', 4, 0, 5, 3], ['#2b3a47', 18, 0, 6, 3], ['#c2503f', 19, 1, 1, 1]])
}

function fridge(): Texture {
  return paint(12, 24, [['#aab8c4', 0, 0, 12, 24], ['#dfe8ee', 1, 1, 10, 22], ['#aab8c4', 1, 8, 10, 1], ['#7b8a97', 9, 3, 1, 3], ['#7b8a97', 9, 11, 1, 6], ['#7b8a97', 0, 23, 12, 1]])
}

function bookcase(): Texture {
  return shelf(24, 24)
}

function windowArt(): Texture {
  return paint(20, 14, [['#7a4a28', 0, 0, 20, 14], ['#8fd3f0', 1, 1, 18, 12], ['#c8ecf9', 2, 2, 6, 3], ['#c8ecf9', 11, 7, 6, 3], ['#7a4a28', 9, 1, 2, 12], ['#7a4a28', 1, 7, 18, 1]])
}

function picture(): Texture {
  return paint(10, 8, [['#7a4a28', 0, 0, 10, 8], ['#a8d8b0', 1, 1, 8, 6], ['#6fb27a', 2, 4, 6, 3], ['#f6e08a', 7, 2, 1, 1]])
}

function clock(): Texture {
  return paint(7, 7, [['#7a4a28', 1, 0, 5, 7], ['#7a4a28', 0, 1, 7, 5], ['#fff8e6', 1, 1, 5, 5], ['#2b3a47', 3, 2, 1, 2], ['#2b3a47', 3, 3, 2, 1]])
}

function rug(border: string, fill: string, w: number, h: number): Texture {
  return paint(w, h, [[border, 0, 0, w, h], [fill, 1, 1, w - 2, h - 2], [border, 3, 3, w - 6, 1], [border, 3, h - 4, w - 6, 1], [border, 3, 3, 1, h - 6], [border, w - 4, 3, 1, h - 6]])
}

function roundTable(): Texture {
  return paint(14, 10, [['#8a5530', 2, 0, 10, 10], ['#8a5530', 0, 2, 14, 6], ['#c98f55', 2, 1, 10, 6], ['#c98f55', 1, 2, 12, 4], ['#a56d3c', 4, 8, 6, 2]])
}

function stool(): Texture {
  return paint(5, 6, [['#c2503f', 0, 0, 5, 3], ['#e07a6a', 1, 0, 3, 1], ['#5a4a3a', 1, 3, 1, 3], ['#5a4a3a', 3, 3, 1, 3]])
}

function sofa(): Texture {
  return paint(28, 12, [['#5d4a8a', 0, 0, 28, 12], ['#7a63ad', 2, 1, 24, 5], ['#8a75c0', 3, 2, 10, 3], ['#8a75c0', 15, 2, 10, 3], ['#4a3a72', 0, 6, 28, 6], ['#6a55a0', 3, 7, 22, 4], ['#4a3a72', 0, 0, 3, 12], ['#4a3a72', 25, 0, 3, 12]])
}

function coffeeTable(): Texture {
  return paint(12, 7, [['#8a5530', 0, 0, 12, 7], ['#c98f55', 1, 1, 10, 4], ['#e8e0cf', 3, 2, 3, 2], ['#c2503f', 8, 2, 2, 2]])
}

export type Art = {
  floor: Texture
  wall: Texture
  desk: Texture
  props: Record<PropKind, Texture>
  head: Record<HeadKind, Texture>
}

export function makeArt(): Art {
  return {
    floor: floorTile(),
    wall: wallTile(),
    desk: desk(),
    props: { plantBig: plant(14, 22, 7, '#56ad5a'), plantSmall: plant(9, 12, 5, '#56ad5a'), plantTall: plant(8, 20, 5, '#4f9f6a'), shelf: shelf(14, 20), cabinet: cabinet(14, 12), lamp: lamp() },
    head: { fridge: fridge(), shelf: shelf(14, 24), counter: counter(), bookcase: bookcase(), cabinet: cabinet(14, 12), plantBig: plant(14, 22, 7, '#56ad5a'), rugGreen: rug('#2f6f3a', '#4f9f5a', 48, 28), rugPurple: rug('#4a3a72', '#6a55a0', 52, 30), roundTable: roundTable(), stool: stool(), sofa: sofa(), coffeeTable: coffeeTable(), window: windowArt(), picture: picture(), clock: clock() }
  }
}

export const HEAD_ITEMS: HeadItem[] = [
  { kind: 'window', x: 480, bottom: 118, foot: 0 },
  { kind: 'window', x: 800, bottom: 118, foot: 0 },
  { kind: 'picture', x: 640, bottom: 118, foot: 0 },
  { kind: 'clock', x: 920, bottom: 90, foot: 0 },
  { kind: 'fridge', x: 60, bottom: 220, foot: 0.4 },
  { kind: 'shelf', x: 140, bottom: 220, foot: 0.4 },
  { kind: 'counter', x: 270, bottom: 224, foot: 0.7 },
  { kind: 'bookcase', x: 1090, bottom: 224, foot: 0.4 },
  { kind: 'cabinet', x: 1230, bottom: 220, foot: 0.7 },
  { kind: 'plantBig', x: 40, bottom: 440, foot: 0.4 },
  { kind: 'plantBig', x: 1245, bottom: 440, foot: 0.4 },
  { kind: 'rugGreen', x: 430, bottom: 410, foot: 0 },
  { kind: 'roundTable', x: 430, bottom: 365, foot: 0.7 },
  { kind: 'stool', x: 360, bottom: 372, foot: 0.7 },
  { kind: 'stool', x: 500, bottom: 372, foot: 0.7 },
  { kind: 'stool', x: 430, bottom: 408, foot: 0.7 },
  { kind: 'rugPurple', x: 1000, bottom: 420, foot: 0 },
  { kind: 'sofa', x: 1000, bottom: 340, foot: 0.8 },
  { kind: 'coffeeTable', x: 1000, bottom: 395, foot: 0.8 }
]
