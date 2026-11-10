import {describe, expect, test} from 'vitest'
import {commands, userEvent} from 'vitest/browser'
import {render} from 'vitest-browser-react'
import {App} from './App'
import type {Loaded} from './lib/data'
import {at, bigSection, withSection} from './test/fixture'
import {fakeEventSource} from './test/page'
import './index.css'

const ROWS = 12_000
const STREAMED = 12_000
const PER_FRAME = 120
const INTERACTION_BUDGET = 100
const STREAM_BUDGET = 50
const BROWSER = navigator.userAgent.includes('Firefox') ? 'firefox' : 'chromium'
const MOTION = matchMedia('(prefers-reduced-motion: reduce)').matches ? 'reduced motion' : 'motion'

interface Frames {
  max: number
  p95: number
  over50: number
  frames: number
}

function frameRecorder() {
  const gaps: number[] = []
  const state = {last: performance.now(), on: true}
  const tick = (now: number) => {
    gaps.push(now - state.last)
    state.last = now
    if (state.on) requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
  return {
    reset: () => {
      gaps.length = 0
      state.last = performance.now()
    },
    read: (): Frames => {
      const sorted = gaps.toSorted((a, b) => a - b)
      return {max: Math.round(sorted.at(-1) ?? 0), p95: Math.round(sorted[Math.floor(sorted.length * 0.95)] ?? 0), over50: gaps.filter(gap => gap > 50).length, frames: gaps.length}
    },
    stop: () => {
      state.on = false
    },
  }
}

const settle = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

type Recorder = ReturnType<typeof frameRecorder>

async function measure(recorder: Recorder, results: Record<string, Frames>, label: string, action: () => Promise<unknown>, after = 600) {
  await settle(300)
  recorder.reset()
  await action()
  await settle(after)
  results[label] = recorder.read()
}

function send(source: EventTarget, type: string, data: object) {
  source.dispatchEvent(new MessageEvent(type, {data: JSON.stringify(data)}))
}

const footer = () => document.querySelector('footer')?.textContent ?? ''

function expectWithin(results: Record<string, Frames>, budget: number, labels: readonly string[]) {
  for (const label of labels) expect.soft(results[label]?.max ?? Infinity, `${BROWSER} ${MOTION} ${label}: ${JSON.stringify(results[label])}`).toBeLessThanOrEqual(budget)
}

declare module 'vitest/browser' {
  interface BrowserCommands {
    startWalk: () => Promise<{files: number}>
    stopWalk: () => Promise<{walks: number}>
  }
}

async function sectionInteractions(during: string) {
  const screen = await render(<App loaded={withSection(bigSection(ROWS))} history={at()} />)
  await expect.element(screen.getByText('~/Library/Caches/app-a')).toBeVisible()
  const recorder = frameRecorder()
  const results: Record<string, Frames> = {}
  await measure(recorder, results, 'open section', async () => {
    await screen.getByRole('link', {name: /^Your macOS temp/}).click()
    await expect.element(screen.getByRole('heading', {name: 'Your macOS temp'})).toBeVisible()
  })
  const filter = screen.getByRole('textbox', {name: 'Filter paths'})
  await measure(recorder, results, 'filter first keystrokes', async () => {
    await filter.click()
    for (const key of ['i', 't', 'e', 'm']) {
      await userEvent.keyboard(key)
      await settle(120)
    }
  }, 900)
  await measure(recorder, results, 'filter cleared', () => userEvent.keyboard('{Escape}'), 900)
  await measure(recorder, results, 'only selected', () => screen.getByRole('button', {name: 'Only selected'}).click())
  await measure(recorder, results, 'only selected off', () => screen.getByRole('button', {name: 'Only selected'}).click())
  await measure(recorder, results, 'risk toggle', () => screen.getByRole('button', {name: 'safe', exact: true}).click())
  await measure(recorder, results, 'risk toggle off', () => screen.getByRole('button', {name: 'safe', exact: true}).click())
  await measure(recorder, results, 'sort by name', async () => {
    await screen.getByRole('combobox', {name: 'Sort'}).click()
    await screen.getByRole('option', {name: 'Name'}).click()
  })
  await measure(recorder, results, 'sort by size', async () => {
    await screen.getByRole('combobox', {name: 'Sort'}).click()
    await screen.getByRole('option', {name: 'Largest first'}).click()
  })
  recorder.stop()
  await screen.unmount()
  for (const [label, frames] of Object.entries(results)) console.log(`${BROWSER} ${MOTION} ${during} frames ${label}: ${JSON.stringify(frames)}`)
  expectWithin(results, INTERACTION_BUDGET, Object.keys(results))
}

describe(`frames on a ${ROWS.toLocaleString()}-row section`, () => {
  test('opening it, filtering, only-selected, the risk toggle and sorting keep every frame within budget', async () => {
    await sectionInteractions('idle')
  }, 120_000)

  test('the same holds while a real scan walks a large sandbox tree', async () => {
    const {files} = await commands.startWalk()
    expect(files).toBeGreaterThan(100_000)
    try {
      await sectionInteractions('walking')
    } finally {
      const {walks} = await commands.stopWalk()
      console.log(`${BROWSER} ${MOTION} ${walks} back-to-back walks ran during the interactions`)
    }
  }, 240_000)
})

describe(`frames while a scan streams ${STREAMED.toLocaleString()} items`, () => {
  test('streaming keeps frames within budget, and interacting meanwhile stays within the interaction budget', async () => {
    const {source} = fakeEventSource()
    const temp = bigSection(STREAMED)
    const head = {id: temp.id, title: temp.title, desc: temp.desc, risk: temp.risk}
    const base = withSection(temp)
    const loaded: Loaded = {...base, data: {...base.data, categories: []}, live: true, openEvents: () => source}
    const screen = await render(<App loaded={loaded} history={at()} />)
    send(source, 'disk', {total: 500 * 1024 ** 3, used: 400 * 1024 ** 3, free: 50 * 1024 ** 3, snapshots: 0, elapsed_ms: 1})
    const recorder = frameRecorder()
    const results: Record<string, Frames> = {}
    const streamed = {next: 0}
    const streaming = new Promise<void>(resolve => {
      const batch = () => {
        for (const item of temp.items.slice(streamed.next, streamed.next + PER_FRAME)) send(source, 'item', {category: head, item: {...item, line: streamed.next + 1}, elapsed_ms: 10 + streamed.next})
        streamed.next += PER_FRAME
        if (streamed.next < STREAMED) setTimeout(batch, 16)
        else resolve()
      }
      batch()
    })
    await measure(recorder, results, 'streaming', () => settle(1200), 0)
    await measure(recorder, results, 'interacting while streaming', async () => {
      await screen.getByRole('textbox', {name: 'Filter paths'}).click()
      for (const key of ['i', 't', 'e', 'm']) {
        await userEvent.keyboard(key)
        await settle(100)
      }
      await userEvent.keyboard('{Escape}')
      await screen.getByRole('button', {name: 'safe', exact: true}).click()
      await screen.getByRole('button', {name: 'safe', exact: true}).click()
    }, 0)
    await measure(recorder, results, 'streaming to the end', () => streaming, 300)
    await expect.poll(footer, {timeout: 20_000}).toContain(`${STREAMED.toLocaleString()} items selected`)
    recorder.stop()
    await screen.unmount()
    for (const [label, frames] of Object.entries(results)) console.log(`${BROWSER} ${MOTION} frames ${label}: ${JSON.stringify(frames)}`)
    expectWithin(results, STREAM_BUDGET, ['streaming', 'streaming to the end'])
    expectWithin(results, INTERACTION_BUDGET, ['interacting while streaming'])
  }, 120_000)
})
