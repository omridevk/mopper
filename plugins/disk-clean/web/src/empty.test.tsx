import {afterEach, describe, expect, test, vi} from 'vitest'
import {page, userEvent} from 'vitest/browser'
import {render} from 'vitest-browser-react'
import {App} from './App'
import {NO_DATA, type Item, type Loaded} from './lib/data'
import type {CategoryHead, ScanEvent} from './lib/scan-feed'
import {at, fixture, item} from './test/fixture'
import {fakeEventSource, mockServer} from './test/page'
import './index.css'

type Screen = Awaited<ReturnType<typeof render>>

const GB = 1024 ** 3
const LIVE: Loaded = {data: NO_DATA, token: 'test-token', home: '/Users/you', live: true}
const CACHES: CategoryHead = {id: 'caches', title: 'Application caches', desc: 'caches', risk: 'safe'}
const DOCKER: CategoryHead = {id: 'docker', title: 'Docker', desc: 'docker', risk: 'review'}
const cacheB = item('/Users/you/Library/Caches/app-b', GB, {preselect: false, line: 1})
const docker = item('cmd:docker-prune', 0, {action: 'cmd', cmd_id: 'docker-prune', label: 'docker system prune -f', accuracy: 'vm', preselect: false, age: null})

const SCANNING = "Scanning… items appear here as they're found."
const MESSAGES = [SCANNING, 'Nothing is selected.', 'Nothing matches these filters.', 'Nothing in this section matches these filters.', 'Nothing to clean up.']
const SHOTS = import.meta.env.VITE_EMPTY_SHOTS === '1'

function listed(category: CategoryHead, entry: Item, elapsed_ms = 100): ScanEvent {
  return {type: 'item', data: {category, item: entry, elapsed_ms}}
}

async function live(url: string) {
  const {source, send} = fakeEventSource()
  const history = at(url)
  const screen = await render(<App loaded={{...LIVE, openEvents: () => source}} history={history} />)
  send({type: 'disk', data: {total: 500 * GB, used: 400 * GB, free: 50 * GB, snapshots: 0, elapsed_ms: 10}})
  return {screen, send, history}
}

async function onlyMessage(screen: Screen, message: string) {
  await expect.element(screen.getByText(message, {exact: true})).toBeVisible()
  for (const other of MESSAGES.filter(m => m !== message)) expect(screen.getByText(other, {exact: true}).elements()).toHaveLength(0)
}

async function shot(name: string) {
  if (!SHOTS) return
  await new Promise(resolve => setTimeout(resolve, 400))
  await page.screenshot({path: `../node_modules/.empty-shots/${name}-${navigator.userAgent.includes('Firefox') ? 'firefox' : 'chromium'}.png`})
}

const emptyFrames = () => document.querySelectorAll('[class*="h-[32rem]"]').length

describe('one truthful empty state', () => {
  afterEach(() => vi.restoreAllMocks())

  test('mid-scan with nothing found yet, the scanning message is the only one', async () => {
    const {screen} = await live('/cleanup')
    await onlyMessage(screen, SCANNING)
    await shot('1-scanning')
  })

  test('mid-scan on a section that has no items yet, with only selected on and nothing selected, says scanning; once it arrives it says nothing is selected and Show all items works', async () => {
    const {screen, send, history} = await live('/cleanup/docker?only=true')
    send(listed(CACHES, cacheB))
    await onlyMessage(screen, SCANNING)
    send(listed(DOCKER, docker, 200))
    await onlyMessage(screen, 'Nothing is selected.')
    await shot('2-nothing-selected')
    await screen.getByRole('button', {name: 'Show all items'}).click()
    await expect.element(screen.getByRole('heading', {name: 'Docker'})).toBeVisible()
    await expect.element(screen.getByText('docker system prune -f')).toBeVisible()
    expect(history.location.search).not.toContain('only')
    for (const message of MESSAGES) expect(screen.getByText(message, {exact: true}).elements()).toHaveLength(0)
  })

  test('in cards view mid-scan, a section with no items yet shows one scanning message and no empty frame', async () => {
    const {screen, send} = await live('/cleanup/docker?view=cards')
    send(listed(CACHES, cacheB))
    await expect.element(screen.getByText('Application caches')).toBeVisible()
    await onlyMessage(screen, SCANNING)
    expect(emptyFrames()).toBe(0)
    await shot('5-cards-mid-scan')
    send(listed(DOCKER, docker, 200))
    await expect.element(screen.getByText('docker system prune -f')).toBeVisible()
    expect(emptyFrames()).toBe(1)
    for (const message of MESSAGES) expect(screen.getByText(message, {exact: true}).elements()).toHaveLength(0)
  })

  test('after the scan, only selected with an empty selection says nothing is selected and Show all items keeps the selection empty', async () => {
    const screen = await render(<App loaded={fixture} history={at('/cleanup/caches?only=true')} />)
    await screen.getByRole('button', {name: 'Clear selection'}).click()
    await onlyMessage(screen, 'Nothing is selected.')
    await screen.getByRole('button', {name: 'Show all items'}).click()
    await expect.element(screen.getByText('~/Library/Caches/app-a')).toBeVisible()
    await expect.element(screen.getByText('0 items selected · 0 B')).toBeVisible()
  })

  test('filters that hide everything say so, and Clear filters shows the items again and keeps the selection', async () => {
    const screen = await render(<App loaded={fixture} history={at('/cleanup/caches')} />)
    await screen.getByRole('textbox', {name: 'Filter paths'}).fill('no such path')
    await onlyMessage(screen, 'Nothing matches these filters.')
    await shot('3-filters')
    await screen.getByRole('button', {name: 'Clear filters'}).click()
    await expect.element(screen.getByText('~/Library/Caches/app-a')).toBeVisible()
    await expect.element(screen.getByText('4 items selected · 3.8 GB')).toBeVisible()
    for (const message of MESSAGES) expect(screen.getByText(message, {exact: true}).elements()).toHaveLength(0)
  })

  test('a finished scan that found nothing says nothing to clean up, with no action', async () => {
    const screen = await render(<App loaded={{...fixture, data: {...fixture.data, categories: []}}} history={at()} />)
    await onlyMessage(screen, 'Nothing to clean up.')
    expect(screen.getByRole('button', {name: /Clear filters|Show all items/}).elements()).toHaveLength(0)
    await shot('4-nothing')
  })
})

async function settledBoxes(screen: Screen) {
  await settled()
  return boxes(screen)
}

function boxes(screen: Screen) {
  const toolbar = screen.getByRole('textbox', {name: 'Filter paths'}).element().closest('.border-b')
  const parts = [toolbar, screen.getByRole('navigation', {name: 'Sections'}).element(), screen.getByRole('main').element(), screen.getByRole('contentinfo').element()]
  return parts.map(part => {
    if (!part) throw new Error('missing layout part')
    const {x, y, width, height} = part.getBoundingClientRect()
    return {x, y, width, height}
  })
}

describe('selection warnings never move the page', () => {
  afterEach(() => vi.restoreAllMocks())

  test('selecting a review item, hiding selected items with a filter, and clearing both leave the toolbar, list and bar where they were', async () => {
    mockServer()
    const screen = await render(<App loaded={fixture} history={at('/cleanup/docker')} />)
    await expect.element(screen.getByText('docker system prune -f')).toBeVisible()
    const before = await settledBoxes(screen)
    await shot('6-before-select')
    await screen.getByText('docker system prune -f').click()
    const chip = screen.getByRole('contentinfo').getByRole('button', {name: '1 review item'})
    await expect.element(chip).toBeVisible()
    expect(await settledBoxes(screen)).toEqual(before)
    await shot('7-after-select')
    await chip.click()
    await expect.element(screen.getByText('1 item marked review selected: slow or costly to rebuild.')).toBeVisible()
    await userEvent.keyboard('{Escape}')
    await expect.element(screen.getByText('1 item marked review selected: slow or costly to rebuild.')).not.toBeInTheDocument()

    await screen.getByRole('link', {name: /Application caches/}).click()
    await screen.getByRole('textbox', {name: 'Filter paths'}).fill('app-a')
    await expect.element(screen.getByRole('contentinfo').getByRole('button', {name: '1 review item · 4 hidden'})).toBeVisible()
    expect(await settledBoxes(screen)).toEqual(before)

    await screen.getByRole('contentinfo').getByRole('button', {name: /Delete 5 items/}).click()
    const dialog = screen.getByRole('dialog', {name: 'Move to the Trash'})
    await expect.element(dialog.getByText(/4 selected items are hidden by the filters/)).toBeVisible()
    await expect.element(dialog.getByText('1 item marked review selected: slow or costly to rebuild.')).toBeVisible()
    await dialog.getByRole('button', {name: 'Cancel'}).click()
    await expect.element(dialog).not.toBeInTheDocument()

    await screen.getByRole('textbox', {name: 'Filter paths'}).fill('')
    await screen.getByRole('button', {name: 'Clear selection'}).click()
    await expect.element(screen.getByRole('contentinfo').getByRole('button', {name: /review item|hidden/})).not.toBeInTheDocument()
    expect(await settledBoxes(screen)).toEqual(before)
  })
})

const WIDTHS = [1024, 1280, 1440]

async function settled() {
  const finite = document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity)
  await Promise.all(finite.map(animation => animation.finished.catch(() => undefined)))
}

function contentOf(message: Element) {
  const parts = [...(message.parentElement?.children ?? [])].map(child => child.getBoundingClientRect())
  const left = Math.min(...parts.map(r => r.left))
  const right = Math.max(...parts.map(r => r.right))
  const top = Math.min(...parts.map(r => r.top))
  const bottom = Math.max(...parts.map(r => r.bottom))
  return {left, right, top, bottom}
}

function visibleBox(area: Element) {
  const box = area.getBoundingClientRect()
  const footer = document.querySelector('footer')?.getBoundingClientRect().top ?? innerHeight
  return {left: Math.max(0, box.left), right: Math.min(innerWidth, box.right), top: Math.max(0, box.top), bottom: Math.min(innerHeight, footer, box.bottom)}
}

async function expectCentred(screen: Screen, message: string, area: () => Element | null | undefined, vertical = true) {
  await expect.element(screen.getByText(message, {exact: true})).toBeVisible()
  await settled()
  const region = area()
  if (!region) throw new Error('no content area')
  const content = contentOf(screen.getByText(message, {exact: true}).element())
  const visible = visibleBox(region)
  expect(content.left).toBeGreaterThanOrEqual(visible.left)
  expect(content.right).toBeLessThanOrEqual(visible.right)
  expect(content.top).toBeGreaterThanOrEqual(visible.top)
  expect(content.bottom).toBeLessThanOrEqual(visible.bottom)
  expect(Math.abs((content.left + content.right) / 2 - (visible.left + visible.right) / 2)).toBeLessThan(4)
  if (vertical) expect(Math.abs((content.top + content.bottom) / 2 - (visible.top + visible.bottom) / 2)).toBeLessThan(4)
}

const belowToolbar = (screen: Screen) => () => screen.getByRole('textbox', {name: 'Filter paths'}).element().closest('.border-b')?.nextElementSibling
const besideSections = (screen: Screen) => () => screen.getByRole('navigation', {name: 'Sections'}).element().nextElementSibling

describe('the empty state sits in the middle of the content area', () => {
  afterEach(async () => {
    vi.restoreAllMocks()
    await page.viewport(1440, 960)
  })

  for (const width of WIDTHS) {
    test(`at ${width} px, in list and cards view, the filters message is centred and fully visible`, async () => {
      await page.viewport(width, 960)
      for (const view of ['list', 'cards']) {
        const screen = await render(<App loaded={fixture} history={at(`/cleanup/caches?q=nosuchpath&view=${view}`)} />)
        await expectCentred(screen, 'Nothing matches these filters.', belowToolbar(screen))
        await shot(`8-centred-${view}-${width}`)
        await screen.unmount()
      }
    })

    test(`at ${width} px mid-scan, a section with no items yet is centred beside the sections, and below the cards in cards view`, async () => {
      await page.viewport(width, 960)
      const list = await live('/cleanup/docker')
      list.send(listed(CACHES, cacheB))
      await expect.element(list.screen.getByRole('navigation', {name: 'Sections'})).toBeVisible()
      await expectCentred(list.screen, SCANNING, besideSections(list.screen))
      await list.screen.unmount()
      const cards = await live('/cleanup/docker?view=cards')
      cards.send(listed(CACHES, cacheB))
      await expect.element(cards.screen.getByText('Application caches')).toBeVisible()
      await expectCentred(cards.screen, SCANNING, () => belowToolbar(cards.screen)()?.firstElementChild, false)
      await shot(`9-cards-scanning-${width}`)
    })
  }
})

const tooltipText = () => document.querySelector('[data-slot="tooltip-content"][data-open]')?.textContent ?? ''

describe('the action bar and toolbar fit on one line at every width', () => {
  afterEach(async () => {
    vi.restoreAllMocks()
    await page.viewport(1440, 960)
  })

  for (const width of WIDTHS) {
    test(`at ${width} px the toolbar is one row, the help line is whole, and the icon tools explain themselves`, async () => {
      await page.viewport(width, 960)
      const screen = await render(<App loaded={fixture} history={at('/cleanup/docker')} />)
      await expect.element(screen.getByText('docker system prune -f')).toBeVisible()
      const bar = screen.getByRole('contentinfo').element().getBoundingClientRect().height
      await screen.getByText('docker system prune -f').click()
      await expect.element(screen.getByRole('contentinfo').getByRole('button', {name: '1 review item'})).toBeVisible()
      await settled()

      const toolbar = screen.getByRole('textbox', {name: 'Filter paths'}).element().closest('.border-b')
      if (!(toolbar instanceof HTMLElement)) throw new Error('no toolbar')
      const search = screen.getByRole('textbox', {name: 'Filter paths'}).element().getBoundingClientRect()
      const cards = screen.getByRole('button', {name: 'Card view'}).element().getBoundingClientRect()
      expect(Math.abs(cards.top + cards.height / 2 - (search.top + search.height / 2))).toBeLessThan(2)
      expect(toolbar.scrollWidth).toBeLessThanOrEqual(toolbar.clientWidth)

      const help = screen.getByText('Delete moves files to the Trash, so you can undo').element()
      if (!(help instanceof HTMLElement)) throw new Error('no help line')
      expect(help.scrollWidth).toBeLessThanOrEqual(help.clientWidth)
      expect(help.getBoundingClientRect().right).toBeLessThanOrEqual(screen.getByRole('button', {name: 'Delete immediately…'}).element().getBoundingClientRect().left)
      expect(screen.getByRole('contentinfo').element().getBoundingClientRect().height).toBe(bar)
      await shot(`10-action-bar-${width}`)

      await screen.getByRole('button', {name: 'Clear selection'}).hover()
      await expect.poll(tooltipText).toBe('Clear selectionD')
      await settled()
      await shot(`11-clear-tooltip-${width}`)
      await screen.getByRole('contentinfo').getByRole('button', {name: '1 review item'}).hover()
      await expect.poll(tooltipText).toBe('Review items are slow or costly to rebuild · click for details')

      await screen.getByRole('button', {name: 'About deleting'}).click()
      await expect.element(screen.getByText("Delete immediately skips the Trash and can't be undone. Worktrees and commands can't be undone either.")).toBeVisible()
    })
  }
})
