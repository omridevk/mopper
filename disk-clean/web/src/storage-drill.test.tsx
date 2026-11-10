import {gsap} from 'gsap'
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest'
import {userEvent} from 'vitest/browser'
import {render} from 'vitest-browser-react'
import {App} from './App'
import type {Loaded} from './lib/data'
import {at, fixture} from './test/fixture'
import {fakeEventSource, ringPoints, sendAll, zoomed} from './test/page'
import './index.css'

const GB = 1024 ** 3
const CACHES = '/Users/you/Library/Caches'

const cachesInside = {
  name: 'Caches',
  path: CACHES,
  bytes: 15 * GB,
  files: 50_000,
  mtime: 1_700_000_000,
  children: [
    {name: 'com.app.big', path: `${CACHES}/com.app.big`, bytes: 9 * GB, files: 20_000, mtime: 1_700_000_000, children: []},
    {name: 'huge.log', path: `${CACHES}/huge.log`, bytes: 4 * GB, files: 1, mtime: 1_700_000_000, children: [], file: true},
    {name: '312 smaller items', path: `${CACHES}/*`, bytes: 2 * GB, files: 29_999, mtime: 0, children: [], rest: true},
  ],
}

const pickedItem = {
  category: {id: 'picked', title: 'Picked by you', desc: 'Folders and files you selected in Storage or Insights.', risk: 'review', pre: true},
  item: {path: '/Users/you/code', label: '~/code', bytes: 15 * GB, action: 'rm', cmd_id: '-', note: 'Selected by you.', age: 3, accuracy: 'exact', preselect: true, report: false, line: 9},
}

function server(pick: {status: number; body: string}) {
  return vi.spyOn(window, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input)
    const sent = JSON.parse(String(init?.body ?? '{}'))
    if (url === '/children' && sent.path === CACHES) return new Response(JSON.stringify(cachesInside), {status: 200})
    if (url === '/children') return new Response('not found', {status: 404})
    if (url === '/pick') return new Response(pick.body, {status: pick.status})
    return new Response('{}', {status: 200})
  })
}

function streams() {
  const scan = fakeEventSource()
  const cleanup = fakeEventSource()
  const openEvents = (url: string) => (url.startsWith('/events') ? scan.source : cleanup.source)
  const loaded: Loaded = {...fixture, openEvents}
  return {scan, loaded}
}

const details = () => document.querySelector('aside')?.textContent ?? ''

describe('storage map: every folder opens, and anything in it can be cleaned', () => {
  beforeEach(() => gsap.globalTimeline.timeScale(20))
  afterEach(() => {
    gsap.globalTimeline.timeScale(1)
    vi.restoreAllMocks()
  })

  test('zooming into a folder the map only knows by its size loads what is inside, files and the remainder included, and the parts add up', async () => {
    server({status: 200, body: '{}'})
    const {loaded} = streams()
    const screen = await render(<App loaded={loaded} history={at(zoomed(CACHES))} />)
    await expect.element(screen.getByLabelText(`Storage sunburst of ${CACHES}`)).toBeVisible()
    await expect.poll(details).toContain('com.app.big')
    expect(details()).toContain('huge.log')
    expect(details()).toContain('312 smaller items')
    const posted = vi.mocked(window.fetch).mock.calls.filter(([to]) => String(to) === '/children')
    expect(posted.map(([, init]) => JSON.parse(String(init?.body)).path)).toContain(CACHES)
    expect(cachesInside.children.reduce((sum, child) => sum + child.bytes, 0)).toBe(cachesInside.bytes)
  })

  test('Select for delete lists the folder in a Picked by you section, selected, and the same button removes it', async () => {
    server({status: 200, body: JSON.stringify(pickedItem)})
    const {scan, loaded} = streams()
    const history = at('/storage')
    const screen = await render(<App loaded={loaded} history={history} />)
    const chart = screen.getByLabelText(/^Storage sunburst of /)
    await expect.element(chart).toBeVisible()
    await userEvent.click(chart, {position: ringPoints(chart.element())(0.8, 0).local})
    const pinned = screen.getByRole('dialog')
    await expect.element(pinned.getByText('~/code', {exact: true})).toBeVisible()
    await pinned.getByRole('button', {name: 'Select for delete'}).click()
    await expect.element(pinned.getByRole('button', {name: 'Adding…'})).toBeVisible()
    const sent = vi.mocked(window.fetch).mock.calls.find(([to]) => String(to) === '/pick')
    expect(JSON.parse(String(sent?.[1]?.body)).path).toBe('/Users/you/code')
    sendAll(scan.source, [{type: 'item', data: {...pickedItem, elapsed_ms: 9000}}])
    const selected = pinned.getByRole('button', {name: 'Selected · remove'})
    await expect.element(selected).toHaveAttribute('aria-pressed', 'true')
    await expect.element(screen.getByRole('contentinfo').getByText(/16 items selected|items selected · /).first()).toBeVisible()
    await selected.click()
    await expect.element(pinned.getByRole('button', {name: 'Select for delete'})).toHaveAttribute('aria-pressed', 'false')
    await pinned.getByRole('button', {name: 'Select for delete'}).click()
    await expect.element(pinned.getByRole('button', {name: 'Selected · remove'})).toBeVisible()
    expect(vi.mocked(window.fetch).mock.calls.filter(([to]) => String(to) === '/pick')).toHaveLength(1)
    await screen.getByRole('tab', {name: 'Cleanup'}).click()
    await expect.element(screen.getByText('Picked by you').first()).toBeVisible()
  })

  test('the largest files in Insights can be selected for delete too', async () => {
    server({status: 200, body: '{}'})
    const {loaded} = streams()
    const screen = await render(<App loaded={loaded} history={at('/insights')} />)
    await expect.element(screen.getByText('~/big.iso')).toBeVisible()
    await screen.getByRole('button', {name: 'Select for delete'}).click()
    await expect.poll(() => vi.mocked(window.fetch).mock.calls.filter(([to]) => String(to) === '/pick').length).toBe(1)
    const sent = vi.mocked(window.fetch).mock.calls.find(([to]) => String(to) === '/pick')
    expect(JSON.parse(String(sent?.[1]?.body)).path).toBe('/Users/you/big.iso')
  })

  test('a refused pick says why and adds nothing', async () => {
    server({status: 409, body: 'protected path'})
    const {loaded} = streams()
    const screen = await render(<App loaded={loaded} history={at('/storage')} />)
    const chart = screen.getByLabelText(/^Storage sunburst of /)
    await expect.element(chart).toBeVisible()
    await userEvent.click(chart, {position: ringPoints(chart.element())(0.8, 0).local})
    const pinned = screen.getByRole('dialog')
    await pinned.getByRole('button', {name: 'Select for delete'}).click()
    await expect.element(pinned.getByRole('button', {name: 'Not added: protected path'})).toBeVisible()
  })

  test('folders moved by a cleanup round leave the map and their parents shrink, without a rescan', async () => {
    server({status: 200, body: '{}'})
    const {scan, loaded} = streams()
    const screen = await render(<App loaded={loaded} history={at('/storage')} />)
    await expect.element(screen.getByLabelText(/^Storage sunburst of /)).toBeVisible()
    await expect.poll(details).toContain('Library25.0 GB')
    sendAll(scan.source, [{type: 'unlisted', data: {path: CACHES, elapsed_ms: 9000}}])
    await expect.poll(details).toContain('Library10.0 GB')
    expect(details()).toContain('25.0 GB')
  })
})
