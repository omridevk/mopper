/*
  Flow Field with Particle Trails from Radiant (https://github.com/pbakaus/radiant)
  MIT License
  Copyright (c) 2025 Paul Bakaus
  Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
  documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
  rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit
  persons to whom the Software is furnished to do so, subject to the following conditions:
  The above copyright notice and this permission notice shall be included in all copies or substantial portions of the
  Software.
  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
  WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
  COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
  OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
*/
import {useCanvasRenderer, type Renderer} from '@/lib/canvas-loop'

const F3 = 1 / 3
const G3 = 1 / 6
const GRAD3 = [
  [1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0],
  [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1],
  [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1],
]

const FADE = 'rgba(0, 0, 0, 0.03)'
const SWEEP = 'rgba(0, 0, 0, 0.1)'
const SWEEP_EVERY = 6
const PALETTE = [
  {r: 96, g: 165, b: 250},
  {r: 59, g: 130, b: 246},
  {r: 37, g: 99, b: 235},
  {r: 96, g: 165, b: 250},
  {r: 147, g: 197, b: 253},
  {r: 59, g: 130, b: 246},
  {r: 29, g: 78, b: 216},
]
const REFERENCE_AREA = 1440 * 900
const PARTICLES_PER_REFERENCE = 4000
const MIN_PARTICLES = 240
const NOISE_SCALE = 0.0025
const SPEED = 1.2
const STILL_STEPS = 160

type Rgb = {r: number; g: number; b: number}
type Particle = {x: number; y: number; speed: number; alpha: number; size: number}

function permutation(start: number) {
  const perm = new Uint8Array(512)
  const permMod12 = new Uint8Array(512)
  const p = new Uint8Array(256)
  let seed = start
  for (let i = 0; i < 256; i++) p[i] = i
  for (let i = 255; i > 0; i--) {
    seed = (seed * 16807) % 2147483647
    const j = seed % (i + 1)
    const tmp = p[i] ?? 0
    p[i] = p[j] ?? 0
    p[j] = tmp
  }
  for (let i = 0; i < 512; i++) {
    perm[i] = p[i & 255] ?? 0
    permMod12[i] = (perm[i] ?? 0) % 12
  }
  return {perm, permMod12}
}

function corner(gi: number, x: number, y: number, z: number) {
  let t = 0.6 - x * x - y * y - z * z
  if (t < 0) return 0
  const g = GRAD3[gi] ?? [0, 0, 0]
  t *= t
  return t * t * ((g[0] ?? 0) * x + (g[1] ?? 0) * y + (g[2] ?? 0) * z)
}

function simplexOffsets(x0: number, y0: number, z0: number) {
  if (x0 >= y0) {
    if (y0 >= z0) return [1, 0, 0, 1, 1, 0]
    if (x0 >= z0) return [1, 0, 0, 1, 0, 1]
    return [0, 0, 1, 1, 0, 1]
  }
  if (y0 < z0) return [0, 0, 1, 0, 1, 1]
  if (x0 < z0) return [0, 1, 0, 0, 1, 1]
  return [0, 1, 0, 1, 1, 0]
}

function createNoise(seed: number) {
  const {perm, permMod12} = permutation(seed)
  const at = (table: Uint8Array, index: number) => table[index] ?? 0
  return (xin: number, yin: number, zin: number) => {
    const s = (xin + yin + zin) * F3
    const i = Math.floor(xin + s)
    const j = Math.floor(yin + s)
    const k = Math.floor(zin + s)
    const t = (i + j + k) * G3
    const x0 = xin - (i - t)
    const y0 = yin - (j - t)
    const z0 = zin - (k - t)
    const [i1 = 0, j1 = 0, k1 = 0, i2 = 0, j2 = 0, k2 = 0] = simplexOffsets(x0, y0, z0)
    const ii = i & 255
    const jj = j & 255
    const kk = k & 255
    const g0 = at(permMod12, ii + at(perm, jj + at(perm, kk)))
    const g1 = at(permMod12, ii + i1 + at(perm, jj + j1 + at(perm, kk + k1)))
    const g2 = at(permMod12, ii + i2 + at(perm, jj + j2 + at(perm, kk + k2)))
    const g3 = at(permMod12, ii + 1 + at(perm, jj + 1 + at(perm, kk + 1)))
    return (
      32 *
      (corner(g0, x0, y0, z0) +
        corner(g1, x0 - i1 + G3, y0 - j1 + G3, z0 - k1 + G3) +
        corner(g2, x0 - i2 + 2 * G3, y0 - j2 + 2 * G3, z0 - k2 + 2 * G3) +
        corner(g3, x0 - 1 + 3 * G3, y0 - 1 + 3 * G3, z0 - 1 + 3 * G3))
    )
  }
}

function colorOf(noiseValue: number): Rgb {
  const index = ((noiseValue + 1) / 2) * (PALETTE.length - 1)
  const i = Math.floor(index)
  const f = index - i
  const a = PALETTE[Math.min(i, PALETTE.length - 1)] ?? PALETTE[0]
  const b = PALETTE[Math.min(i + 1, PALETTE.length - 1)] ?? PALETTE[0]
  if (!a || !b) return {r: 0, g: 0, b: 0}
  return {r: a.r + (b.r - a.r) * f, g: a.g + (b.g - a.g) * f, b: a.b + (b.b - a.b) * f}
}

function createFlowField(canvas: HTMLCanvasElement): Renderer | null {
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  const noise = createNoise(42)
  let width = 0
  let height = 0
  let time = 0
  let frames = 0
  let particles: Particle[] = []

  const spawn = (): Particle => ({
    x: Math.random() * width,
    y: Math.random() * height,
    speed: 0.4 + Math.random() * 1.0,
    alpha: 0.15 + Math.random() * 0.55,
    size: 0.5 + Math.random() * 1.5,
  })

  const step = () => {
    ctx.globalCompositeOperation = 'destination-out'
    frames++
    ctx.fillStyle = frames % SWEEP_EVERY === 0 ? SWEEP : FADE
    ctx.fillRect(0, 0, width, height)
    ctx.globalCompositeOperation = 'source-over'
    time += 0.0008
    for (const p of particles) {
      const nx = p.x * NOISE_SCALE
      const ny = p.y * NOISE_SCALE
      const angle = noise(nx, ny, time) * Math.PI * 2
      const color = colorOf(noise(nx * 1.5 + 100, ny * 1.5 + 100, time * 0.5))
      const px = p.x
      const py = p.y
      p.x += Math.cos(angle) * p.speed * SPEED
      p.y += Math.sin(angle) * p.speed * SPEED
      ctx.beginPath()
      ctx.moveTo(px, py)
      ctx.lineTo(p.x, p.y)
      ctx.strokeStyle = `rgba(${Math.round(color.r)},${Math.round(color.g)},${Math.round(color.b)},${p.alpha})`
      ctx.lineWidth = p.size
      ctx.stroke()
      if (p.x < -20 || p.x > width + 20 || p.y < -20 || p.y > height + 20) {
        p.x = Math.random() * width
        p.y = Math.random() * height
      }
    }
  }

  return {
    resize: (w, h, dpr) => {
      width = w
      height = h
      canvas.width = Math.max(1, Math.round(w * dpr))
      canvas.height = Math.max(1, Math.round(h * dpr))
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      const count = Math.max(MIN_PARTICLES, Math.round((PARTICLES_PER_REFERENCE * w * h) / REFERENCE_AREA))
      particles = Array.from({length: count}, spawn)
    },
    frame: step,
    still: () => {
      for (let i = 0; i < STILL_STEPS; i++) step()
    },
    dispose: () => {
      canvas.width = 0
      canvas.height = 0
    },
  }
}

export function FlowField({className}: {className?: string}) {
  const {host, canvas, failed} = useCanvasRenderer(createFlowField)
  if (failed) return null
  return (
    <div ref={host} aria-hidden className={className}>
      <canvas ref={canvas} className="block size-full" />
    </div>
  )
}
