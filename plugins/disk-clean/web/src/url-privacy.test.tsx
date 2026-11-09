import type {RouterHistory} from '@tanstack/react-router'
import {gsap} from 'gsap'
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest'
import {page, userEvent} from 'vitest/browser'
import {render} from 'vitest-browser-react'
import {App} from './App'
import type {Loaded} from './lib/data'
import {foldersOf} from './lib/folders'
import {revealSearchValue, obscureSearchValue} from './lib/search'
import {at, cleanupEvents, fixture} from './test/fixture'
import {address, fakeEventSource, mockServer, query, ringPoints, sendAll, zoomed} from './test/page'
import './index.css'

type Screen = Awaited<ReturnType<typeof render>>

const LEAKS = ['/Users', 'Users/you', 'Library', 'Caches', 'node_modules', 'app-a', 'big.iso']

function leaksIn(href: string) {
  const plain = decodeURIComponent(href)
  return LEAKS.filter(name => plain.includes(name))
}

function watch(history: RouterHistory) {
  const seen = [history.location.href]
  const stop = history.subscribe(() => seen.push(history.location.href))
  return {seen, stop}
}

async function open(url: string, loaded: Loaded = fixture) {
  const history = at(url)
  const screen = await render(<App loaded={loaded} history={history} />)
  return {history, screen}
}

async function pinRing(screen: Screen, label: string, turn: number, ring: number) {
  const chart = screen.getByLabelText(label)
  await expect.element(chart).toBeVisible()
  await userEvent.click(chart, {position: ringPoints(chart.element())(turn, ring).local})
  return page.getByRole('dialog')
}

describe('search values are base64url of their JSON', () => {
  test('values round-trip through UTF-8 with no +, / or = in the address', () => {
    for (const value of ['Bigfolder', 'שלום ☃ 𝄞', ['safe', 'review'], {deep: [1, true, null]}, '~~~???>>>']) {
      const encoded = obscureSearchValue(value)
      expect(encoded).toMatch(/^[\w-]+$/)
      expect(revealSearchValue(encoded)).toEqual(value)
    }
  })

  test('an undecodable value throws, so the router keeps it raw and the validators fall back', () => {
    for (const junk of ['!!!', 'a', 'Zm9v', '%%']) expect(() => revealSearchValue(junk)).toThrow()
  })
})

describe('folder tokens', () => {
  test('every folder in the scan is one row keyed by its 8-character token, with its parent', () => {
    const folders = foldersOf(fixture.data.tree)
    expect(folders.map(({path, parent}) => [path, parent])).toEqual([
      ['/Users/you', null],
      ['/Users/you/Library', '/Users/you'],
      ['/Users/you/Library/Caches', '/Users/you/Library'],
      ['/Users/you/Library/*', '/Users/you/Library'],
      ['/Users/you/code', '/Users/you'],
    ])
    for (const {token} of folders) expect(token).toMatch(/^[0-9a-z]{8}$/)
    expect(new Set(folders.map(f => f.token)).size).toBe(folders.length)
  })
})

describe('no folder names in the address', () => {

  beforeEach(() => gsap.globalTimeline.timeScale(20))
  afterEach(() => {
    gsap.globalTimeline.timeScale(1)
    vi.restoreAllMocks()
  })

  test('walking every surface never writes a folder name or the filter text into the address', async () => {
    mockServer()
    const {history, screen} = await open('/cleanup')
    const {seen, stop} = watch(history)

    await userEvent.type(screen.getByRole('textbox', {name: 'Filter paths'}), 'Library')
    await expect.poll(() => query(history).q).toBe('Library')
    await screen.getByRole('button', {name: 'safe', exact: true}).click()
    await screen.getByRole('button', {name: 'Card view'}).click()
    await screen.getByRole('button', {name: 'List view'}).click()
    await screen.getByRole('textbox', {name: 'Filter paths'}).fill('')
    await screen.getByRole('button', {name: 'safe', exact: true}).click()
    await screen.getByRole('link', {name: /^node_modules/}).click()
    await screen.getByRole('checkbox', {name: '~/code/web/node_modules'}).click()
    await expect.poll(() => query(history).add).toBeTruthy()
    await screen.getByRole('button', {name: /^Delete \d+ items? · /}).click()
    await expect.element(screen.getByRole('dialog', {name: 'Move to the Trash'}).getByText('6 items in total')).toBeVisible()
    await userEvent.keyboard('{Escape}')
    await expect.element(screen.getByRole('dialog', {name: 'Move to the Trash'})).not.toBeInTheDocument()

    await screen.getByRole('tab', {name: 'Storage'}).click()
    const pinned = await pinRing(screen, 'Storage sunburst of /Users/you', 0.3125, 0)
    await pinned.getByRole('link', {name: 'Zoom in'}).click()
    await expect.element(screen.getByLabelText('Storage sunburst of /Users/you/Library')).toBeVisible()
    await screen.getByRole('button', {name: 'Treemap'}).click()
    await expect.element(screen.getByLabelText('Storage treemap of /Users/you/Library')).toBeVisible()
    await screen.getByRole('navigation', {name: 'Folder path'}).getByRole('link', {name: '~'}).click()
    await expect.element(screen.getByLabelText('Storage treemap of /Users/you')).toBeVisible()

    await screen.getByRole('tab', {name: 'Insights'}).click()
    await expect.element(screen.getByText('Largest files')).toBeVisible()
    await screen.getByRole('tab', {name: 'Cleanup'}).click()
    await expect.element(screen.getByRole('heading', {name: 'node_modules'})).toBeVisible()

    history.back()
    history.back()
    history.back()
    await expect.element(screen.getByLabelText(/^Storage /)).toBeVisible()
    history.forward()
    stop()

    const visited = [...seen]
    await screen.unmount()
    const again = await open(history.location.href)
    await expect.element(again.screen.getByLabelText(/^Storage /)).toBeVisible()
    visited.push(again.history.location.href)

    expect(visited.some(href => href.includes('/storage/'))).toBe(true)
    expect(visited.some(href => href.includes('q='))).toBe(true)
    expect(visited.some(href => href.includes('/confirm'))).toBe(true)
    expect(visited.filter(href => leaksIn(href).length > 0)).toEqual([])
  })

  test('the progress panel and the movie overlays keep folder names out of the address', async () => {
    const {source} = fakeEventSource()
    const loaded = {...fixture, openEvents: () => source}
    const {history, screen} = await open('/cleanup', loaded)
    const {seen, stop} = watch(history)
    sendAll(source, cleanupEvents)
    await screen.getByRole('button', {name: 'Details'}).click()
    const panel = screen.getByRole('dialog', {name: 'Cleanup progress'})
    await panel.getByRole('button', {name: 'Removed'}).click()
    await expect.poll(() => query(history).log).toBe('removed')
    await screen.getByRole('button', {name: 'Watch the movie'}).click()
    await expect.poll(() => query(history).overlay).toBe('movie')
    await userEvent.keyboard('{Escape}')
    await expect.element(screen.getByRole('dialog', {name: 'Cleanup movie'})).not.toBeInTheDocument()
    stop()
    expect(seen.some(href => href.includes('overlay='))).toBe(true)
    expect(seen.filter(href => leaksIn(href).length > 0)).toEqual([])
  })

  test('a pasted link restores the zoom, the chart shape and the selection', async () => {
    const first = await open('/cleanup')
    await first.screen.getByText('~/Library/Caches/app-a').click()
    await expect.element(first.screen.getByText('3 items selected · 1.8 GB')).toBeVisible()
    await first.screen.getByRole('tab', {name: 'Storage'}).click()
    const pinned = await pinRing(first.screen, 'Storage sunburst of /Users/you', 0.3125, 0)
    await pinned.getByRole('link', {name: 'Zoom in'}).click()
    await first.screen.getByRole('button', {name: 'Treemap'}).click()
    await expect.element(first.screen.getByLabelText('Storage treemap of /Users/you/Library')).toBeVisible()
    const link = first.history.location.href
    expect(leaksIn(link)).toEqual([])
    await first.screen.unmount()

    const pasted = await open(link)
    await expect.element(pasted.screen.getByLabelText('Storage treemap of /Users/you/Library')).toBeVisible()
    await expect.element(pasted.screen.getByText('3 items selected · 1.8 GB')).toBeVisible()
    expect(pasted.history.location.href).toBe(link)
  })

  test('the filter box, a section and the confirm dialog come back from a pasted link', async () => {
    mockServer()
    const link = address('/cleanup/caches/confirm', {q: 'Library', sort: 'name-asc'})
    expect(leaksIn(link)).toEqual([])
    const {history, screen} = await open(link)
    await expect.element(screen.getByRole('dialog', {name: 'Move to the Trash'}).getByText('6 items in total')).toBeVisible()
    await userEvent.keyboard('{Escape}')
    await expect.element(screen.getByRole('dialog', {name: 'Move to the Trash'})).not.toBeInTheDocument()
    await expect.element(screen.getByRole('textbox', {name: 'Filter paths'})).toHaveValue('Library')
    expect(history.location.pathname).toBe('/cleanup/caches')
    expect(query(history)).toEqual({q: 'Library', sort: 'name-asc'})
  })
})

describe('old plain addresses', () => {
  afterEach(() => vi.restoreAllMocks())

  test('plain search values are read, then rewritten encoded', async () => {
    const errors = vi.spyOn(console, 'error')
    const {history, screen} = await open('/cleanup/caches?q=Library&view=cards&sort=name-asc')
    await expect.element(screen.getByRole('textbox', {name: 'Filter paths'})).toHaveValue('Library')
    await expect.element(screen.getByRole('button', {name: 'Card view'})).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(() => history.location.search).not.toContain('Library')
    expect(query(history)).toEqual({q: 'Library', view: 'cards', sort: 'name-asc'})
    expect(history.location.search).toMatch(/^\?(\w+=[\w-]+&?)+$/)
    expect(errors).not.toHaveBeenCalled()
  })

  test('an old folder path under /storage opens the storage map at the top, without crashing', async () => {
    const errors = vi.spyOn(console, 'error')
    for (const url of ['/storage/Users', '/storage/Users/you/Library?shape=treemap']) {
      const {history, screen} = await open(url)
      await expect.element(screen.getByLabelText(/^Storage (sunburst|treemap) of \/Users\/you$/)).toBeVisible()
      await expect.poll(() => leaksIn(history.location.href)).toEqual([])
      await screen.unmount()
    }
    expect(errors).not.toHaveBeenCalled()
  })

  test('a zoom token deep link opens its folder', async () => {
    const {history, screen} = await open(zoomed('/Users/you/Library'))
    await expect.element(screen.getByLabelText('Storage sunburst of /Users/you/Library')).toBeVisible()
    expect(history.location.pathname).toBe(zoomed('/Users/you/Library'))
  })
})
