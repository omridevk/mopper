import {hierarchy, treemap, treemapSquarify, type HierarchyRectangularNode} from 'd3-hierarchy'
import {useState} from 'react'
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest'
import {cdp, page, userEvent} from 'vitest/browser'
import {render} from 'vitest-browser-react'
import {App} from './App'
import {ConfirmDialog} from './components/confirm-dialog'
import {gsap} from 'gsap'
import type {CleanupEvent} from './lib/cleanup-feed'
import {formatBytes, NO_DATA, outermost, type Category, type Loaded} from './lib/data'
import {createDb, receiveCleanupEvents, receiveScanEvents, type Db} from './lib/db'
import {cssMs, useTextSwap} from './lib/motion'
import {finaleOf, isOutcome, statusOf as cleanupStatus} from './lib/progress'
import type {ScanEvent} from './lib/scan-feed'
import {NO_PICKS, picksOf, rowSelectionOf} from './lib/selection'
import {categoriesOf} from './lib/views'
import {squarifyInBounds} from './lib/treemap-tile'
import {approvedEvent, at, bigSection, category, cleanupEvents, fixture, item, withSection} from './test/fixture'
import {fakeEventSource, mockServer, PLAN, query, ringPoints, sendAll, sendRaw} from './test/page'
import './index.css'

describe('formatBytes', () => {
  test('picks the unit and precision', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(250 * 1024 ** 3)).toBe('250 GB')
  })
})

describe('motion tokens', () => {
  test('durations read in milliseconds whether written in ms or s', () => {
    const root = document.documentElement
    root.style.setProperty('--test-ms', '150ms')
    root.style.setProperty('--test-s', '.25s')
    expect([cssMs('--test-ms', 0), cssMs('--test-s', 0), cssMs('--test-missing', 42)]).toEqual([150, 250, 42])
    root.style.removeProperty('--test-ms')
    root.style.removeProperty('--test-s')
  })
})

describe('cleanup', () => {
  test('preselected items set the total and footer', async () => {
    const screen = await render(<App loaded={fixture} history={at()} />)
    await expect.element(screen.getByText('4 items selected · 3.8 GB')).toBeVisible()
    await expect.element(screen.getByText('3.8 GB', {exact: true}).first()).toBeVisible()
  })

  test('counts read as words: one item, one section, several sections', async () => {
    const screen = await render(<App loaded={fixture} history={at()} />)
    await expect.element(screen.getByText(/^4 items in 1 section ·/)).toBeVisible()
    for (const name of ['app-b', 'app-c', 'app-d']) await screen.getByText(`~/Library/Caches/${name}`).click()
    await expect.element(screen.getByText(/^1 item in 1 section ·/)).toBeVisible()
    await expect.element(screen.getByText('1 item selected · 2.0 GB')).toBeVisible()
    await expect.element(screen.getByRole('button', {name: 'Delete 1 item · 2.0 GB'})).toBeVisible()
    await screen.getByRole('checkbox', {name: 'Select all in node_modules'}).click()
    await expect.element(screen.getByText(/^2 items in 2 sections ·/)).toBeVisible()
  })

  test('a section checkbox selects every item in it', async () => {
    const screen = await render(<App loaded={fixture} history={at()} />)
    await screen.getByRole('checkbox', {name: 'Select all in node_modules'}).click()
    await expect.element(screen.getByText('5 items selected · 6.8 GB')).toBeVisible()
  })

  test('unticking one item makes its section partly selected', async () => {
    const screen = await render(<App loaded={fixture} history={at()} />)
    await screen.getByText('~/Library/Caches/app-a').click()
    await expect
      .element(screen.getByRole('checkbox', {name: 'Select all in Application caches'}))
      .toHaveAttribute('aria-checked', 'mixed')
    await expect.element(screen.getByText('3 items selected · 1.8 GB')).toBeVisible()
  })

  test('quick select keeps only items idle a year or more', async () => {
    const screen = await render(<App loaded={fixture} history={at()} />)
    await screen.getByRole('button', {name: 'idle 1+ year'}).click()
    await expect.element(screen.getByText('1 item selected · 1.0 GB')).toBeVisible()
  })

  test('filtering hides selected items and warns about them', async () => {
    const screen = await render(<App loaded={fixture} history={at()} />)
    await screen.getByRole('textbox', {name: 'Filter paths'}).fill('app-a')
    await screen.getByRole('contentinfo').getByRole('button', {name: '3 hidden'}).click()
    await expect.element(screen.getByText(/3 selected items are hidden by the filters/)).toBeVisible()
    await expect.element(screen.getByText('~/Library/Caches/app-b')).not.toBeInTheDocument()
  })

  test('a filter that matches nothing offers to clear it', async () => {
    const screen = await render(<App loaded={fixture} history={at()} />)
    await screen.getByRole('textbox', {name: 'Filter paths'}).fill('no such path')
    await screen.getByRole('button', {name: 'Clear filters'}).click()
    await expect.element(screen.getByText('~/Library/Caches/app-a')).toBeVisible()
  })

  test('leaving Cleanup longer than a live query lives keeps its sections and rows when coming back', async () => {
    const screen = await render(<App loaded={fixture} history={at()} />)
    await expect.element(screen.getByText('~/Library/Caches/app-a')).toBeVisible()
    await screen.getByRole('tab', {name: 'Storage'}).click()
    await expect.element(screen.getByRole('tab', {name: 'Storage'})).toHaveAttribute('aria-selected', 'true')
    await new Promise(resolve => setTimeout(resolve, 6000))
    await screen.getByRole('tab', {name: 'Cleanup'}).click()
    await expect.element(screen.getByText('~/Library/Caches/app-a')).toBeVisible()
    await expect.element(screen.getByRole('checkbox', {name: 'Select all in node_modules'})).toBeVisible()
    await expect.element(screen.getByText('Nothing matches these filters.')).not.toBeInTheDocument()
  }, 20_000)

  test('with no filters set and nothing listed, the empty state offers no Clear filters', async () => {
    const screen = await render(<App loaded={{...fixture, data: {...fixture.data, categories: []}}} history={at()} />)
    await expect.element(screen.getByText('Nothing to clean up.')).toBeVisible()
    await expect.element(screen.getByRole('button', {name: 'Clear filters'})).not.toBeInTheDocument()
  })

  test('jumping straight to the end of a long sorted section shows its last rows', async () => {
    const screen = await render(<App loaded={withSection(bigSection(3000))} history={at('/cleanup/temp?sort=name-asc')} />)
    const first = screen.getByText('~/tmp/item-00000')
    await expect.element(first).toBeVisible()
    const scroller = first.element().closest('.overflow-auto')
    if (!(scroller instanceof HTMLElement)) throw new Error('no table scroller')
    scroller.scrollTop = scroller.scrollHeight
    await expect.element(screen.getByText('~/tmp/item-02999')).toBeVisible()
  })

  test('card view shows every section and expands the one whose items are shown', async () => {
    const history = at()
    const screen = await render(<App loaded={fixture} history={history} />)
    await screen.getByRole('button', {name: 'Card view'}).click()
    await expect.element(screen.getByText('Large files')).toBeVisible()
    await expect.element(screen.getByText('~/Library/Caches/app-a')).toBeVisible()
    await screen.getByRole('link', {name: /Show items/}).first().click()
    await expect.element(screen.getByText('~/code/web/node_modules')).toBeVisible()
    expect(history.location.pathname).toBe('/cleanup/node')
    expect(query(history).view).toBe('cards')
    await expect.element(screen.getByRole('link', {name: /Items shown below/})).toBeVisible()
  })

  test('keyboard shortcuts select all, clear and reset', async () => {
    const screen = await render(<App loaded={fixture} history={at()} />)
    await userEvent.keyboard('d')
    await expect.element(screen.getByText('0 items selected · 0 B')).toBeVisible()
    await userEvent.keyboard('r')
    await expect.element(screen.getByText('4 items selected · 3.8 GB')).toBeVisible()
  })
})

describe('other tabs', () => {
  test('storage shows the folder tree, reconciliation and snapshots', async () => {
    const screen = await render(<App loaded={fixture} history={at()} />)
    await screen.getByRole('tab', {name: 'Storage'}).click()
    await expect.element(screen.getByText('Where your 500 GB went')).toBeVisible()
    await expect.element(screen.getByText(/2 local Time Machine snapshots/)).toBeVisible()
    await screen.getByRole('button', {name: 'Treemap'}).click()
    await expect.element(screen.getByLabelText(/Storage treemap/)).toBeVisible()
  })

  test('hovering the sunburst shows a folder card with its path, shares, files and cleanable bytes', async () => {
    const screen = await render(<App loaded={fixture} history={at()} />)
    await screen.getByRole('tab', {name: 'Storage'}).click()
    const chart = screen.getByLabelText(/Storage sunburst/)
    await expect.element(chart).toBeVisible()
    await userEvent.hover(chart, {position: ringPoints(chart.element())(0.3125, 0).local})
    await expect.element(page.getByText('~/Library', {exact: true})).toBeVisible()
    await expect.element(page.getByText('of Home folder')).toBeVisible()
    await expect.element(page.getByText('of the disk')).toBeVisible()
    await expect.element(page.getByText(/^80,000 files · changed /)).toBeVisible()
    await expect.element(page.getByText('3.8 GB cleanable in 4 items · 3.8 GB selected')).toBeVisible()
    await expect.element(page.getByText('Click to pin, then zoom in')).toBeVisible()
    await expect.element(page.getByText(/apparent sizes|^x /)).not.toBeInTheDocument()
  })

  test('hovering a sunburst slice lights it and its ancestors, dims the rest, and the card names only that slice', async () => {
    const screen = await render(<App loaded={fixture} history={at()} />)
    await screen.getByRole('tab', {name: 'Storage'}).click()
    const chart = screen.getByLabelText(/Storage sunburst/)
    await expect.element(chart).toBeVisible()
    const ring = ringPoints(chart.element())
    const caches = ring(0.1875, 1)
    await userEvent.hover(chart, {position: caches.local})
    await expect.element(page.getByText('~/Library/Caches', {exact: true})).toBeVisible()
    await expect.element(page.getByText('of Library')).toBeVisible()
    await expect.element(page.getByText('~/Library', {exact: true})).not.toBeInTheDocument()
    await settle(cssMs('--duration-fast', 250) * 3)
    expect(paintedOpacity(caches.client)).toBe(1)
    expect(paintedOpacity(ring(0.3125, 0).client)).toBe(1)
    expect(paintedOpacity(ring(0.5, 1).client)).toBeCloseTo(0.28)
    expect(paintedOpacity(ring(0.8125, 0).client)).toBeCloseTo(0.28)
  })

  test('hovering the disk donut names the segment with its size and share of the disk', async () => {
    const screen = await render(<App loaded={fixture} history={at()} />)
    const donut = screen.getByLabelText(/^Disk: /)
    const free = [...donut.element().querySelectorAll('path')].at(-1)
    if (!free) throw new Error('the donut drew no slices')
    await userEvent.hover(page.elementLocator(free))
    await expect.element(page.getByText('Free right now')).toBeVisible()
    await expect.element(page.getByText('10.0%')).toBeVisible()
  })

  test('insights draws every panel', async () => {
    const screen = await render(<App loaded={fixture} history={at()} />)
    await screen.getByRole('tab', {name: 'Insights'}).click()
    for (const title of ['When your files last changed', 'How old each big folder is', 'What kind of data', 'Cleanup sections by idle time', 'Largest files']) {
      await expect.element(screen.getByText(title)).toBeVisible()
    }
    await expect.element(page.getByText('This chart could not be drawn')).not.toBeInTheDocument()
    const kinds = screen.getByLabelText('Bytes by file kind')
    await expect.element(kinds.getByText(/^\d+(\.\d)? [KMG]B$/).first()).toBeVisible()
    await expect.element(kinds.getByText(/^[\d,.]{7,}$/)).not.toBeInTheDocument()
  })
})

describe('confirm dialog', () => {
  test('lists totals, every path for the Trash with its size, the steps that cannot be undone and the rejections', async () => {
    const confirmed = vi.fn()
    const screen = await render(<ConfirmDialog plan={PLAN} home="/Users/you" open onClose={() => {}} onClosed={() => {}} onConfirm={confirmed} />)
    const held = screen.getByRole('list', {name: 'Moved to the Trash'})
    await expect.element(screen.getByRole('heading', {name: /^Moved to the Trash \(undo available\)/})).toBeVisible()
    await expect.poll(() => held.getByRole('listitem').elements().length).toBe(4)
    await expect.element(held.getByRole('listitem').first()).toHaveTextContent('~/Library/Caches/app-a2.0 GB')
    await expect.element(screen.getByRole('list', {name: "Can't be undone"})).toHaveTextContent('git -C ~/code worktree remove ~/code/wtgit -C ~/code worktree prunedocker system prune -f')
    await expect.element(screen.getByRole('list', {name: 'Rejected by the safety checks'})).toHaveTextContent('~/old: already gone')
    await expect.element(screen.getByText('6 items in total')).toBeVisible()
    await screen.getByRole('button', {name: "Move 4 items to the Trash + 2 that can't be undone"}).click()
    expect(confirmed).toHaveBeenCalledOnce()
  })

  test('says Delete when nothing goes to the Trash, and waits for the plan', async () => {
    const plan = {...PLAN, paths: [], paths_bytes: 0, count: 2}
    const screen = await render(<ConfirmDialog plan={plan} home="" open onClose={() => {}} onClosed={() => {}} onConfirm={() => {}} />)
    await expect.element(screen.getByRole('button', {name: 'Delete 2 items'})).toBeEnabled()
    await expect.element(screen.getByRole('list', {name: 'Moved to the Trash'})).not.toBeInTheDocument()
    await screen.rerender(<ConfirmDialog plan={null} home="" open onClose={() => {}} onClosed={() => {}} onConfirm={() => {}} />)
    await expect.element(screen.getByText('Checking the selection…')).toBeVisible()
    await expect.element(screen.getByRole('button', {name: 'Move to the Trash'})).toBeDisabled()
  })
})

describe('treemap tiling', () => {
  interface Tile {
    value?: number
    children?: Tile[]
  }
  const WIDTH = 1131.5
  const HEIGHT = 480
  const layout = (tile: (node: HierarchyRectangularNode<Tile>, x0: number, y0: number, x1: number, y1: number) => void) =>
    treemap<Tile>().size([WIDTH, HEIGHT]).tile(tile)(hierarchy<Tile>({children: [{value: 758}, {value: 515}]}).sum(d => d.value ?? 0))
  const outside = (root: HierarchyRectangularNode<Tile>) => root.descendants().filter(n => n.x0 < 0 || n.y0 < 0 || n.x1 > WIDTH || n.y1 > HEIGHT)

  test('plain d3 squarify overshoots the container by float error', () => {
    expect(outside(layout(treemapSquarify))).not.toHaveLength(0)
  })

  test('the clamped tiler keeps every tile inside the container', () => {
    expect(outside(layout(squarifyInBounds))).toHaveLength(0)
  })
})

const GB = 1024 ** 3
const LIVE: Loaded = {data: NO_DATA, token: 'test-token', home: '/Users/you', live: true}

function itemEvents(categories: Category[]): ScanEvent[] {
  return categories
    .flatMap(c => c.items)
    .map((item, i) => ({type: 'item' as const, data: {category: categoryOf(item.path), item, elapsed_ms: 500 + i * 100}}))
}

function categoryOf(path: string) {
  const found = fixture.data.categories.find(c => c.items.some(i => i.path === path))
  if (!found) throw new Error(`no category for ${path}`)
  return {id: found.id, title: found.title, desc: found.desc, risk: found.risk}
}

const disk: ScanEvent = {type: 'disk', data: {total: 500 * GB, used: 400 * GB, free: 50 * GB, snapshots: 2, elapsed_ms: 20}}
const walked: ScanEvent = {
  type: 'walked',
  data: {home: 40 * GB, tree: fixture.data.tree, insights: fixture.data.insights ?? null, worktrees: 3, elapsed_ms: 4000},
}
const done: ScanEvent = {type: 'done', data: {reclaimable: 7 * GB, elapsed_ms: 9500}}
const items = itemEvents(fixture.data.categories)
function fed(events: readonly ScanEvent[], loaded: Loaded = LIVE) {
  const db = createDb(loaded)
  receiveScanEvents(db, events)
  return db
}

function stateOf(db: Db) {
  return {
    scan: db.scan.scan.synced.get('scan'),
    disk: db.scan.disk.synced.get('disk'),
    items: [...db.scan.items.synced.values()].toSorted((a, b) => a.path.localeCompare(b.path)),
    sections: [...db.scan.sections.synced.values()].toSorted((a, b) => a.id.localeCompare(b.id)),
  }
}

function scanOf(db: Db) {
  const scan = db.scan.scan.synced.get('scan')
  if (!scan) throw new Error('no scan row')
  return scan
}

const categoriesIn = (db: Db) => categoriesOf(db.scan.sections.collection.toArray, db.scan.items.collection.toArray)

describe('live scan data layer', () => {
  test('items land in their categories, ordered by risk then size like the server', () => {
    const db = fed([disk, ...items.toReversed()])
    const categories = categoriesIn(db)
    expect(categories.map(c => c.id)).toEqual(['docker', 'caches', 'node', 'big'])
    expect(categories.find(c => c.id === 'caches')?.items.map(i => i.label)).toEqual([
      '~/Library/Caches/app-a',
      '~/Library/Caches/app-b',
      '~/Library/Caches/app-c',
      '~/Library/Caches/app-d',
    ])
    const scan = db.scan.scan.synced.get('scan')
    expect([db.scan.disk.synced.get('disk')?.total, db.scan.disk.synced.get('disk')?.free, scan?.walked, scan?.done]).toEqual([500 * GB, 50 * GB, false, false])
  })

  test('a replay of every event leaves the state unchanged', () => {
    const events = [disk, ...items, walked, done]
    expect(stateOf(fed([...events, ...events]))).toEqual(stateOf(fed(events)))
  })

  test('walked, done and error each set their part, and elapsed tracks the scan clock', () => {
    const scan = scanOf(fed([disk, ...items, walked, done]))
    expect({walked: scan.walked, done: scan.done, home: scan.home, reclaimable: scan.reclaimable, tree: scan.tree}).toMatchObject({walked: true, done: true, home: 40 * GB, reclaimable: 7 * GB, tree: {name: '~'}})
    expect({worktrees: scan.worktrees, walkedAt: scan.walkedAt, elapsed: scan.elapsed}).toEqual({worktrees: 3, walkedAt: 4000, elapsed: 9500})
    expect(scanOf(fed([disk, {type: 'error', data: {message: 'walk failed', elapsed_ms: 30}}])).error).toBe('walk failed')
  })

  test('a burst of events applied in one pass lands in the same state as one at a time', () => {
    const rescan: ScanEvent = {type: 'rescan', data: {elapsed_ms: 0}}
    const events = [disk, ...items, walked, rescan, ...items.toReversed(), ...items, done]
    const oneByOne = createDb(LIVE)
    for (const event of events) receiveScanEvents(oneByOne, [event])
    expect(stateOf(fed(events))).toEqual(stateOf(oneByOne))
  })

  test('a finished run starts walked and done', () => {
    const db = createDb(fixture)
    expect(db.scan.scan.synced.get('scan')).toMatchObject({walked: true, done: true, tree: fixture.data.tree})
    expect(categoriesIn(db).flatMap(c => c.items.map(i => i.path)).toSorted()).toEqual(fixture.data.categories.flatMap(c => c.items.map(i => i.path)).toSorted())
  })

  test('preselected items are selected when they arrive, and an unticked one stays unticked on replay', () => {
    const appA = items[0]?.type === 'item' ? items[0].data.item : undefined
    if (!appA) throw new Error('fixture has no first item')
    const arrived = categoriesIn(fed(items.slice(0, 2)))
    const first = rowSelectionOf(arrived, NO_PICKS)
    expect(Object.keys(first)).toEqual(['/Users/you/Library/Caches/app-a', '/Users/you/Library/Caches/app-b'])
    const {[appA.path]: _untick, ...rest} = first
    const unticked = picksOf(arrived, rest)
    const replayed = rowSelectionOf(categoriesIn(fed([...items, ...items])), unticked)
    expect(replayed[appA.path]).toBeUndefined()
    expect(replayed['/Users/you/Library/Caches/app-d']).toBe(true)
    expect(replayed['/Users/you/code/web/node_modules']).toBeUndefined()
  })
})

const SHOWN = {visibility: 'visible'}
const DELETE = /^Delete \d+ items? · /

describe('live page', () => {

  test('streams items during the walk, reveals storage on walked, Delete stays live while scanning and undoes an approve', async () => {
    const {source, send} = fakeEventSource()
    const screen = await render(<App loaded={{...LIVE, openEvents: () => source}} history={at()} />)
    await expect.element(screen.getByText('Scanning your disk…').first().first()).toBeInTheDocument()
    await expect.element(screen.getByText('Walking disk')).toBeVisible()
    send({type: 'progress', data: {files: 1234, bytes: 5 * GB, dir: '/Users/you/Library/Caches', elapsed_ms: 300}})
    await expect.element(screen.getByText('1,234 files · 5.0 GB')).toBeVisible()
    for (const event of [disk, ...items.slice(0, 5)]) send(event)
    await expect.element(screen.getByText('~/Library/Caches/app-a')).toBeVisible()
    await screen.getByRole('tab', {name: 'Storage'}).click()
    await expect.element(screen.getByText(/^Where your/)).not.toBeInTheDocument()
    await expect.element(screen.getByText('Scanning your disk…').first()).toBeInTheDocument()
    send(walked)
    await expect.element(screen.getByText('Scanning your disk…').first()).not.toBeInTheDocument()
    await expect.element(screen.getByText('4 items selected · 3.8 GB')).toBeVisible()
    await expect.element(screen.getByText('Where your 500 GB went')).toBeVisible()
    await expect.element(screen.getByText('Checking 3 worktrees')).toBeVisible()
    await screen.getByRole('tab', {name: 'Cleanup'}).click()
    await screen.getByRole('button', {name: 'About deleting'}).click()
    await expect.element(screen.getByText(/You can delete what is listed while the scan runs/)).toBeVisible()
    await userEvent.keyboard('{Escape}')
    await expect.element(screen.getByRole('button', {name: DELETE})).toBeEnabled()
    for (const event of items.slice(5)) send(event)
    await expect.element(screen.getByRole('link', {name: /^Docker/})).toBeVisible()
    send(done)
    await expect.element(screen.getByText('Scan complete')).toBeVisible()
    await expect.element(screen.getByText('9.5s')).toBeVisible()
    await expect.element(screen.getByRole('button', {name: DELETE})).toBeEnabled()
    await expect.element(screen.getByText(/approved for deletion/)).not.toBeInTheDocument()
  })

  test('rescan keeps the view, filters and picks, and replaces the results at done', async () => {
    vi.spyOn(window, 'fetch').mockImplementation(async () => new Response('{}', {status: 202}))
    const sources: ReturnType<typeof fakeEventSource>[] = []
    const openEvents = (url: string) => {
      const fake = fakeEventSource()
      if (url.startsWith('/events')) sources.push(fake)
      return fake.source
    }
    const send = (event: ScanEvent) => sources.at(-1)?.send(event)
    const screen = await render(<App loaded={{...LIVE, openEvents}} history={at()} />)
    for (const event of [disk, ...items, walked, done]) send(event)
    await expect.element(screen.getByText('Scan complete')).toBeVisible()
    await screen.getByText('~/Library/Caches/app-a').click()
    await screen.getByRole('textbox', {name: 'Filter paths'}).fill('Library')
    await screen.getByRole('button', {name: 'Card view'}).click()
    await expect.element(screen.getByText('3 items selected · 1.8 GB')).toBeVisible()

    await screen.getByRole('button', {name: 'Rescan'}).click()
    await expect.element(screen.getByText('Rescanning')).toBeVisible()
    await expect.element(screen.getByRole('button', {name: 'Rescan'})).toBeDisabled()
    await expect.element(screen.getByRole('button', {name: DELETE})).toBeEnabled()
    await expect.element(screen.getByText('Scanning your disk…')).not.toBeInTheDocument()
    expect(window.fetch).toHaveBeenCalledWith('/rescan', expect.objectContaining({body: JSON.stringify({token: 'test-token'})}))
    await expect.poll(() => sources.length).toBe(2)
    const appE = {...fixture.data.categories[0]!.items[0]!, path: '/Users/you/Library/Caches/app-e', label: '~/Library/Caches/app-e', bytes: GB}
    const rescanned = items.filter(e => e.type !== 'item' || e.data.item.path !== '/Users/you/Library/Caches/app-d')
    send({type: 'rescan', data: {elapsed_ms: 0}})
    for (const event of [disk, ...rescanned, {type: 'item', data: {category: categoryOf(fixture.data.categories[0]!.items[0]!.path), item: appE, elapsed_ms: 900}} as const, walked]) send(event)
    await expect.element(screen.getByText('Checking 3 worktrees')).toBeVisible()
    await expect.element(screen.getByRole('button', {name: DELETE})).toBeEnabled()
    send(done)
    await expect.element(screen.getByText('Scan complete')).toBeVisible()
    await expect.element(screen.getByRole('button', {name: 'Card view'})).toHaveAttribute('aria-pressed', 'true')
    await expect.element(screen.getByRole('textbox', {name: 'Filter paths'})).toHaveValue('Library')
    await screen.getByRole('button', {name: 'List view'}).click()
    await expect.element(screen.getByText('~/Library/Caches/app-d')).not.toBeInTheDocument()
    await expect.element(screen.getByRole('checkbox', {name: /app-e/})).toBeChecked()
    await expect.element(screen.getByRole('checkbox', {name: /app-a/})).not.toBeChecked()
    await expect.element(screen.getByText('3 items selected · 2.5 GB')).toBeVisible()
    await expect.element(screen.getByRole('button', {name: DELETE})).toBeEnabled()

    await screen.getByRole('tab', {name: 'Storage'}).click()
    await screen.getByRole('button', {name: 'Treemap'}).click()
    await screen.getByRole('button', {name: 'Rescan'}).click()
    await expect.poll(() => sources.length).toBe(3)
    for (const event of [{type: 'rescan', data: {elapsed_ms: 0}} as const, disk, ...rescanned, walked, done]) send(event)
    await expect.element(screen.getByText('Scan complete')).toBeVisible()
    await expect.element(screen.getByRole('tab', {name: 'Storage'})).toHaveAttribute('aria-selected', 'true')
    await expect.element(screen.getByRole('button', {name: 'Treemap'})).toHaveAttribute('aria-pressed', 'true')
    await expect.element(screen.getByText('2 items selected · 1.5 GB')).toBeVisible()
    vi.restoreAllMocks()
  })

  test('a scan error shows and keeps approve locked', async () => {
    const {source, send} = fakeEventSource()
    const screen = await render(<App loaded={{...LIVE, openEvents: () => source}} history={at()} />)
    send(disk)
    send({type: 'error', data: {message: 'permission denied', elapsed_ms: 40}})
    await expect.element(screen.getByText(/The scan failed: permission denied/)).toBeVisible()
    await expect.element(screen.getByText('Scan failed')).toBeVisible()
    await expect.element(screen.getByRole('button', {name: 'The scan failed · nothing can be deleted'})).toBeDisabled()
  })
})

const backdrop = (container: HTMLElement) => container.querySelector('.t-backdrop canvas')

function emulateReducedMotion(value: 'reduce' | 'no-preference') {
  return cdp().send('Emulation.setEmulatedMedia', {features: [{name: 'prefers-reduced-motion', value}]})
}

function frameOf(canvas: Element | null | undefined) {
  if (!(canvas instanceof HTMLCanvasElement)) throw new Error('no canvas')
  return canvas.toDataURL()
}

function paintedOpacity({x, y}: {x: number; y: number}) {
  let opacity = 1
  for (let node = document.elementFromPoint(x, y); node && node.tagName !== 'svg'; node = node.parentElement) opacity *= Number(getComputedStyle(node).opacity)
  return opacity
}

function settle(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

describe('effects', () => {
  afterEach(async () => {
    vi.restoreAllMocks()
    await emulateReducedMotion('no-preference')
  })

  test('the flow field backdrop runs behind the summary while walking and leaves after walked', async () => {
    const {source, send} = fakeEventSource()
    const screen = await render(<App loaded={{...LIVE, openEvents: () => source}} history={at()} />)
    send(disk)
    await expect.poll(() => backdrop(screen.container)).toBeInstanceOf(HTMLCanvasElement)
    send(walked)
    await expect.element(screen.getByText('Checking 3 worktrees')).toBeVisible()
    await expect.poll(() => backdrop(screen.container)).toBeNull()
  })

  test('reduced motion draws one still frame of each effect', async () => {
    await emulateReducedMotion('reduce')
    const {source, send} = fakeEventSource()
    const live = await render(<App loaded={{...LIVE, openEvents: () => source}} history={at()} />)
    send(disk)
    await expect.poll(() => backdrop(live.container)).toBeInstanceOf(HTMLCanvasElement)
    const scanFrame = frameOf(backdrop(live.container))
    await settle(300)
    expect(frameOf(backdrop(live.container))).toBe(scanFrame)
    send(walked)
    await expect.poll(() => backdrop(live.container)).toBeNull()
    await live.unmount()
  })
})

type Screen = Awaited<ReturnType<typeof render>>

const statusOf = (screen: Screen) => screen.container.querySelector('header p')

const details = (screen: Screen) => screen.getByRole('button', {name: 'Details'})

function barSays(screen: Screen, text: string) {
  return expect.poll(() => statusOf(screen)?.textContent).toContain(text)
}

function fillOf(screen: Screen) {
  const fill = screen.container.querySelector('header > span[aria-hidden] > span')
  return fill instanceof HTMLElement ? fill.style.transform : ''
}

function layoutOf(screen: Screen) {
  const header = screen.container.querySelector('header')
  const summary = header?.nextElementSibling
  if (!header || !summary) throw new Error('no header or summary')
  return {header: header.getBoundingClientRect().height, summary: summary.getBoundingClientRect().top}
}

async function confirmDelete(screen: Screen) {
  await screen.getByRole('button', {name: DELETE}).click()
  await screen.getByRole('dialog').getByRole('button', {name: /^Move \d+ items to the Trash/}).click()
}

function approvedDb() {
  const caches = fixture.data.categories[0]?.items.map(i => i.path) ?? []
  const db = createDb(fixture)
  receiveCleanupEvents(db, [approvedEvent(caches) as CleanupEvent])
  for (const query of Object.values(db.queries)) void query.preload()
  return db
}

async function approveInApp() {
  mockServer()
  const {source} = fakeEventSource()
  const screen = await render(<App loaded={{...fixture, openEvents: () => source}} history={at()} />)
  await confirmDelete(screen)
  await barSays(screen, 'Approved · waiting for Claude to run it')
  return {screen, source}
}

describe('cleanup in the app', () => {
  beforeEach(() => {
    gsap.globalTimeline.timeScale(20)
  })
  afterEach(async () => {
    gsap.globalTimeline.timeScale(1)
    vi.restoreAllMocks()
    await emulateReducedMotion('no-preference')
  })

  test('approve hands back to Claude, then the bar, list and panel follow the real deletion', async () => {
    const {screen, source} = await approveInApp()
    sendRaw(source, 'done', {reclaimable: 7 * GB, elapsed_ms: 9500})
    for (const name of [DELETE, 'Rescan']) await expect.element(screen.getByRole('button', {name})).not.toBeInTheDocument()
    await expect.element(screen.getByRole('button', {name: 'End session…'})).toBeDisabled()
    await expect.element(screen.getByText('Approved: the cleanup runs in the background')).toBeVisible()
    await expect.element(screen.getByRole('checkbox', {name: 'Select all in Application caches'})).toBeDisabled()
    await expect.element(screen.getByText('Selected to free')).not.toBeInTheDocument()
    expect(screen.container.querySelectorAll('[data-film]')).toHaveLength(0)

    sendAll(source, cleanupEvents.slice(1, 3))
    await barSays(screen, 'Deleting · 2.0 GB of 3.8 GB · 1 of 5 · ~/Library/Caches/app-a')
    expect(fillOf(screen)).toMatch(/^scaleX\(0\.5333/)
    await expect.element(screen.getByText('1 of 4 done')).toBeVisible()
    await expect.element(screen.getByRole('progressbar', {name: 'Application caches done'})).toHaveAttribute('aria-valuenow', '53')
    await expect.element(screen.getByText('removed', {exact: true})).toBeVisible()
    await expect.element(screen.getByText('in progress', {exact: true}).first()).toBeVisible()
    await expect.element(screen.getByText('~/Library/Caches/app-a')).toHaveClass('truncate font-mono text-[12.5px]')

    sendAll(source, cleanupEvents.slice(3))
    await barSays(screen, 'Freed 3.5 GB · 3 removed · 1 kept · 1 not removed')
    expect(fillOf(screen)).toBe('scaleX(1)')
    await expect.element(screen.getByRole('checkbox', {name: 'Select all in Application caches'})).toBeEnabled()
    await expect.element(screen.getByRole('progressbar', {name: 'Application caches done'})).not.toBeInTheDocument()
    await expect.element(screen.getByText('Freed', {exact: true})).toBeVisible()
    const last = screen.getByRole('region', {name: 'Last cleanup'})
    await expect.element(last).toMatchTextContent(/^Cleanup finished · Freed 3\.5 GB · 4 items · 3\.8 GB approved/)
    await expect.element(last.getByText('still present after removal: permission denied', {exact: false})).toBeVisible()
    for (const name of [DELETE, 'End session…', 'Rescan']) await expect.element(screen.getByRole('button', {name})).toBeInTheDocument()
    expect(source.readyState, 'stays open: the next round, Undo, Empty and the Trash record can still change').toBe(1)

    await details(screen).click()
    const panel = screen.getByRole('dialog', {name: 'Cleanup progress'})
    await expect.element(panel).toBeVisible()
    const rows = panel.getByRole('list', {name: 'Cleanup events'}).getByRole('listitem')
    await expect.element(rows.first()).toHaveTextContent('2.0sKept /Users/you/code/wt1 uncommitted or untracked files')
    await expect.element(rows.nth(1)).toHaveTextContent('1.6sNot removed ~/Library/Caches/app-dstill present after removal: permission denied')
    await expect.element(rows.nth(4)).toHaveTextContent('0.9sRemoved ~/Library/Caches/app-a2.0 GB in 1.0s')
    await panel.getByRole('button', {name: 'Problems'}).click()
    await expect.poll(() => rows.elements().length).toBe(2)
    await panel.getByRole('button', {name: 'Removed'}).click()
    await expect.poll(() => rows.elements().length).toBe(3)
    await panel.getByRole('button', {name: 'Commands'}).click()
    await expect.element(panel.getByText('Nothing here yet.')).toBeVisible()
    await userEvent.keyboard('{Escape}')
    await expect.element(panel).not.toBeInTheDocument()
    await expect.element(details(screen)).toHaveFocus()
  })

  test('the movie opens on demand, keeps up with the stream and closes back to the app', async () => {
    const {screen, source} = await approveInApp()
    sendAll(source, cleanupEvents.slice(0, 3))
    await barSays(screen, 'Deleting ·')
    await details(screen).click()
    await screen.getByRole('button', {name: 'Watch the movie'}).click()
    const movie = screen.getByRole('dialog', {name: 'Cleanup movie'})
    await expect.element(movie.getByText('Application caches')).toBeVisible()
    await userEvent.keyboard('{Escape}')
    await expect.element(movie).not.toBeInTheDocument()
    sendAll(source, cleanupEvents.slice(3, 6))
    await barSays(screen, 'Deleting · 3.5 GB of 3.8 GB · 3 of 5')
    await details(screen).click()
    await screen.getByRole('button', {name: 'Watch the movie'}).click()
    sendAll(source, cleanupEvents.slice(6))
    await expect.element(movie.getByRole('heading', {name: 'You freed'})).toBeVisible()
    const freed = document.querySelector('[data-film="freed"]')
    if (!freed) throw new Error('no finale figure')
    await expect.element(page.elementLocator(freed)).toHaveTextContent(formatBytes(3.5 * GB))
    await expect.poll(() => document.querySelector('[data-film="counter"]')?.textContent).toBe(formatBytes(3.5 * GB))
    await expect.element(movie.getByText('still present after removal: permission denied').first()).toBeInTheDocument()
    await expect.poll(() => document.querySelector('[data-film]')?.closest('[data-settled]'), {timeout: 10_000}).not.toBeNull()
    expect(document.querySelector('[data-film="particles"] canvas')).toBeNull()
    await movie.getByRole('button', {name: 'Close'}).click()
    await expect.element(movie).not.toBeInTheDocument()
    await expect.element(details(screen)).toHaveFocus()
    expect(document.querySelector('canvas')).toBeNull()
    await barSays(screen, 'Freed 3.5 GB')
  })

  test('a dropped connection says so in every state until the stream comes back', async () => {
    const {screen, source} = await approveInApp()
    source.readyState = 0
    source.dispatchEvent(new Event('error'))
    await barSays(screen, 'Reconnecting to disk-clean…')
    source.readyState = 1
    source.dispatchEvent(new Event('open'))
    await barSays(screen, 'Approved · waiting for Claude to run it')
    sendAll(source, cleanupEvents.slice(0, 3))
    await barSays(screen, 'Deleting ·')
    source.readyState = 0
    source.dispatchEvent(new Event('error'))
    await barSays(screen, 'Reconnecting to disk-clean…')
    source.readyState = 1
    source.dispatchEvent(new Event('open'))
    await barSays(screen, 'Deleting ·')
  })

  test('a reload during the cleanup lands back in the app with the bar and panel', async () => {
    const {source} = fakeEventSource()
    const approved = ['/Users/you/Library/Caches/app-a', '/Users/you/code/web/node_modules']
    const screen = await render(<App loaded={{...fixture, openEvents: () => source}} history={at()} />)
    sendAll(source, [approvedEvent(approved), ...cleanupEvents.slice(1, 3)])
    await barSays(screen, 'Deleting · 2.0 GB of 5.0 GB · 1 of 5')
    await details(screen).click()
    await expect.element(screen.getByRole('dialog', {name: 'Cleanup progress'}).getByText('Removed ~/Library/Caches/app-a')).toBeVisible()
  })

  test('reduced motion keeps the bar and panel and offers no movie', async () => {
    await emulateReducedMotion('reduce')
    const {screen, source} = await approveInApp()
    sendAll(source, cleanupEvents)
    await barSays(screen, 'Freed 3.5 GB · 3 removed · 1 kept · 1 not removed')
    await details(screen).click()
    await expect.element(screen.getByRole('dialog', {name: 'Cleanup progress'})).toBeVisible()
    await expect.element(screen.getByRole('button', {name: 'Watch the movie'})).not.toBeInTheDocument()
    expect(document.querySelector('canvas')).toBeNull()
  })

  test('reduced motion opens the movie address as the final numbers and a static list, with no film', async () => {
    await emulateReducedMotion('reduce')
    const {source} = fakeEventSource()
    const screen = await render(<App loaded={{...fixture, openEvents: () => source}} history={at('/cleanup/caches?overlay=movie')} />)
    await sendAll(source, cleanupEvents)
    const movie = screen.getByRole('dialog', {name: 'Cleanup movie'})
    await expect.element(movie.getByRole('heading', {name: 'You freed'})).toBeVisible()
    await expect.element(movie.getByText('removed for good')).toBeVisible()
    await expect.element(movie.getByText('3 · 3.5 GB')).toBeVisible()
    await expect.element(movie.getByText('3s')).toBeVisible()
    await expect.element(movie.getByRole('list', {name: 'Everything removed'}).getByText('~/Library/Caches/app-b')).toBeVisible()
    expect(document.querySelector('[data-film="backdrop"]')).toBeNull()
    expect(document.querySelector('canvas')).toBeNull()
  })

  test('the header carries the progress without moving the layout, in the foreground colour', async () => {
    mockServer()
    const {source} = fakeEventSource()
    const screen = await render(<App loaded={{...fixture, openEvents: () => source}} history={at()} />)
    await expect.element(screen.getByRole('button', {name: DELETE})).toBeVisible()
    const before = layoutOf(screen)
    await confirmDelete(screen)
    await barSays(screen, 'Approved · waiting for Claude to run it')
    expect(layoutOf(screen)).toEqual(before)
    expect(fillOf(screen)).toBe('scaleX(1)')
    const status = statusOf(screen)
    if (!status) throw new Error('no status line')
    expect(getComputedStyle(status).color).toBe(getComputedStyle(document.body).color)
    sendAll(source, cleanupEvents.slice(0, 3))
    await barSays(screen, 'Deleting · 2.0 GB of 3.8 GB · 1 of 5')
    expect(layoutOf(screen)).toEqual(before)
    sendAll(source, cleanupEvents.slice(3))
    await barSays(screen, 'Freed 3.5 GB · 3 removed · 1 kept · 1 not removed')
    expect(layoutOf(screen)).toEqual(before)
    expect(getComputedStyle(status).color).toBe(getComputedStyle(document.body).color)
  })

  test('the cleanup log only grows, and outcomes already derived are reused, not rebuilt', async () => {
    const events = cleanupEvents as readonly CleanupEvent[]
    const db = approvedDb()
    await db.queries.outcomes.preload()
    receiveCleanupEvents(db, events.slice(0, 4))
    const before = db.queries.outcomes.toArray
    const log = db.queries.log.toArray
    receiveCleanupEvents(db, events.slice(4))
    expect(db.queries.log.toArray.slice(0, log.length).every((row, i) => row === log[i])).toBe(true)
    const after = db.queries.outcomes.toArray
    expect(after.slice(0, before.length).every((outcome, i) => outcome === before[i])).toBe(true)
    const removed = (path: string): CleanupEvent => ({type: 'removed', data: {path, bytes: 1, secs: 0, elapsed_ms: 1}})
    receiveCleanupEvents(db, [removed('/right')])
    receiveCleanupEvents(db, [removed('/left')])
    const size = db.cleanup.events.collection.size
    expect(db.queries.log.toArray.map(row => row.key).slice(-2)).toEqual(['/right', '/left'])
    receiveCleanupEvents(db, [removed('/left')])
    expect(db.cleanup.events.collection.size).toBe(size)
    expect(db.queries.outcomes.toArray.map(o => o.key)).toEqual([...after.map(o => o.key), '/right', '/left'])
  })

  test('a replayed stream adds no rows twice', async () => {
    const events = cleanupEvents as readonly CleanupEvent[]
    const once = approvedDb()
    receiveCleanupEvents(once, events)
    const twice = approvedDb()
    receiveCleanupEvents(twice, [...events, ...events])
    receiveCleanupEvents(once, events)
    await once.queries.latest.preload()
    expect(twice.queries.log.toArray.map(row => row.id)).toEqual(once.queries.log.toArray.map(row => row.id))
    const {done} = cleanupStatus(once.queries.status.toArray)
    expect(finaleOf(once.queries.latest.toArray.filter(isOutcome), done, 0)).toMatchObject({reclaimed: 3.5 * GB, sections: 1, seconds: 3})
  })

  test('a new run starts a fresh log: old keys and derived outcomes are not carried over', async () => {
    const events = cleanupEvents as readonly CleanupEvent[]
    const db = approvedDb()
    await db.queries.outcomes.preload()
    receiveCleanupEvents(db, events)
    const before = db.queries.outcomes.toArray
    const [, started, removed] = cleanupEvents
    receiveCleanupEvents(db, [
      {type: 'started', data: {...started.data, run: 'run-2'}},
      {type: 'removed', data: {...removed.data}},
    ])
    expect(db.queries.log.toArray.map(row => row.type)).toEqual(['started', 'removed'])
    const status = cleanupStatus(db.queries.status.toArray)
    const keys = db.queries.outcomes.toArray.map(o => o.key)
    expect([status.done, status.waiting, keys.includes(removed.data.path), keys.includes('/Users/you/code/wt')]).toEqual([null, false, true, false])
    const after = db.queries.outcomes.toArray
    expect(after.map(o => o.key)).toEqual([removed.data.path])
    expect(after[0]).not.toBe(before[0])
  })

  test('freed is the bytes actually removed, and the free-space change is labelled on its own', async () => {
    const {screen, source} = await approveInApp()
    sendAll(source, cleanupEvents.slice(1, 8))
    sendRaw(source, 'done', {free_before: 50 * GB, free_after: 49 * GB, elapsed_ms: 2500})
    await barSays(screen, 'Freed 3.5 GB · 3 removed · 1 kept · 1 not removed')
    await expect.element(screen.getByRole('region', {name: 'Last cleanup'})).toMatchTextContent(/^Cleanup finished · Freed 3\.5 GB · 4 items · 3\.8 GB approvedNot removed/)
    await details(screen).click()
    const panel = screen.getByRole('dialog', {name: 'Cleanup progress'})
    await expect.element(panel.getByText('Free space change, all apps')).toBeVisible()
    await expect.element(panel.getByText('−1.0 GB')).toBeVisible()
  })

  test('a new run on the same page replaces the previous run instead of mixing with it', async () => {
    const {screen, source} = await approveInApp()
    sendAll(source, cleanupEvents.slice(1, 3))
    await barSays(screen, 'Deleting · 2.0 GB of 3.8 GB · 1 of 5')
    sendRaw(source, 'started', {run: 'run-2', free: 52 * GB, paths: 4, worktrees: 1, commands: 0, bytes: 3.75 * GB, elapsed_ms: 0})
    sendRaw(source, 'removed', {path: '/Users/you/Library/Caches/app-b', bytes: GB, secs: 1, elapsed_ms: 300})
    await barSays(screen, 'Deleting · 1.0 GB of 3.8 GB · 1 of 5 · ~/Library/Caches/app-b')
    await details(screen).click()
    const rows = screen.getByRole('dialog', {name: 'Cleanup progress'}).getByRole('list', {name: 'Cleanup events'}).getByRole('listitem')
    await expect.poll(() => rows.elements().length).toBe(1)
    await expect.element(rows.first()).toHaveTextContent('0.3sRemoved ~/Library/Caches/app-b1.0 GB in 1.0s')
  })

  test('a cleanup that never starts says so and stops waiting', async () => {
    const {screen, source} = await approveInApp()
    sendRaw(source, 'abandoned', {reason: 'nothing passed the safety checks'})
    await barSays(screen, 'The cleanup did not start · nothing passed the safety checks')
    await expect.element(screen.getByRole('region', {name: 'Last cleanup'})).toHaveTextContent('The cleanup did not start · 4 items · 3.8 GB approved')
    expect(fillOf(screen)).toBe('scaleX(0)')
    expect(source.readyState).toBe(1)
    await expect.element(screen.getByRole('button', {name: DELETE})).toBeEnabled()
  })

  test('a cleanup that stops halfway keeps what it freed and says it stopped', async () => {
    const {screen, source} = await approveInApp()
    sendAll(source, cleanupEvents.slice(1, 3))
    sendRaw(source, 'abandoned', {reason: 'the cleanup process exited before it finished'})
    await barSays(screen, 'The cleanup stopped · the cleanup process exited before it finished · freed 2.0 GB')
    await expect.element(screen.getByRole('region', {name: 'Last cleanup'})).toHaveTextContent('The cleanup stopped before it finished · 4 items · 3.8 GB approved')
  })
})

describe('end session', () => {
  afterEach(() => vi.restoreAllMocks())

  test('the footer has no session-ending button; End session asks first, and Keep going changes nothing', async () => {
    vi.spyOn(window, 'fetch').mockResolvedValue(new Response('{}'))
    const screen = await render(<App loaded={fixture} history={at()} />)
    await expect.element(screen.getByRole('contentinfo').getByRole('button', {name: 'Clear selection'})).toBeVisible()
    expect(screen.getByRole('contentinfo').getByRole('button', {name: /cancel|end session/i}).elements()).toHaveLength(0)
    await screen.getByRole('button', {name: 'End session…'}).click()
    await screen.getByRole('button', {name: 'Keep going'}).click()
    await expect.element(screen.getByRole('button', {name: 'Keep going'})).not.toBeInTheDocument()
    expect(window.fetch).not.toHaveBeenCalled()
    await screen.getByRole('button', {name: 'End session…'}).click()
    await screen.getByRole('button', {name: 'End session', exact: true}).click()
    await expect.element(screen.getByRole('heading', {name: 'Cancelled'})).toBeVisible()
    expect(window.fetch).toHaveBeenCalledWith('/decide', expect.objectContaining({body: expect.stringContaining('"decision":"cancel"')}))
  })
})

function Swapping({text}: {text: string}) {
  const label = useTextSwap(text)
  return (
    <span key={label.shown} className={label.className} onAnimationEnd={label.onAnimationEnd}>
      {label.shown}
    </span>
  )
}

describe('text swap', () => {
  test('text that flips back before the swap finishes stays visible', async () => {
    const screen = await render(<Swapping text="Preview commands" />)
    await screen.rerender(<Swapping text="Checking…" />)
    await screen.rerender(<Swapping text="Preview commands" />)
    await settle(cssMs('--text-swap-dur', 150) * 2)
    await expect.element(screen.getByText('Preview commands')).toHaveStyle({opacity: '1'})
  })
})

function press(key: string) {
  document.body.dispatchEvent(new KeyboardEvent('keydown', {key, bubbles: true}))
}

const NESTED: Loaded = {
  ...fixture,
  data: {
    ...fixture.data,
    categories: [
      category('worktrees', 'Git worktrees', 'safe', [item('/Users/you/code/wt', 4 * GB)]),
      category('node', 'node_modules', 'safe', [item('/Users/you/code/wt/node_modules', GB), item('/Users/you/code/app/node_modules', GB)]),
    ],
  },
}

const NAMES: Loaded = {
  ...fixture,
  data: {...fixture.data, categories: [category('caches', 'Caches', 'safe', ['cache-10', 'cache-2', 'cache-1', 'Cache-3'].map(name => item(`/Users/you/${name}`, GB)))]},
}

describe('list fixes from QA', () => {
  afterEach(async () => {
    vi.restoreAllMocks()
    await page.viewport(1440, 960)
  })

  test('REV-3: closing the confirm dialog returns focus to Delete', async () => {
    mockServer()
    const screen = await render(<App loaded={fixture} history={at()} />)
    const preview = screen.getByRole('button', {name: DELETE})
    await preview.click()
    await expect.element(screen.getByRole('dialog')).toBeVisible()
    await userEvent.keyboard('{Escape}')
    await expect.element(screen.getByRole('dialog')).not.toBeInTheDocument()
    await expect.element(preview).toHaveFocus()
  })

  test('REV-4: at 1024 px the footer buttons keep their full label and icon', async () => {
    await page.viewport(1024, 768)
    const screen = await render(<App loaded={fixture} history={at()} />)
    for (const name of [DELETE]) {
      const button = screen.getByRole('button', {name}).element()
      expect(button.scrollWidth, String(name)).toBeLessThanOrEqual(button.clientWidth + 1)
      expect(button.querySelector('svg')?.getBoundingClientRect().width, String(name)).toBeGreaterThanOrEqual(14)
    }
  })

  test('REV-5: Delete is impossible with nothing selected', async () => {
    mockServer()
    const screen = await render(<App loaded={fixture} history={at()} />)
    press('d')
    await expect.element(screen.getByText('0 items selected · 0 B')).toBeVisible()
    await expect.element(screen.getByRole('button', {name: 'Select items to delete'})).toBeDisabled()
    expect(window.fetch).not.toHaveBeenCalled()
  })

  test('REV-6: section sizes and counts follow the active filters', async () => {
    const screen = await render(<App loaded={fixture} history={at()} />)
    const caches = screen.getByRole('link', {name: /^Application caches/})
    await expect.element(caches).toHaveTextContent('Application caches3.8 GB4/4')
    await screen.getByRole('textbox', {name: 'Filter paths'}).fill('app-a')
    await expect.element(caches).toHaveTextContent('Application caches2.0 GB1/1')
    await expect.element(screen.getByRole('link', {name: /^node_modules/})).not.toBeInTheDocument()
  })

  test('REV-7: name sort is natural and ignores case', async () => {
    const screen = await render(<App loaded={NAMES} history={at()} />)
    await screen.getByRole('combobox', {name: 'Sort'}).click()
    await screen.getByRole('option', {name: 'Name'}).click()
    const names = () => [...screen.container.querySelectorAll('[role="row"] [data-label]')].map(el => el.textContent)
    await expect.poll(names).toEqual(['~/cache-1', '~/cache-2', '~/Cache-3', '~/cache-10'])
  })

  test('STO-4 / REV-12: a selected path inside another selected path counts once', async () => {
    const screen = await render(<App loaded={NESTED} history={at()} />)
    await expect.element(screen.getByText('3 items selected · 5.0 GB')).toBeVisible()
    await screen.getByRole('link', {name: /^node_modules/}).click()
    await screen.getByRole('checkbox', {name: '~/code/app/node_modules'}).click()
    await expect.element(screen.getByText('2 items selected · 4.0 GB')).toBeVisible()
    expect(outermost(NESTED.data.categories.flatMap(c => c.items)).map(i => i.path)).toEqual(['/Users/you/code/wt', '/Users/you/code/app/node_modules'])
  })

  test('the list is a table with its full row count for assistive tech', async () => {
    const screen = await render(<App loaded={fixture} history={at()} />)
    const table = screen.getByRole('table', {name: 'Application caches'})
    await expect.element(table).toHaveAttribute('aria-rowcount', '5')
    await expect.element(table.getByRole('row').nth(1)).toHaveAttribute('aria-rowindex', '2')
  })
})
