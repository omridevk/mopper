import {Profiler} from 'react'
import {afterEach, describe, expect, test, vi} from 'vitest'
import {render} from 'vitest-browser-react'
import {App} from './App'
import type {Loaded} from './lib/data'
import {clickRescan, finishedBigScan, firstEventsOfRescan, pinDrawnFolder, selectAndDeselect, watchLongTasks} from './test/big-scan'
import {approvedEvent, at, bigSection, withSection} from './test/fixture'
import './index.css'

const SMALL = 30
const ROWS = 10_000
const EVENTS = 5_000
const SCANNED = 9_000
const REPEATS = 3
const SCROLL_STEPS = 60
const PER_TICK = 25
const FRAME_BUDGET = 50
const SAMPLES = 15
const FLAT_FACTOR = 3
const FLAT_SLACK = 4
const DEBOUNCED = 400
const BROWSER = navigator.userAgent.includes('Firefox') ? 'firefox' : 'chromium'
const LONGEST_TASK = 100

type Work = Record<string, number>

const commits: number[] = []
const commitsBy: Record<string, number[]> = {app: commits}

function Measured({loaded, id = 'app'}: {loaded: Loaded; id?: string}) {
  return (
    <Profiler id={id} onRender={(profiler, _phase, actual) => commitsBy[profiler]?.push(actual)}>
      <App loaded={loaded} history={at()} />
    </Profiler>
  )
}

function nextPaint() {
  return new Promise<void>(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)))
}

const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0)

function percentile(values: readonly number[], share: number) {
  return values.toSorted((a, b) => a - b)[Math.floor(values.length * share)] ?? Infinity
}

const median = (values: readonly number[]) => percentile(values, 0.5)

async function work(action: () => void) {
  await nextPaint()
  commits.length = 0
  action()
  await nextPaint()
  await nextPaint()
  return sum(commits)
}

async function repeated(actions: readonly (() => void)[]) {
  const costs: number[] = []
  for (let round = 0; round < REPEATS; round++) for (const action of actions) costs.push(await work(action))
  return median(costs)
}

function typeInto(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
  input.dispatchEvent(new Event('input', {bubbles: true}))
}

function scrollerOf(element: Element) {
  for (let node = element.parentElement; node; node = node.parentElement) {
    if (node.scrollHeight > node.clientHeight + 1 && getComputedStyle(node).overflowY !== 'visible') return node
  }
  throw new Error('no scroll container')
}

function link(name: RegExp) {
  const found = [...document.querySelectorAll('a')].find(a => name.test(a.textContent ?? ''))
  if (!found) throw new Error(`no link ${name}`)
  return found
}

function element(selector: string) {
  const found = document.querySelector<HTMLElement>(selector)
  if (!found) throw new Error(`no ${selector}`)
  return found
}

const press = (key: string) => () => document.body.dispatchEvent(new KeyboardEvent('keydown', {key, bubbles: true}))

function footerText() {
  return document.querySelector('footer')?.textContent ?? ''
}

async function scrollThrough(scroller: HTMLElement) {
  const costs: number[] = []
  for (let step = 0; step < SCROLL_STEPS; step++) costs.push(await work(() => (scroller.scrollTop += scroller.clientHeight)))
  return median(costs)
}

async function interactions(rows: number): Promise<Work> {
  const screen = await render(<Measured loaded={withSection(bigSection(rows))} />)
  await expect.element(screen.getByText('~/Library/Caches/app-a')).toBeVisible()
  const open = await repeated([() => link(/^Your macOS temp/).click(), () => link(/^Application caches/).click()])
  link(/^Your macOS temp/).click()
  await screen.getByRole('combobox', {name: 'Sort'}).click()
  await screen.getByRole('option', {name: 'Name'}).click()
  await expect.element(screen.getByText('~/tmp/item-00000')).toBeVisible()
  const input = element('input[aria-label="Filter paths"]')
  if (!(input instanceof HTMLInputElement)) throw new Error('no filter input')
  input.focus()
  const type = await repeated(['0', '00', '000', '0002', ''].map(value => () => typeInto(input, value)))
  input.blur()
  await expect.element(screen.getByText('~/tmp/item-00001')).toBeVisible()
  const section = () => element('[aria-label="Select all in Your macOS temp"]').click()
  const selectAll = await repeated([section, section])
  await expect.poll(footerText).toContain(`${(rows + 4).toLocaleString()} items selected`)
  const shortcuts = await repeated([press('d'), press('a')])
  await expect.poll(footerText).toContain(`${(rows + 6).toLocaleString()} items selected`)
  const scroller = scrollerOf(screen.getByText('~/tmp/item-00000').element())
  const scroll = await scrollThrough(scroller)
  scroller.scrollTop = scroller.scrollHeight
  await expect.element(screen.getByText(`~/tmp/item-${String(rows - 1).padStart(5, '0')}`)).toBeVisible()
  await screen.unmount()
  return {open, type, selectAll, shortcuts, scroll}
}

function cleanupSource() {
  return Object.assign(new EventTarget(), {readyState: 1, close: () => {}})
}

function send(source: EventTarget, type: string, data: object) {
  source.dispatchEvent(new MessageEvent(type, {data: JSON.stringify(data)}))
}

function stream(source: EventTarget, paths: readonly string[]) {
  return new Promise<void>(resolve => {
    let next = 0
    const tick = () => {
      for (const path of paths.slice(next, next + PER_TICK)) send(source, 'removed', {path, bytes: 4096, secs: 0.01, elapsed_ms: 1000 + next})
      next += PER_TICK
      if (next < paths.length) setTimeout(tick, 16)
      else resolve()
    }
    tick()
  })
}

async function cleanup(events: number): Promise<Work> {
  const loaded = withSection(bigSection(events))
  const paths = loaded.data.categories.flatMap(c => c.items.filter(i => i.path.includes('/tmp/')).map(i => i.path))
  const source = cleanupSource()
  const screen = await render(<Measured loaded={{...loaded, openEvents: () => source}} />)
  await screen.getByRole('link', {name: /^Your macOS temp/}).click()
  await expect.element(screen.getByRole('heading', {name: 'Your macOS temp'})).toBeVisible()
  const approved = approvedEvent(paths, 1, loaded.data.categories)
  send(source, approved.type, approved.data)
  send(source, 'started', {run: 'run-1', free: 1, paths: paths.length, worktrees: 0, commands: 0, bytes: paths.length * 4096, elapsed_ms: 0})
  await screen.getByRole('button', {name: 'Details'}).click()
  const panel = screen.getByRole('dialog', {name: 'Cleanup progress'})
  await expect.element(panel).toBeVisible()
  await nextPaint()
  commits.length = 0
  await stream(source, paths)
  await expect.poll(() => document.querySelector('header p')?.textContent).toContain(`${events.toLocaleString()} of ${events.toLocaleString()}`)
  await nextPaint()
  const perCommit = [...commits]
  const newest = `Removed ~/tmp/item-${String(events - 1).padStart(5, '0')}`
  await expect.element(panel.getByText(newest)).toBeVisible()
  const log = scrollerOf(panel.getByText(newest).element())
  log.scrollTop = log.scrollHeight
  await expect.element(panel.getByText('Removed ~/tmp/item-00000')).toBeVisible()
  expect(panel.getByRole('listitem').elements().length).toBeLessThan(60)
  await screen.unmount()
  return {commit: median(perCommit), p95: percentile(perCommit, 0.95)}
}

async function scan(count: number): Promise<Work> {
  const source = cleanupSource()
  const temp = bigSection(count)
  const head = {id: temp.id, title: temp.title, desc: temp.desc, risk: temp.risk}
  const base = withSection(temp)
  const loaded: Loaded = {...base, data: {...base.data, categories: []}, live: true, openEvents: () => source}
  const screen = await render(<Measured loaded={loaded} />)
  await expect.element(screen.getByText('Walking disk')).toBeVisible()
  send(source, 'disk', {total: 500 * 1024 ** 3, used: 400 * 1024 ** 3, free: 50 * 1024 ** 3, snapshots: 0, elapsed_ms: 1})
  await nextPaint()
  commits.length = 0
  await new Promise<void>(resolve => {
    let next = 0
    const tick = () => {
      for (const item of temp.items.slice(next, next + PER_TICK)) send(source, 'item', {category: head, item, elapsed_ms: 10 + next})
      next += PER_TICK
      if (next < count) setTimeout(tick, 16)
      else resolve()
    }
    tick()
  })
  await expect.poll(footerText).toContain(`${count.toLocaleString()} items selected`)
  await nextPaint()
  const perCommit = [...commits]
  await screen.unmount()
  return {commit: median(perCommit), p95: percentile(perCommit, 0.95)}
}

interface Spread {
  median: number
  p95: number
}

function spreadOf(costs: readonly number[]): Spread {
  return {median: median(costs), p95: percentile(costs, 0.95)}
}

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

function streamItems(source: EventTarget, items: readonly {path: string}[], head: object) {
  for (const item of items) send(source, 'item', {category: head, item, elapsed_ms: 10})
}

interface Side {
  id: string
  rows: number
  source: EventTarget
  items: readonly {path: string}[]
  head: object
  container: HTMLElement
}

function inside(side: Side, selector: string) {
  const found = side.container.querySelector<HTMLElement>(selector)
  if (!found) throw new Error(`no ${selector} in the ${side.rows}-row page`)
  return found
}

async function opened(rows: number): Promise<Side & {unmount: () => Promise<void>}> {
  const id = `rows-${rows}`
  commitsBy[id] = []
  const source = cleanupSource()
  const temp = bigSection(rows + (SAMPLES + 1) * PER_TICK)
  const head = {id: temp.id, title: temp.title, desc: temp.desc, risk: temp.risk}
  const base = withSection(temp)
  const loaded: Loaded = {...base, data: {...base.data, categories: []}, live: true, openEvents: () => source}
  const screen = await render(<Measured id={id} loaded={loaded} />)
  const view = screen.locator
  await expect.element(view.getByText('Walking disk')).toBeVisible()
  streamItems(source, temp.items.slice(0, rows), head)
  send(source, 'walked', {home: 0, tree: base.data.tree, insights: null, worktrees: 0, elapsed_ms: 20})
  send(source, 'done', {reclaimable: 0, elapsed_ms: 30})
  await view.getByRole('link', {name: /^Your macOS temp/}).click()
  await expect.element(view.getByRole('heading', {name: 'Your macOS temp'})).toBeVisible()
  await expect.element(view.getByRole('table', {name: 'Your macOS temp'}).getByRole('checkbox').first()).toBeVisible()
  return {id, rows, source, items: temp.items, head, container: screen.container, unmount: screen.unmount}
}

async function paired(sides: readonly [Side, Side], action: (side: Side, round: number) => void, settle: () => Promise<unknown> = nextPaint): Promise<[Spread, Spread]> {
  const costs: [number[], number[]] = [[], []]
  for (let round = -1; round < SAMPLES; round++) {
    for (const [index, side] of sides.entries()) {
      const own = commitsBy[side.id] ?? []
      await nextPaint()
      own.length = 0
      action(side, round)
      await settle()
      await nextPaint()
      if (round >= 0) costs[index]?.push(sum(own))
    }
  }
  return [spreadOf(costs[0]), spreadOf(costs[1])]
}

const nextBatch = (side: Side, round: number) => streamItems(side.source, side.items.slice(side.rows + (round + 1) * PER_TICK, side.rows + (round + 2) * PER_TICK), side.head)

const tickFirst = (side: Side) => inside(side, '[role="table"] [role="checkbox"]').click()

function typeRound(side: Side, round: number) {
  const input = inside(side, 'input[aria-label="Filter paths"]')
  if (!(input instanceof HTMLInputElement)) throw new Error('no filter input')
  typeInto(input, round % 2 === 0 ? 'item-0' : 'item-00')
}

async function perChange(): Promise<{small: Record<string, Spread>; big: Record<string, Spread>}> {
  const small = await opened(SMALL)
  const big = await opened(ROWS)
  const sides: [Side, Side] = [small, big]
  const [smallBatch, bigBatch] = await paired(sides, nextBatch)
  const [smallTick, bigTick] = await paired(sides, tickFirst)
  const [smallKey, bigKey] = await paired(sides, typeRound, () => pause(DEBOUNCED))
  await big.unmount()
  await small.unmount()
  return {small: {batch: smallBatch, tick: smallTick, keystroke: smallKey}, big: {batch: bigBatch, tick: bigTick, keystroke: bigKey}}
}

function report(name: string, size: number, small: Work, big: Work) {
  for (const key of Object.keys(big)) console.log(`${BROWSER} ${name} ${key}: ${big[key]?.toFixed(1)} ms of React work at ${size}, ${small[key]?.toFixed(1)} ms at ${SMALL}`)
}

function scalesLikeSmall(small: Work, big: Work, slack: number) {
  for (const key of Object.keys(big)) {
    const smallCost = small[key] ?? 0
    expect.soft(big[key], `${key}: ${big[key]?.toFixed(1)} ms against ${smallCost.toFixed(1)} ms for ${SMALL}`).toBeLessThan(smallCost * 2 + slack)
  }
}

describe('a 10,000-row section', () => {
  test('costs about what a 30-row section costs to open, filter, select and scroll', async () => {
    const small = await interactions(SMALL)
    const big = await interactions(ROWS)
    report('list', ROWS, small, big)
    scalesLikeSmall(small, big, 16)
  }, 180_000)
})

describe('a 5,000-event cleanup with the progress panel open', () => {
  test('renders each event batch for about what a 30-event cleanup costs', async () => {
    const small = await cleanup(SMALL)
    const big = await cleanup(EVENTS)
    report('stream', EVENTS, small, big)
    scalesLikeSmall(small, big, 8)
  }, 180_000)
})

describe('a 9,000-item streaming scan', () => {
  test('renders each item batch for about what a 30-item scan costs', async () => {
    const small = await scan(SMALL)
    const big = await scan(SCANNED)
    report('scan', SCANNED, small, big)
    scalesLikeSmall({commit: small.commit ?? 0}, {commit: big.commit ?? 0}, 8)
    expect.soft(big.p95, `p95: ${big.p95?.toFixed(1)} ms of React work for one batch at ${SCANNED} items`).toBeLessThan(FRAME_BUDGET)
  }, 180_000)
})

describe('one change at 10,000 rows', () => {
  test('a streamed batch, a tick and a filter keystroke cost about what they cost at 30 rows', async () => {
    const {small, big} = await perChange()
    for (const key of Object.keys(big)) {
      for (const stat of ['median', 'p95'] as const) {
        const at30 = small[key]?.[stat] ?? 0
        const at10k = big[key]?.[stat] ?? Infinity
        console.log(`${BROWSER} change ${key} ${stat}: ${at10k.toFixed(1)} ms of React work at ${ROWS}, ${at30.toFixed(1)} ms at ${SMALL}`)
        expect.soft(at10k, `${key} ${stat}: ${at10k.toFixed(1)} ms against ${at30.toFixed(1)} ms for ${SMALL}`).toBeLessThan(at30 * FLAT_FACTOR + FLAT_SLACK)
      }
    }
  }, 180_000)
})

describe.runIf(BROWSER === 'chromium')('a 2,129-folder storage map', () => {
  afterEach(() => vi.restoreAllMocks())

  function longest(tasks: readonly number[], what: string) {
    console.log(`${BROWSER} ${what}: long tasks ${JSON.stringify(tasks.map(Math.round))} ms`)
    return Math.max(0, ...tasks)
  }

  test.each(['/cleanup', '/storage'])('Rescan on %s blocks the page for no long task, at the click or in the first events of the new scan', async url => {
    const scan = await finishedBigScan(url)
    const watch = watchLongTasks()
    await clickRescan(scan)
    await firstEventsOfRescan(scan)
    watch.stop()
    expect(longest(watch.tasks, `rescan on ${url}`)).toBeLessThan(LONGEST_TASK)
  })

  test('Select for delete and back on the map blocks the page for no long task', async () => {
    const scan = await finishedBigScan('/storage')
    const pin = await pinDrawnFolder(scan)
    const watch = watchLongTasks()
    await selectAndDeselect(pin)
    watch.stop()
    expect(longest(watch.tasks, 'select for delete on the map')).toBeLessThan(LONGEST_TASK)
  })
})
