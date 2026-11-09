import {gsap} from 'gsap'
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest'
import {render} from 'vitest-browser-react'
import {App} from './App'
import {formatBytes, NO_DATA, type Loaded, type TrashEntry} from './lib/data'
import type {CategoryHead} from './lib/scan-feed'
import {approvedEvent, at, CACHE_PATHS, entry, fixture, item, RUN} from './test/fixture'
import {fakeEventSource, PLAN, sendAll, sendRaw} from './test/page'
import './index.css'

const GB = 1024 ** 3
const DELETE = /^Delete \d+ items? · /
const WAITING = 'Approved · waiting for Claude to run it'
const NODE = '/Users/you/code/web/node_modules'
const ROUND_2 = `${RUN}-2`
const NODE_ENTRY: TrashEntry = {...entry(0, 'trashed'), id: 'e1'.padStart(16, '0'), run: ROUND_2, original: NODE, trashed: '/Users/you/.Trash/node_modules', bytes: 3 * GB}
const NODE_PLAN = {paths: [{path: NODE, bytes: 3 * GB, trashed: false}], paths_bytes: 3 * GB, final: [], final_bytes: 0, final_count: 0, rejected: [], count: 1, bytes: 3 * GB}

type Screen = Awaited<ReturnType<typeof render>>

const statusOf = (screen: Screen) => screen.container.querySelector('header p')
const barSays = (screen: Screen, text: string) => expect.poll(() => statusOf(screen)?.textContent).toContain(text)
const posted = (url: string) => vi.mocked(window.fetch).mock.calls.filter(([to]) => String(to) === url)
const bodyOf = (url: string, n = 0) => JSON.parse(String((posted(url)[n]?.[1] as RequestInit).body))
const footer = (screen: Screen) => screen.getByRole('contentinfo')
const strip = () => document.querySelector('header + section')
const heroLabel = () => strip()?.querySelector(':scope > div.grow > div:first-child')?.textContent ?? ''
const freeLine = () => strip()?.querySelector(':scope > div.grow > div:nth-last-child(2)')?.textContent ?? ''
const scanningTitle = () => strip()?.textContent?.includes('Scanning your disk…') ?? false

function server() {
  const state = {plan: PLAN as object, decisions: 0}
  vi.spyOn(window, 'fetch').mockImplementation(async input => {
    const url = String(input)
    if (url === '/preview') return new Response(JSON.stringify(state.plan), {status: 200})
    if (url === '/decide') return new Response(JSON.stringify({decision: ++state.decisions}), {status: 200})
    return new Response('{}', {status: 200})
  })
  return state
}

function streams(loaded: Loaded) {
  const scan = fakeEventSource()
  const cleanup = fakeEventSource()
  const openEvents = (url: string) => (url.startsWith('/events') ? scan.source : cleanup.source)
  return {scan, cleanup, loaded: {...loaded, openEvents}}
}

const disk = (free: number) => ({type: 'disk', data: {total: 500 * GB, used: 500 * GB - free, free, snapshots: 2, elapsed_ms: 5000}})
const unlisted = (paths: readonly string[]) => paths.map(path => ({type: 'unlisted', data: {path, elapsed_ms: 5000}}))

const firstRound = [
  approvedEvent(CACHE_PATHS),
  {type: 'started', data: {run: RUN, decision: 1, free: 50 * GB, paths: 4, trash: 4, worktrees: 0, commands: 0, bytes: 3.75 * GB, elapsed_ms: 0}},
  ...CACHE_PATHS.map((path, i) => ({type: 'trashed', data: {id: entry(i, 'trashed').id, path, bytes: entry(i, 'trashed').bytes, trashed_path: entry(i, 'trashed').trashed, decision: 1, elapsed_ms: 100 + i}})),
  {type: 'trash', data: {entries: CACHE_PATHS.map((_, i) => entry(i, 'trashed'))}},
  {type: 'done', data: {decision: 1, trashed: 4, trashed_bytes: 3.75 * GB, free_before: 50 * GB, free_after: 50 * GB, elapsed_ms: 1000}},
]

const secondRound = [
  approvedEvent([NODE], 2),
  {type: 'started', data: {run: ROUND_2, decision: 2, free: 49 * GB, paths: 1, trash: 1, worktrees: 0, commands: 0, bytes: 3 * GB, elapsed_ms: 0}},
  {type: 'trashed', data: {id: NODE_ENTRY.id, path: NODE, bytes: 3 * GB, trashed_path: NODE_ENTRY.trashed, decision: 2, elapsed_ms: 100}},
  {type: 'trash', data: {entries: [NODE_ENTRY]}},
  {type: 'done', data: {decision: 2, trashed: 1, trashed_bytes: 3 * GB, free_before: 49 * GB, free_after: 49 * GB, elapsed_ms: 400}},
]

async function confirm(screen: Screen, button: RegExp) {
  await screen.getByRole('button', {name: DELETE}).click()
  await screen.getByRole('dialog').getByRole('button', {name: button}).click()
}

describe('cleanup in rounds: one session, any number of deletes', () => {
  beforeEach(() => gsap.globalTimeline.timeScale(20))
  afterEach(() => {
    gsap.globalTimeline.timeScale(1)
    vi.restoreAllMocks()
  })

  test('two rounds without a reload: moved rows leave, the rest unlock, totals and disk update, Undo and Empty act on each round', async () => {
    const state = server()
    const {scan, cleanup, loaded} = streams(fixture)
    const screen = await render(<App loaded={loaded} history={at('/cleanup/caches')} />)

    await confirm(screen, /^Move 4 items to the Trash/)
    await barSays(screen, WAITING)
    await expect.element(screen.getByRole('checkbox', {name: 'Select all in Application caches'})).toBeDisabled()
    await expect.element(screen.getByRole('button', {name: DELETE})).not.toBeInTheDocument()

    await sendAll(cleanup.source, firstRound)
    await sendAll(scan.source, [...unlisted(CACHE_PATHS), disk(49 * GB)])
    await barSays(screen, `Moved to Trash ${formatBytes(3.75 * GB)} · undo available`)
    for (const path of CACHE_PATHS) await expect.element(screen.getByText(path.replace('/Users/you', '~'), {exact: true})).not.toBeInTheDocument()
    await expect.poll(heroLabel).toBe('In the Trash · undo available')
    await expect.poll(freeLine).toContain(`now ${formatBytes(49 * GB)}`)
    await expect.element(screen.getByRole('region', {name: 'Last cleanup'})).toMatchTextContent(`Moved to Trash ${formatBytes(3.75 * GB)} · undo available`)

    await footer(screen).getByRole('button', {name: 'Empty these from Trash'}).click()
    await screen.getByRole('dialog').getByRole('button', {name: /^Empty 4 items/}).click()
    await expect.poll(() => posted('/empty').length).toBe(1)
    expect(bodyOf('/empty').ids).toEqual([0, 1, 2, 3].map(i => entry(i, 'trashed').id))

    await screen.getByRole('link', {name: /^node_modules/}).click()
    const node = screen.getByRole('checkbox', {name: '~/code/web/node_modules'})
    await expect.element(node).toBeEnabled()
    await node.click()
    await expect.element(screen.getByRole('button', {name: DELETE})).toHaveTextContent(`Delete 1 item · ${formatBytes(3 * GB)}`)
    await expect.poll(heroLabel).toBe('Selected to free')

    state.plan = NODE_PLAN
    await confirm(screen, /^Move 1 item to the Trash/)
    await barSays(screen, WAITING)
    expect(posted('/decide')).toHaveLength(2)
    expect(bodyOf('/decide', 1).mode).toBe('trash')
    await expect.element(node).toBeDisabled()

    await sendAll(cleanup.source, secondRound)
    await sendAll(scan.source, [...unlisted([NODE]), disk(46 * GB)])
    await barSays(screen, `Moved to Trash ${formatBytes(3 * GB)} · undo available`)
    await expect.element(screen.getByText('~/code/web/node_modules', {exact: true})).not.toBeInTheDocument()
    await expect.element(screen.getByRole('region', {name: 'Last cleanup'})).toMatchTextContent('1 item · 3.0 GB approved')
    await expect.poll(freeLine).toContain(`now ${formatBytes(46 * GB)}`)

    await footer(screen).getByRole('button', {name: 'Undo'}).click()
    await expect.poll(() => posted('/undo').length).toBe(1)
    expect(bodyOf('/undo').ids).toEqual([NODE_ENTRY.id])
    await sendAll(cleanup.source, [
      {type: 'undo_started', data: {job: 'j-undo', count: 1, bytes: 3 * GB, elapsed_ms: 500}},
      {type: 'undone', data: {job: 'j-undo', id: NODE_ENTRY.id, path: NODE, trashed_path: NODE_ENTRY.trashed, bytes: 3 * GB, outcome: 'restored', reason: '', elapsed_ms: 510}},
      {type: 'trash', data: {entries: [{...NODE_ENTRY, state: 'restored'}]}},
      {type: 'undo_done', data: {job: 'j-undo', restored: 1, restored_bytes: 3 * GB, kept: 0, trashed: 0, trashed_bytes: 0, elapsed_ms: 520}},
    ])
    const restored = fixture.data.categories.find(c => c.id === 'node')!
    const head = {id: restored.id, title: restored.title, desc: restored.desc, risk: restored.risk}
    await sendAll(scan.source, [{type: 'item', data: {category: head, item: restored.items[0]!, elapsed_ms: 5100}}, disk(49 * GB)])
    await barSays(screen, `Put back ${formatBytes(3 * GB)} · nothing left in the Trash`)
    await expect.element(screen.getByRole('checkbox', {name: '~/code/web/node_modules'})).toBeEnabled()
    expect(posted('/empty')).toHaveLength(1)
  })

  test('a second approval waits its turn and shows as queued', async () => {
    server()
    const {cleanup, loaded} = streams(fixture)
    const screen = await render(<App loaded={loaded} history={at('/cleanup/caches')} />)
    await sendAll(cleanup.source, firstRound)
    await barSays(screen, `Moved to Trash ${formatBytes(3.75 * GB)} · undo available`)
    await sendAll(cleanup.source, [approvedEvent([NODE], 2), {type: 'queued', data: {decision: 2, elapsed_ms: 0}}])
    await barSays(screen, 'Approved · queued until the cleanup before it finishes')
    await expect.poll(heroLabel).toBe('Approved · queued')
    await expect.element(screen.getByRole('button', {name: DELETE})).not.toBeInTheDocument()
    await sendAll(cleanup.source, secondRound.slice(1))
    await barSays(screen, `Moved to Trash ${formatBytes(3 * GB)} · undo available`)
  })

  test('an approval made while another round runs waits for that round to finish before it shows', async () => {
    server()
    const {cleanup, loaded} = streams(fixture)
    const screen = await render(<App loaded={loaded} history={at('/cleanup/caches')} />)
    await sendAll(cleanup.source, firstRound.slice(0, 3))
    await barSays(screen, 'Moving to the Trash ·')
    await sendAll(cleanup.source, [approvedEvent([NODE], 2), {type: 'queued', data: {decision: 2, elapsed_ms: 0}}])
    await barSays(screen, 'Moving to the Trash ·')
    await sendAll(cleanup.source, firstRound.slice(3))
    await barSays(screen, 'Approved · queued until the cleanup before it finishes')
    await sendAll(cleanup.source, secondRound.slice(1))
    await barSays(screen, `Moved to Trash ${formatBytes(3 * GB)} · undo available`)
  })

  test('approving mid-scan keeps the scan going and the hero on the cleanup until it settles', async () => {
    server()
    const caches: CategoryHead = {id: 'caches', title: 'Application caches', desc: 'Application caches description', risk: 'safe'}
    const first = item('/Users/you/Library/Caches/app-a', 2 * GB, {line: 1})
    const later = item('/Users/you/Library/Caches/app-late', GB, {preselect: false, line: 2})
    const {scan, cleanup, loaded} = streams({data: NO_DATA, token: 'test-token', home: '/Users/you', live: true, run: RUN, trash: []})
    const screen = await render(<App loaded={loaded} history={at()} />)
    scan.send({type: 'disk', data: {total: 500 * GB, used: 450 * GB, free: 50 * GB, snapshots: 0, elapsed_ms: 10}})
    scan.send({type: 'item', data: {category: caches, item: first, elapsed_ms: 60}})
    await expect.poll(scanningTitle).toBe(true)
    vi.mocked(window.fetch).mockImplementation(async input => {
      const url = String(input)
      if (url === '/preview') return new Response(JSON.stringify({...NODE_PLAN, paths: [{path: first.path, bytes: 2 * GB, trashed: false}]}), {status: 200})
      return new Response(JSON.stringify({decision: 1}), {status: 200})
    })
    await confirm(screen, /^Move 1 item to the Trash/)
    await barSays(screen, WAITING)
    expect(bodyOf('/decide').listed).toBe(1)

    scan.send({type: 'item', data: {category: caches, item: later, elapsed_ms: 900}})
    await expect.element(screen.getByText('~/Library/Caches/app-late', {exact: true})).toBeVisible()
    await expect.element(screen.getByRole('checkbox', {name: /app-late/})).toBeDisabled()
    expect(scanningTitle()).toBe(false)
    expect(cleanup.source.readyState).toBe(1)
    expect(scan.source.readyState).toBe(1)

    await sendAll(cleanup.source, [
      approvedEvent([first.path], 1, [{id: 'caches', title: caches.title, desc: caches.desc, risk: 'safe', bytes: 2 * GB, items: [first]}]),
      {type: 'started', data: {run: RUN, decision: 1, free: 50 * GB, paths: 1, trash: 1, worktrees: 0, commands: 0, bytes: 2 * GB, elapsed_ms: 0}},
      {type: 'trashed', data: {id: entry(0, 'trashed').id, path: first.path, bytes: 2 * GB, trashed_path: entry(0, 'trashed').trashed, decision: 1, elapsed_ms: 100}},
      {type: 'trash', data: {entries: [entry(0, 'trashed')]}},
      {type: 'done', data: {decision: 1, trashed: 1, trashed_bytes: 2 * GB, free_before: 50 * GB, free_after: 50 * GB, elapsed_ms: 200}},
    ])
    await sendAll(scan.source, unlisted([first.path]))
    await barSays(screen, `Moved to Trash ${formatBytes(2 * GB)} · undo available`)
    await expect.element(screen.getByRole('checkbox', {name: /app-late/})).toBeEnabled()
    await expect.element(screen.getByText('~/Library/Caches/app-a', {exact: true})).not.toBeInTheDocument()
    scan.send({type: 'done', data: {reclaimable: GB, elapsed_ms: 2000}})
    await expect.element(screen.getByRole('button', {name: 'Rescan'})).toBeEnabled()
    expect(scan.source.readyState).toBe(1)
  })

  test('a reload during a round restores it from the replayed log, and a closed session says so', async () => {
    server()
    const {cleanup, scan, loaded} = streams(fixture)
    const screen = await render(<App loaded={loaded} history={at('/cleanup/caches')} />)
    await sendAll(cleanup.source, firstRound.slice(0, 4))
    await barSays(screen, 'Moving to the Trash ·')
    await screen.unmount()

    const again = streams(fixture)
    const reloaded = await render(<App loaded={again.loaded} history={at('/cleanup/caches')} />)
    await sendAll(again.cleanup.source, [...firstRound.slice(0, 4), {type: 'replayed', data: {}}])
    await barSays(reloaded, 'Moving to the Trash ·')
    await expect.element(reloaded.getByRole('checkbox', {name: 'Select all in Application caches'})).toBeDisabled()
    await sendAll(again.cleanup.source, firstRound.slice(4))
    await barSays(reloaded, `Moved to Trash ${formatBytes(3.75 * GB)} · undo available`)

    sendRaw(again.scan.source, 'closed', {elapsed_ms: 9000})
    await expect.element(reloaded.getByRole('heading', {name: 'Session closed'})).toBeVisible()
    expect(again.scan.source.readyState).toBe(2)
    expect(again.cleanup.source.readyState).toBe(2)
    await expect.poll(() => scan.source.readyState).toBe(2)
  })
})
