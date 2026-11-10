import {gsap} from 'gsap'
import {useEffect, useState} from 'react'
import {flushSync} from 'react-dom'
import {afterEach, beforeEach, describe, expect, test} from 'vitest'
import {page} from 'vitest/browser'
import {render} from 'vitest-browser-react'
import type {CleanupEvent} from './lib/cleanup-feed'
import {formatBytes} from './lib/data'
import {receiveCleanupEvents} from './lib/db'
import {film, finishedEvents, GB, Movie, movieDb, particleCanvas, visibility} from './test/movie'
import './index.css'

const MB = 1024 ** 2
const STREAM_CHUNK = 10

interface Box {
  left: number
  right: number
  top: number
  bottom: number
}

function inkBox(pixels: Uint8ClampedArray, width: number, lit: (i: number) => boolean) {
  const box = {left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity}
  for (let i = 0; i < pixels.length; i += 4) {
    if (!lit(i)) continue
    const x = (i / 4) % width
    const y = Math.floor(i / 4 / width)
    box.left = Math.min(box.left, x)
    box.right = Math.max(box.right, x + 1)
    box.top = Math.min(box.top, y)
    box.bottom = Math.max(box.bottom, y + 1)
  }
  return box
}

function toPage(box: Box, origin: DOMRect, scale: number): Box {
  return {left: origin.left + box.left / scale, right: origin.left + box.right / scale, top: origin.top + box.top / scale, bottom: origin.top + box.bottom / scale}
}

function particleBox(canvas: HTMLCanvasElement) {
  const context = canvas.getContext('2d')
  if (!context) throw new Error('no particle context')
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
  const rect = canvas.getBoundingClientRect()
  return toPage(
    inkBox(pixels, canvas.width, i => (pixels[i + 3] ?? 0) >= 128),
    rect,
    canvas.width / rect.width,
  )
}

async function domBox(figure: HTMLElement) {
  const shot = await page.screenshot({element: figure, save: false})
  const image = new Image()
  image.src = `data:image/png;base64,${shot}`
  await image.decode()
  const canvas = document.createElement('canvas')
  canvas.width = image.width
  canvas.height = image.height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('no screenshot context')
  context.drawImage(image, 0, 0)
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
  const rect = figure.getBoundingClientRect()
  return toPage(
    inkBox(pixels, canvas.width, i => (pixels[i] ?? 0) + (pixels[i + 1] ?? 0) + (pixels[i + 2] ?? 0) > 600),
    rect,
    canvas.width / rect.width,
  )
}

function handoff(figure: HTMLElement) {
  return new Promise<{frame: number; landed: Box}>(resolve => {
    const frames: number[] = []
    let last = 0
    const tick = (now: number) => {
      if (last) frames.push(now - last)
      last = now
      const canvas = particleCanvas()
      if (!canvas || Number(getComputedStyle(figure).opacity) === 0) return requestAnimationFrame(tick)
      frames.sort((a, b) => a - b)
      resolve({frame: frames[Math.floor(frames.length / 2)] ?? Infinity, landed: particleBox(canvas)})
    }
    requestAnimationFrame(tick)
  })
}

function centre(box: Box) {
  return {x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2}
}

function quickLog(count: number): CleanupEvent[] {
  const removed: CleanupEvent[] = Array.from({length: count}, (_, i) => ({
    type: 'removed',
    data: {path: `/Users/you/Library/Caches/quick-${i}`, bytes: 2 * MB, secs: 0.01, elapsed_ms: 1 + i * 30},
  }))
  return [
    {type: 'started', data: {run: 'run-1', free: 50 * GB, paths: count, worktrees: 0, commands: 0, bytes: count * 2 * MB, elapsed_ms: 0}},
    ...removed,
    {type: 'done', data: {free_before: 50 * GB, free_after: 50 * GB + count * 2 * MB, elapsed_ms: 1000}},
  ]
}

interface Sample {
  items: number
  ms: number
}

function Streamed({log, steps}: {log: readonly CleanupEvent[]; steps: Sample[]}) {
  const [cleanup] = useState(() => movieDb())
  useEffect(() => {
    let sent = 0
    let frame = 0
    const step = () => {
      const next = log.slice(sent, sent + STREAM_CHUNK)
      sent += next.length
      const start = performance.now()
      flushSync(() => receiveCleanupEvents(cleanup, next))
      steps.push({items: sent, ms: performance.now() - start})
      if (sent < log.length) frame = requestAnimationFrame(step)
    }
    frame = requestAnimationFrame(step)
    return () => cancelAnimationFrame(frame)
  }, [log, steps, cleanup])
  return <Movie db={cleanup} />
}

function timeTicks(into: Sample[], items: () => number) {
  let start = 0
  const open = () => {
    start = performance.now()
  }
  const close = () => {
    into.push({items: items(), ms: performance.now() - start})
  }
  gsap.ticker.add(open, false, true)
  gsap.ticker.add(close)
  return () => {
    gsap.ticker.remove(open)
    gsap.ticker.remove(close)
  }
}

function leastWork(samples: readonly Sample[], from: number, to: number) {
  const work = samples.filter(s => s.items > from && s.items <= to).map(s => s.ms)
  return work.toSorted((a, b) => a - b)[Math.floor(work.length / 10)] ?? Infinity
}

async function streamWork(count: number) {
  const steps: Sample[] = []
  const ticks: Sample[] = []
  const stop = timeTicks(ticks, () => steps.at(-1)?.items ?? 0)
  const screen = await render(<Streamed log={quickLog(count)} steps={steps} />)
  await expect.poll(() => visibility('finale'), {timeout: 40_000}).toBe('visible')
  stop()
  await screen.unmount()
  return {steps, ticks}
}

describe('the cleanup movie in real time', () => {
  beforeEach(() => {
    document.documentElement.classList.add('dark')
  })
  afterEach(() => {
    document.documentElement.classList.remove('dark')
    gsap.globalTimeline.timeScale(1)
  })

  test('at real speed the particles land on the DOM figure before it fades in over them', async () => {
    const screen = await render(<Movie db={movieDb(finishedEvents)} />)
    await expect.poll(particleCanvas, {timeout: 15_000}).not.toBeNull()
    const figure = film('freed')
    if (!figure) throw new Error('no finale figure')
    const {frame, landed} = await handoff(figure)
    expect(frame).toBeLessThan(34)
    await expect.poll(particleCanvas, {timeout: 5_000}).toBeNull()
    const text = await domBox(figure)
    const [a, b] = [centre(landed), centre(text)]
    expect(Math.abs(a.x - b.x), `frame ${frame} centre x ${JSON.stringify(landed)} vs ${JSON.stringify(text)}`).toBeLessThanOrEqual(1.5)
    expect(Math.abs(a.y - b.y), `centre y ${a.y} vs ${b.y}`).toBeLessThanOrEqual(1.5)
    for (const side of ['left', 'right', 'top', 'bottom'] as const) expect(Math.abs(landed[side] - text[side]), `${side} ${landed[side]} vs ${text[side]}`).toBeLessThanOrEqual(2.5)
    await expect.element(screen.getByRole('heading', {name: 'You freed'})).toBeVisible()
    expect(figure.textContent).toBe(formatBytes(3.5 * GB))
  }, 30_000)

  test('a cleanup that took a second still plays back as several beats over the minimum length', async () => {
    gsap.globalTimeline.timeScale(4)
    const quick = movieDb(quickLog(30))
    const labels = new Set<string>()
    const watch = new MutationObserver(() => {
      for (const el of document.querySelectorAll('[data-film="card"] [data-part="label"]')) if (el.textContent) labels.add(el.textContent)
    })
    watch.observe(document.body, {subtree: true, childList: true, characterData: true})
    let counted = 0
    let shown = 0
    const counter = new MutationObserver(() => {
      counted = performance.now()
    })
    const finale = new MutationObserver(() => {
      if (!shown && visibility('finale') === 'visible') shown = performance.now()
    })
    await render(<Movie db={quick} />)
    await expect.poll(() => visibility('stage'), {timeout: 10_000}).toBe('visible')
    const start = performance.now()
    counter.observe(film('counter') ?? document.body, {subtree: true, childList: true, characterData: true})
    finale.observe(film('finale') ?? document.body, {attributes: true, attributeFilter: ['style']})
    await expect.poll(() => shown, {timeout: 20_000}).toBeGreaterThan(0)
    const deleting = ((shown - start) / 1000) * 4
    watch.disconnect()
    counter.disconnect()
    finale.disconnect()
    expect(deleting).toBeGreaterThanOrEqual(6)
    expect(labels.size).toBeGreaterThanOrEqual(20)
    expect(((shown - counted) / 1000) * 4, 'film seconds between the last count and the finale').toBeLessThan(1)
    expect(film('trays')).toBeNull()
  }, 30_000)

  test('streaming 3000 removals costs as little work per frame at the end as in the first 300', async () => {
    gsap.globalTimeline.timeScale(4)
    const work = await streamWork(3000)
    for (const [name, samples] of Object.entries(work)) {
      const first = leastWork(samples, 0, 300)
      const last = leastWork(samples, 2700, Infinity)
      expect.soft(last, `${name}: ${last.toFixed(2)} ms of work per frame at 3000 items against ${first.toFixed(2)} ms in the first 300`).toBeLessThan(first * 2 + 2)
    }
  }, 90_000)
})
