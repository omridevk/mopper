import {afterEach, describe, expect, inject, test, vi} from 'vitest'
import {render} from 'vitest-browser-react'
import {App} from './App'
import {NO_DATA, type Insights, type Loaded, type TreeNode} from './lib/data'
import type {CategoryHead, ScanEvent} from './lib/scan-feed'
import {at, item} from './test/fixture'
import {fakeEventSource} from './test/page'
import './index.css'

const GB = 1024 ** 3
const LIVE: Loaded = {data: NO_DATA, token: 'test-token', home: '/Users/you', live: true}
const SECTIONS = 15
const PER_SECTION = 22
const FANOUT = [16, 12, 10]
const LONGEST_TASK_MS = 100 * inject('cpuSlowdown')

const insights: Insights = {
  generated_at: 0,
  modified_by_day: Array.from({length: 365}, (_, i) => ({day: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10), bytes: (i % 17) * 50_000_000, files: i})),
  age_by_folder: {buckets: ['<1w', '<1m', 'older'], folders: Array.from({length: 20}, (_, i) => ({path: `~/f${i}`, bytes: [1, 2, 3].map(b => b * GB * (i + 1))}))},
  by_kind: ['video', 'code', 'image', 'other'].map((kind, i) => ({kind, bytes: (i + 1) * GB, files: i * 1000})),
  largest_files: Array.from({length: 50}, (_, i) => ({path: `~/big/file-${i}.bin`, bytes: (50 - i) * 100_000_000, mtime: 1_700_000_000})),
}

function folder(path: string, depth: number): TreeNode {
  const children = depth < FANOUT.length ? Array.from({length: FANOUT[depth]!}, (_, i) => folder(`${path}/d${i}`, depth + 1)) : []
  const bytes = children.length ? children.reduce((sum, child) => sum + child.bytes, 0) : 50_000_000 + path.length * 1_000_000
  return {name: path.split('/').at(-1) ?? path, path, bytes, files: 10, mtime: 1_700_000_000, children}
}

const tree = folder('/Users/you', 0)
const heads: CategoryHead[] = Array.from({length: SECTIONS}, (_, s) => ({id: `section-${s}`, title: `Section ${s}`, desc: 'desc', risk: 'safe'}))
const disk: ScanEvent = {type: 'disk', data: {total: 500 * GB, used: 400 * GB, free: 50 * GB, snapshots: 0, elapsed_ms: 10}}

const items: ScanEvent[] = heads.flatMap((category, s) =>
  Array.from({length: PER_SECTION}, (_, i) => ({
    type: 'item' as const,
    data: {category, item: item(`/Users/you/d${s}/d${i % 12}/item-${i}`, (i + 1) * 10_000_000, {preselect: i % 2 === 0, line: s * PER_SECTION + i}), elapsed_ms: 100},
  })),
)

function watchLongTasks() {
  const tasks: number[] = []
  const observer = new PerformanceObserver(list => list.getEntries().forEach(entry => tasks.push(entry.duration)))
  observer.observe({type: 'longtask'})
  return {tasks, stop: () => observer.disconnect()}
}

const frame = () => new Promise(requestAnimationFrame)
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

describe('Rescan on a big finished scan', () => {
  afterEach(() => vi.restoreAllMocks())

  test.each(['/cleanup', '/storage'])('on %s Rescanning shows within a frame and neither the click nor the first events of the new scan block the page', async url => {
    vi.spyOn(window, 'fetch').mockImplementation(async () => new Response('{}', {status: 202}))
    const sources: ReturnType<typeof fakeEventSource>[] = []
    const openEvents = (address: string) => {
      const fake = fakeEventSource()
      if (address.startsWith('/events')) sources.push(fake)
      return fake.source
    }
    const send = (event: ScanEvent) => sources.at(-1)?.send(event)
    const screen = await render(<App loaded={{...LIVE, openEvents}} history={at(url)} />)
    await expect.poll(() => sources.length).toBe(1)
    for (const event of [disk, ...items, {type: 'walked', data: {home: tree.bytes, tree, insights, worktrees: 0, elapsed_ms: 5000}}, {type: 'done', data: {reclaimable: GB, elapsed_ms: 9000}}] as ScanEvent[]) send(event)
    const rescan = screen.getByRole('button', {name: 'Rescan'})
    await expect.element(rescan).toBeEnabled()
    await frame()
    await frame()

    const watch = watchLongTasks()
    rescan.element().dispatchEvent(new MouseEvent('click', {bubbles: true}))
    await frame()
    expect(screen.getByText('Rescanning').query()).not.toBeNull()
    expect(rescan.element()).toBeDisabled()
    await expect.poll(() => sources.length).toBe(2)
    send({type: 'rescan', data: {elapsed_ms: 0}})
    send(disk)
    for (let step = 0; step < 12; step++) {
      send({type: 'progress', data: {files: step * 1000, bytes: step * GB, dir: `/Users/you/d${step}`, elapsed_ms: step * 100}})
      for (const event of items.slice(step * 30, step * 30 + 30)) send(event)
      if (step % 4 === 3) send({type: 'growing', data: {tree, insights, elapsed_ms: step * 100}})
      await pause(50)
    }
    await frame()
    watch.stop()
    expect(Math.max(0, ...watch.tasks)).toBeLessThan(LONGEST_TASK_MS)
  })
})
