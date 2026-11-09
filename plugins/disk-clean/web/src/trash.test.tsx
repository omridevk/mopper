import type {RouterHistory} from '@tanstack/react-router'
import {gsap} from 'gsap'
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest'
import {page, userEvent} from 'vitest/browser'
import {render} from 'vitest-browser-react'
import {App} from './App'
import {formatBytes, NO_DATA, type Loaded, type TrashEntry} from './lib/data'
import type {CategoryHead} from './lib/scan-feed'
import {fingerprint} from './lib/selection'
import {at, emptyEvents, entry, fixture, item, RUN, trashedEvents, undoEvents} from './test/fixture'
import {fakeEventSource, mockServer, PLAN, query, sendAll, sendRaw} from './test/page'
import './index.css'

const GB = 1024 ** 3
const DELETE = /^Delete \d+ items? · /
const NOW = 'Delete immediately…'
const WAITING = 'Approved · waiting for Claude to run it'
const SHOTS = import.meta.env.VITE_TRASH_SHOTS === '1'
const browser = navigator.userAgent.includes('Firefox') ? 'firefox' : 'chromium'

type Screen = Awaited<ReturnType<typeof render>>

const statusOf = (screen: Screen) => screen.container.querySelector('header p')
const barSays = (screen: Screen, text: string) => expect.poll(() => statusOf(screen)?.textContent).toContain(text)
const posted = (url: string) => vi.mocked(window.fetch).mock.calls.filter(([to]) => String(to) === url)
const bodyOf = (url: string, n = 0) => JSON.parse(String((posted(url)[n]?.[1] as RequestInit).body))
const footer = (screen: Screen) => screen.getByRole('contentinfo')
const lastCleanup = (screen: Screen) => screen.getByRole('region', {name: 'Last cleanup'})
const strip = () => document.querySelector('header + section')
const heroLabel = () => strip()?.querySelector(':scope > div.grow > div:first-child')?.textContent ?? ''
const statusLine = () => strip()?.querySelector(':scope > div.grow > div:last-child')?.textContent ?? ''
const freeLine = () => strip()?.querySelector(':scope > div.grow > div:nth-last-child(2)')?.textContent ?? ''
const scanningTitle = () => strip()?.textContent?.includes('Scanning your disk…') ?? false

async function shot(name: string) {
  if (!SHOTS) return
  await new Promise(resolve => setTimeout(resolve, 400))
  await page.screenshot({path: `../node_modules/.trash-shots/${name}-${browser}.png`})
}

const LONG_NAME = 'ms-vscode.cpptools-a-very-long-item-name-that-must-stay-visible'
const LONG = `/Users/you/Library/Application Support/Code/User/workspaceStorage/0f3a9c2b7d1e4a6f8b5c3d2e1f0a9b8c/${LONG_NAME}`

async function openApp(url = '/cleanup', plan: object = PLAN, failing: ReadonlySet<string> = new Set(), trash: TrashEntry[] = []) {
  mockServer(plan, failing)
  const {source} = fakeEventSource()
  const history: RouterHistory = at(url)
  const screen = await render(<App loaded={{...fixture, trash, openEvents: () => source}} history={history} />)
  return {screen, source, history}
}

async function trashedApp() {
  const opened = await openApp()
  await opened.screen.getByRole('button', {name: DELETE}).click()
  await opened.screen.getByRole('dialog').getByRole('button', {name: /^Move 4 items to the Trash/}).click()
  await barSays(opened.screen, WAITING)
  await sendAll(opened.source, trashedEvents)
  await barSays(opened.screen, `Moved to Trash ${formatBytes(3.75 * GB)} · undo available`)
  return opened
}

describe('Delete moves to the Trash, Delete immediately skips it', () => {
  beforeEach(() => gsap.globalTimeline.timeScale(20))
  afterEach(() => {
    gsap.globalTimeline.timeScale(1)
    vi.restoreAllMocks()
  })

  test('Delete opens the Trash confirm; Cancel and Escape change nothing; Confirm approves into the Trash', async () => {
    const {screen, history} = await openApp()
    const remove = screen.getByRole('button', {name: DELETE})
    await expect.element(remove).toHaveTextContent('Delete 4 items · 3.8 GB')

    await remove.click()
    const dialog = screen.getByRole('dialog', {name: 'Move to the Trash'})
    expect(history.location.pathname).toBe('/cleanup/caches/confirm')
    expect(query(history).now).toBeUndefined()
    await expect.element(dialog.getByRole('heading', {name: /^Moved to the Trash \(undo available\)/})).toBeVisible()
    await expect.element(dialog.getByRole('heading', {name: /^Can't be undone/})).toBeVisible()
    await expect.element(dialog.getByRole('heading', {name: /^Rejected by the safety checks/})).toBeVisible()
    await expect.poll(() => dialog.getByRole('list', {name: 'Moved to the Trash'}).getByRole('listitem').elements().length).toBe(4)
    await shot('confirm-delete')
    await dialog.getByRole('button', {name: 'Cancel'}).click()
    await expect.element(dialog).not.toBeInTheDocument()
    expect(history.location.pathname).toBe('/cleanup/caches')

    await remove.click()
    await expect.element(dialog).toBeVisible()
    await userEvent.keyboard('{Escape}')
    await expect.element(dialog).not.toBeInTheDocument()
    expect(posted('/decide')).toHaveLength(0)

    await remove.click()
    await dialog.getByRole('button', {name: "Move 4 items to the Trash + 2 that can't be undone"}).click()
    await barSays(screen, WAITING)
    const caches = ['app-a', 'app-b', 'app-c', 'app-d'].map(name => `/Users/you/Library/Caches/${name}`)
    expect(bodyOf('/decide')).toEqual({decision: 'approve', token: 'test-token', add: '', drop: '', listed: null, fingerprint: fingerprint(caches), mode: 'trash'})
    await expect.element(screen.getByRole('button', {name: DELETE})).not.toBeInTheDocument()
  })

  test('Delete immediately has a stronger confirm with exact figures, no default focus on the action, and its own address', async () => {
    const {screen, history} = await openApp()
    await screen.getByRole('button', {name: NOW}).click()
    const dialog = screen.getByRole('dialog', {name: "Delete immediately? This can't be undone"})
    await expect.element(dialog).toBeVisible()
    expect(history.location.pathname).toBe('/cleanup/caches/confirm')
    expect(query(history).now).toBe(true)
    await expect.element(dialog.getByText('These skip the Trash and are removed for good.')).toBeVisible()
    const go = dialog.getByRole('button', {name: `Delete 6 items immediately · ${formatBytes(9.75 * GB)}`})
    await expect.element(go).toBeVisible()
    await expect.element(dialog.getByRole('button', {name: 'Cancel'})).toHaveFocus()
    await expect.element(dialog.getByRole('list', {name: 'Moved to the Trash'})).not.toBeInTheDocument()
    await expect.poll(() => dialog.getByRole('list', {name: 'Deleted immediately'}).getByRole('listitem').elements().length).toBe(4)
    await shot('confirm-delete-immediately')
    await userEvent.keyboard('{Enter}')
    await expect.element(dialog).not.toBeInTheDocument()
    expect(posted('/decide')).toHaveLength(0)
    expect(query(history).now).toBeUndefined()

    await screen.getByRole('button', {name: NOW}).click()
    await go.click()
    await barSays(screen, WAITING)
    expect(bodyOf('/decide').mode).toBe('now')
  })

  test('the Finder shortcuts open the right confirm anywhere but a text field, and plain Delete only inside the item table', async () => {
    const {screen, history} = await openApp()
    await screen.getByRole('textbox', {name: 'Filter paths'}).click()
    await userEvent.keyboard('ab{Shift>}{Backspace}{/Shift}{Meta>}{Backspace}{/Meta}')
    expect(history.location.pathname).toBe('/cleanup/caches')
    await screen.getByRole('textbox', {name: 'Filter paths'}).fill('')
    await userEvent.click(screen.getByRole('heading', {name: 'Application caches'}))

    await userEvent.keyboard('{Meta>}{Alt>}{Backspace}{/Alt}{/Meta}')
    await expect.element(screen.getByRole('dialog', {name: "Delete immediately? This can't be undone"})).toBeVisible()
    await userEvent.keyboard('{Escape}')
    await expect.element(screen.getByRole('dialog')).not.toBeInTheDocument()

    await userEvent.keyboard('{Shift>}{Backspace}{/Shift}')
    await expect.element(screen.getByRole('dialog', {name: "Delete immediately? This can't be undone"})).toBeVisible()
    await userEvent.keyboard('{Escape}')
    await expect.element(screen.getByRole('dialog')).not.toBeInTheDocument()

    await userEvent.keyboard('{Backspace}{Delete}')
    expect(history.location.pathname).toBe('/cleanup/caches')

    await userEvent.keyboard('{Meta>}{Backspace}{/Meta}')
    await expect.element(screen.getByRole('dialog', {name: 'Move to the Trash'})).toBeVisible()
    expect(query(history).now).toBeUndefined()
    await userEvent.keyboard('{Escape}')
    await expect.element(screen.getByRole('dialog')).not.toBeInTheDocument()

    for (const key of ['{Backspace}', '{Delete}']) {
      screen.getByRole('table', {name: 'Application caches'}).getByRole('checkbox').first().element().focus()
      await userEvent.keyboard(key)
      await expect.element(screen.getByRole('dialog', {name: 'Move to the Trash'})).toBeVisible()
      await userEvent.keyboard('{Escape}')
      await expect.element(screen.getByRole('dialog')).not.toBeInTheDocument()
    }
  })

  test('paths read from the home folder, a long path keeps its name, and items already in a Trash are listed as gone for good', async () => {
    const plan = {...PLAN, paths: [{path: LONG, bytes: GB, trashed: false}, {path: '/Users/you/.Trash/old', bytes: GB, trashed: true}, ...PLAN.paths]}
    const {screen} = await openApp('/cleanup', plan)
    await screen.getByRole('button', {name: DELETE}).click()
    const dialog = screen.getByRole('dialog', {name: 'Move to the Trash'})
    const rows = dialog.getByRole('list', {name: 'Moved to the Trash'}).getByRole('listitem')
    await expect.element(rows.first()).toHaveTextContent(`~/Library/Application Support/Code/User/workspaceStorage/0f3a9c2b7d1e4a6f8b5c3d2e1f0a9b8c/${LONG_NAME}1.0 GB`)
    const final = dialog.getByRole('list', {name: "Can't be undone"}).getByRole('listitem')
    await expect.element(final.first()).toHaveTextContent('rm -rf -- ~/.Trash/old')
    await expect.element(final.nth(1)).toHaveTextContent('git -C ~/code worktree remove ~/code/wt')
    await expect.element(dialog.getByText('/Users/you', {exact: false})).not.toBeInTheDocument()
  })
})

describe('after a Trash delete: Undo and Empty these', () => {
  beforeEach(() => gsap.globalTimeline.timeScale(20))
  afterEach(() => {
    gsap.globalTimeline.timeScale(1)
    vi.restoreAllMocks()
  })

  test('Moved to Trash is never shown as freed, and Undo puts everything back', async () => {
    const {screen, source} = await trashedApp()
    await expect.poll(heroLabel).toBe('In the Trash · undo available')
    await expect.element(lastCleanup(screen)).toMatchTextContent(/^Moved to Trash 3\.8 GB · undo available.*in your Trash until you empty it/)
    expect(statusOf(screen)?.textContent).toContain(`freed ${formatBytes(GB)}`)
    await expect.element(footer(screen).getByRole('button', {name: 'Empty these from Trash'})).toBeVisible()
    await shot('footer-after-trash')

    await footer(screen).getByRole('button', {name: 'Undo'}).click()
    await expect.poll(() => posted('/undo').length).toBe(1)
    expect(bodyOf('/undo')).toEqual({token: 'test-token', ids: [0, 1, 2, 3].map(i => entry(i, 'trashed').id)})
    await sendAll(source, undoEvents.slice(0, 2))
    await barSays(screen, 'Putting back ·')
    await expect.poll(heroLabel).toBe('Putting back')
    await sendAll(source, undoEvents.slice(2))
    await barSays(screen, `Put back ${formatBytes(3.75 * GB)} · nothing left in the Trash`)
    await expect.poll(heroLabel).toBe('Put back')
    await expect.element(lastCleanup(screen)).toMatchTextContent(new RegExp(`^Put back ${formatBytes(3.75 * GB)} · nothing left in the Trash`))
    await expect.element(footer(screen).getByRole('button', {name: 'Empty these from Trash'})).not.toBeInTheDocument()
  })

  test('Empty these asks first, acts only on this run, and the freed figure and payoff follow the real empty', async () => {
    const {screen, source, history} = await trashedApp()
    const empty = footer(screen).getByRole('button', {name: 'Empty these from Trash'})
    await empty.click()
    const confirm = screen.getByRole('dialog', {name: 'Empty these from the Trash?'})
    await expect.element(confirm).toBeVisible()
    expect(history.location.pathname).toBe('/cleanup/caches/empty')
    await expect.element(confirm.getByRole('button', {name: 'Keep them in the Trash'})).toHaveFocus()
    await userEvent.keyboard('{Escape}')
    await expect.element(confirm).not.toBeInTheDocument()
    await expect.poll(() => history.location.pathname).toBe('/cleanup/caches')
    expect(posted('/empty')).toHaveLength(0)

    await empty.click()
    await confirm.getByRole('button', {name: `Empty 4 items · ${formatBytes(3.75 * GB)} for good`}).click()
    await expect.poll(() => posted('/empty').length).toBe(1)
    expect(bodyOf('/empty').ids).toEqual([0, 1, 2, 3].map(i => entry(i, 'trashed').id))
    await sendAll(source, emptyEvents.slice(0, 3))
    await barSays(screen, 'Emptying from the Trash ·')
    await sendAll(source, emptyEvents.slice(3))
    await barSays(screen, `Freed ${formatBytes(4.75 * GB)} · 5 removed`)
    await expect.poll(heroLabel).toBe('Freed')
    await expect.element(lastCleanup(screen)).toMatchTextContent(`Cleanup finished · Freed ${formatBytes(4.75 * GB)}`)

    await screen.getByRole('button', {name: 'Details'}).click()
    await screen.getByRole('button', {name: 'Watch the movie'}).click()
    const movie = screen.getByRole('dialog', {name: 'Cleanup movie'})
    await expect.element(movie.getByRole('heading', {name: 'You freed'})).toBeVisible()
  })

  test('the Empty confirm is its own address and is refused when nothing is approved', async () => {
    const cold = await openApp('/cleanup/caches/empty')
    await expect.poll(() => cold.history.location.pathname).toBe('/cleanup/caches')
    await expect.element(cold.screen.getByRole('dialog')).not.toBeInTheDocument()
  })
})

const CACHES: CategoryHead = {id: 'caches', title: 'Application caches', desc: 'caches', risk: 'safe'}
const cacheA = item('/Users/you/Library/Caches/app-a', 2 * GB, {line: 1})

describe('one phase drives every surface', () => {
  beforeEach(() => gsap.globalTimeline.timeScale(20))
  afterEach(() => {
    gsap.globalTimeline.timeScale(1)
    vi.restoreAllMocks()
  })

  test('approve mid-scan, move to the Trash, then empty: header, hero label, hero title and status line agree at each step', async () => {
    mockServer({...PLAN, paths: PLAN.paths.slice(0, 1), final: [], final_count: 0, rejected: [], count: 1, bytes: 2 * GB})
    const scan = fakeEventSource()
    const cleanup = fakeEventSource()
    const sources = [scan.source, cleanup.source]
    const loaded: Loaded = {data: NO_DATA, token: 'test-token', home: '/Users/you', live: true, run: RUN, trash: [], openEvents: () => sources.shift() ?? cleanup.source}
    const screen = await render(<App loaded={loaded} history={at()} />)
    scan.send({type: 'disk', data: {total: 500 * GB, used: 400 * GB, free: 50 * GB, snapshots: 0, elapsed_ms: 10}})
    scan.send({type: 'progress', data: {files: 1234, bytes: 5 * GB, dir: '/Users/you/Library/Caches/deep', elapsed_ms: 50}})
    scan.send({type: 'item', data: {category: CACHES, item: cacheA, elapsed_ms: 60}})
    await expect.poll(scanningTitle).toBe(true)
    await expect.poll(heroLabel).toBe('Selected to free')

    await screen.getByRole('button', {name: DELETE}).click()
    await screen.getByRole('dialog').getByRole('button', {name: /^Move 1 item to the Trash/}).click()
    const agree = async (bar: string, label: string, status: string) => {
      await barSays(screen, bar)
      await expect.poll(heroLabel).toBe(label)
      await expect.poll(statusLine).toContain(status)
      expect(scanningTitle()).toBe(false)
      expect(statusLine()).not.toContain('Scan stopped at approval')
      expect(strip()?.textContent).not.toContain('Library/Caches/deep')
    }
    await agree(WAITING, 'Approved · waiting to start', 'Waiting to start')

    const trashed = {...entry(0, 'trashed'), run: RUN}
    sendRaw(cleanup.source, 'started', {run: 'r', free: 50 * GB, paths: 1, trash: 1, worktrees: 0, commands: 0, bytes: 2 * GB, elapsed_ms: 0})
    sendRaw(cleanup.source, 'free', {free: 50 * GB, elapsed_ms: 10})
    await agree('Moving to the Trash · 0 B of 2.0 GB', 'Moving to the Trash', 'Moving to the Trash')
    expect(freeLine()).toContain('the Trash keeps the space until it is emptied')

    sendRaw(cleanup.source, 'trashed', {id: trashed.id, path: cacheA.path, bytes: 2 * GB, trashed_path: trashed.trashed, elapsed_ms: 100})
    sendRaw(cleanup.source, 'trash', {entries: [trashed]})
    sendRaw(cleanup.source, 'done', {removed: 0, removed_bytes: 0, trashed: 1, trashed_bytes: 2 * GB, free_before: 50 * GB, free_after: 50 * GB, elapsed_ms: 200})
    await agree('Moved to Trash 2.0 GB · undo available', 'In the Trash · undo available', 'In the Trash · undo available')
    expect(freeLine()).toContain('free space 50.0 GB of 500 GB · the Trash keeps the space until it is emptied')
    expect(freeLine()).not.toMatch(/was .*, now/)

    await footer(screen).getByRole('button', {name: 'Empty these from Trash'}).click()
    await screen.getByRole('dialog').getByRole('button', {name: /^Empty 1 item/}).click()
    await expect.poll(() => posted('/empty').length).toBe(1)
    sendRaw(cleanup.source, 'empty_started', {job: 'j', count: 1, bytes: 2 * GB, free: 50 * GB, elapsed_ms: 300})
    await agree('Emptying from the Trash · 0 B of 2.0 GB', 'Emptying from the Trash', 'Emptying the Trash')
    expect(freeLine()).toContain('updates as space comes back')
    sendRaw(cleanup.source, 'free', {free: 51 * GB, elapsed_ms: 320})
    await expect.poll(freeLine).toContain(`free space was ${formatBytes(50 * GB)}, now ${formatBytes(51 * GB)}`)

    sendRaw(cleanup.source, 'emptied', {job: 'j', id: trashed.id, path: cacheA.path, trashed_path: trashed.trashed, bytes: 2 * GB, outcome: 'emptied', reason: '', elapsed_ms: 330})
    sendRaw(cleanup.source, 'trash', {entries: [{...trashed, state: 'emptied'}]})
    sendRaw(cleanup.source, 'empty_done', {job: 'j', emptied: 1, emptied_bytes: 2 * GB, kept: 0, trashed: 0, trashed_bytes: 0, free_before: 50 * GB, free_after: 52 * GB, elapsed_ms: 400})
    await agree('Freed 2.0 GB · 1 removed', 'Freed', 'Cleanup finished')
    await expect.poll(freeLine).toContain(`free space was ${formatBytes(50 * GB)}, now ${formatBytes(52 * GB)}`)
  })
})

const RUN_B = 'run-20261005-011559-f9befc78'
const HISTORY: TrashEntry[] = [
  entry(0, 'trashed'),
  entry(1, 'trashed', {reason: 'the original path exists again, so it stays in the Trash'}),
  entry(2, 'put-back'),
  entry(3, 'emptied'),
  {...entry(0, 'restored'), id: 'e5'.padStart(16, '0'), run: RUN_B, at: 1_780_000_000, original: '/Users/you/code/app/node_modules'},
  {...entry(1, 'trashed'), id: 'f6'.padStart(16, '0'), run: RUN_B, at: 1_780_000_001, original: '/Users/you/.npm/_cacache'},
  {...entry(2, 'failed'), id: 'a7'.padStart(16, '0'), run: RUN_B, at: 1_780_000_002, original: '/Users/you/Library/Logs/old', reason: 'the item in the Trash was replaced, not touched'},
]

describe('the Trash view', () => {
  afterEach(() => vi.restoreAllMocks())

  test('lists every item we put in the Trash across runs, in each state, with paths from home', async () => {
    const {screen} = await openApp('/trash', PLAN, new Set(), HISTORY)
    const list = screen.getByRole('list', {name: 'Items disk-clean moved to the Trash'})
    await expect.element(list).toBeVisible()
    await expect.element(screen.getByRole('tab', {name: 'Trash'})).toHaveAttribute('aria-selected', 'true')
    await expect.element(list.getByText('~/Library/Caches/app-a')).toBeVisible()
    for (const state of ['In the Trash', 'Put back in Finder', 'Emptied', 'Put back', 'Failed']) await expect.element(list.getByText(state, {exact: true}).first()).toBeVisible()
    await expect.element(list.getByText('the original path exists again, so it stays in the Trash')).toBeVisible()
    await expect.element(list.getByText('this cleanup', {exact: false})).toBeVisible()
    await expect.element(screen.getByText(`3 items in the Trash · ${formatBytes(4 * GB)}`)).toBeVisible()
    await expect.element(list.getByText('/Users/you', {exact: false})).not.toBeInTheDocument()
    await shot('trash-view')
  })

  test('Undo per item and per run posts exactly those ids; selection lives in the address', async () => {
    const {screen, history} = await openApp('/trash', PLAN, new Set(), HISTORY)
    const list = screen.getByRole('list', {name: 'Items disk-clean moved to the Trash'})
    await list.getByRole('button', {name: 'Undo: put it back'}).first().click()
    await expect.poll(() => posted('/undo').length).toBe(1)
    expect(bodyOf('/undo').ids).toEqual([HISTORY[0]!.id])

    await list.getByRole('button', {name: 'Undo', exact: true}).nth(1).click()
    await expect.poll(() => posted('/undo').length).toBe(2)
    expect(bodyOf('/undo', 1).ids).toEqual(['f6'.padStart(16, '0')])

    await list.getByRole('checkbox', {name: '~/Library/Caches/app-a'}).click()
    await list.getByRole('checkbox', {name: '~/.npm/_cacache'}).click()
    expect(query(history).pick).toBe(`${HISTORY[0]!.id}.${'f6'.padStart(16, '0')}`)
    await expect.element(screen.getByText('2 selected')).toBeVisible()
    await expect.element(list.getByRole('checkbox', {name: '~/Library/Caches/app-c'})).toBeDisabled()
    await screen.getByRole('button', {name: 'Undo selected'}).click()
    await expect.poll(() => posted('/undo').length).toBe(3)
    expect(bodyOf('/undo', 2).ids).toEqual([HISTORY[0]!.id, 'f6'.padStart(16, '0')])
  })

  test('Empty selected, per run and per item ask first and empty only those; the run filter is in the address', async () => {
    const {screen, history} = await openApp('/trash', PLAN, new Set(), HISTORY)
    const list = screen.getByRole('list', {name: 'Items disk-clean moved to the Trash'})
    await list.getByRole('button', {name: 'Empty…'}).first().click()
    const confirm = screen.getByRole('dialog', {name: 'Empty these from the Trash?'})
    await expect.element(confirm.getByRole('button', {name: `Empty 2 items · ${formatBytes(3 * GB)} for good`})).toBeVisible()
    expect(history.location.pathname).toBe('/trash/empty')
    expect(query(history).target).toBe(`run:${RUN}`)
    await userEvent.keyboard('{Escape}')
    await expect.element(confirm).not.toBeInTheDocument()
    expect(posted('/empty')).toHaveLength(0)

    await list.getByRole('button', {name: 'Empty from the Trash…'}).nth(2).click()
    await confirm.getByRole('button', {name: `Empty 1 item · ${formatBytes(GB)} for good`}).click()
    await expect.poll(() => posted('/empty').length).toBe(1)
    expect(bodyOf('/empty').ids).toEqual(['f6'.padStart(16, '0')])
    await expect.poll(() => history.location.pathname).toBe('/trash')

    await screen.getByRole('combobox', {name: 'Show cleanup'}).click()
    await screen.getByRole('option', {name: /^Cleanup of /}).nth(1).click()
    expect(query(history).run).toBe(RUN_B)
    await expect.element(list.getByText('~/Library/Caches/app-a')).not.toBeInTheDocument()
    await expect.element(list.getByText('~/.npm/_cacache')).toBeVisible()
  })

  test('a refused Undo or Empty says so at the action, keeps the rows, and Retry sends the same ids', async () => {
    const failing = new Set(['/undo', '/empty'])
    const {screen} = await openApp('/trash', PLAN, failing, HISTORY)
    const list = screen.getByRole('list', {name: 'Items disk-clean moved to the Trash'})
    await list.getByRole('button', {name: 'Undo: put it back'}).first().click()
    await expect.element(screen.getByText('Undo did not go through: disk-clean answered 500 to /undo: server said no')).toBeVisible()
    await expect.element(list.getByText('In the Trash', {exact: true}).first()).toBeVisible()
    failing.clear()
    await screen.getByRole('button', {name: 'Retry'}).click()
    await expect.poll(() => posted('/undo').length).toBe(2)
    expect(bodyOf('/undo', 1).ids).toEqual([HISTORY[0]!.id])
    await expect.element(screen.getByText(/Undo did not go through/)).not.toBeInTheDocument()
  })

  test('rows follow the record: a sync event from the server changes their state', async () => {
    const {screen, source} = await trashedApp()
    await screen.getByRole('tab', {name: 'Trash'}).click()
    const list = screen.getByRole('list', {name: 'Items disk-clean moved to the Trash'})
    await expect.element(list.getByText('In the Trash', {exact: true}).first()).toBeVisible()
    sendRaw(source, 'trash', {entries: [entry(0, 'put-back'), entry(1, 'emptied')]})
    await expect.element(list.getByText('Put back in Finder', {exact: true})).toBeVisible()
    await expect.element(list.getByText('Emptied', {exact: true})).toBeVisible()
    await barSays(screen, `Moved to Trash ${formatBytes(0.75 * GB)} · undo available`)
  })

  test('nothing in the record says so once, centred, and a run filter that matches nothing offers all runs', async () => {
    const {screen} = await openApp('/trash')
    await expect.element(screen.getByText('Nothing disk-clean moved to the Trash yet.')).toBeVisible()
    await expect.element(screen.getByRole('list', {name: 'Items disk-clean moved to the Trash'})).not.toBeInTheDocument()
  })
})

describe('a request the server refuses rolls back and says so where it was made', () => {
  beforeEach(() => gsap.globalTimeline.timeScale(20))
  afterEach(() => {
    gsap.globalTimeline.timeScale(1)
    vi.restoreAllMocks()
  })

  test('a refused Delete rolls back to the list, shows why at the footer, and Retry approves once the server recovers', async () => {
    const failing = new Set(['/decide'])
    const {screen} = await openApp('/cleanup', PLAN, failing)
    await screen.getByRole('button', {name: DELETE}).click()
    await screen.getByRole('dialog').getByRole('button', {name: /^Move 4 items to the Trash/}).click()
    await expect.element(footer(screen).getByText('Delete did not go through, nothing was deleted: disk-clean answered 500 to /decide: server said no')).toBeVisible()
    await expect.element(screen.getByRole('button', {name: DELETE})).toBeEnabled()
    failing.delete('/decide')
    await footer(screen).getByRole('button', {name: 'Retry'}).click()
    await barSays(screen, WAITING)
    expect(bodyOf('/decide', 1).mode).toBe('trash')
  })

  test('a refused Undo or Empty keeps everything in the Trash and offers Retry at the footer', async () => {
    const opened = await trashedApp()
    const failing = new Set(['/undo', '/empty'])
    vi.restoreAllMocks()
    mockServer(PLAN, failing)
    await footer(opened.screen).getByRole('button', {name: 'Undo'}).click()
    await expect.element(footer(opened.screen).getByText('Undo did not go through: disk-clean answered 500 to /undo: server said no')).toBeVisible()
    await expect.element(footer(opened.screen).getByRole('button', {name: 'Undo'})).toBeEnabled()
    await footer(opened.screen).getByRole('button', {name: 'Empty these from Trash'}).click()
    await opened.screen.getByRole('dialog', {name: 'Empty these from the Trash?'}).getByRole('button', {name: /^Empty 4 items/}).click()
    await expect.element(footer(opened.screen).getByText('Empty did not go through: disk-clean answered 500 to /empty: server said no')).toBeVisible()
    await barSays(opened.screen, `Moved to Trash ${formatBytes(3.75 * GB)} · undo available`)
    failing.clear()
    await footer(opened.screen).getByRole('button', {name: 'Retry'}).first().click()
    await expect.poll(() => posted('/undo').length).toBe(2)
    await expect.element(footer(opened.screen).getByText(/Undo did not go through/)).not.toBeInTheDocument()
  })

  test('a busy record is said plainly, without a Retry that would fail the same way', async () => {
    const opened = await trashedApp()
    vi.restoreAllMocks()
    vi.spyOn(window, 'fetch').mockImplementation(async () => new Response('', {status: 409}))
    await footer(opened.screen).getByRole('button', {name: 'Undo'}).click()
    await expect.element(footer(opened.screen).getByText('Undo did not go through: Another cleanup, undo or empty is running; try again when it finishes')).toBeVisible()
    await expect.element(footer(opened.screen).getByRole('button', {name: 'Retry'})).not.toBeInTheDocument()
  })

  test('while in the Trash, a dropped stream shows in the header and Undo and Empty wait for it with a reason', async () => {
    const {screen, source} = await trashedApp()
    source.readyState = 0
    source.dispatchEvent(new Event('error'))
    await barSays(screen, 'Reconnecting to disk-clean…')
    await expect.element(footer(screen).getByRole('button', {name: 'Undo'})).toBeDisabled()
    await expect.element(footer(screen).getByRole('button', {name: 'Empty these from Trash'})).toBeDisabled()
    await expect.element(footer(screen).getByText('Undo and Empty wait until disk-clean is reachable again')).toBeVisible()
    source.readyState = 1
    source.dispatchEvent(new Event('open'))
    await barSays(screen, `Moved to Trash ${formatBytes(3.75 * GB)} · undo available`)
    await expect.element(footer(screen).getByRole('button', {name: 'Undo'})).toBeEnabled()
  })
})
