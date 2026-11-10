import {gsap} from 'gsap'
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest'
import {page, userEvent} from 'vitest/browser'
import {render} from 'vitest-browser-react'
import {App} from './App'
import {at, fixture} from './test/fixture'
import {ringPoints, zoomed} from './test/page'
import './index.css'

const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches

const shownCards = () => [...document.querySelectorAll<HTMLElement>('.ts-chart-tooltip')].filter(element => !element.hidden && element.textContent)

function shownCard() {
  const [card] = shownCards()
  if (!card) throw new Error('no chart card is showing')
  return card
}

const nextFrame = () => new Promise(requestAnimationFrame)

function boxOf(element: Element) {
  const {x, y, width, height} = element.getBoundingClientRect()
  return JSON.stringify([x, y, width, height].map(Math.round))
}

async function settledBox(element: Element) {
  await expect
    .poll(async () => {
      const before = boxOf(element)
      await nextFrame()
      await nextFrame()
      const moving = element.getAnimations().some(animation => animation.playState === 'running')
      return !moving && before === boxOf(element)
    }, {timeout: 5000})
    .toBe(true)
  return boxOf(element)
}

async function openStorage(url = '/storage') {
  const history = at(url)
  const screen = await render(<App loaded={fixture} history={history} />)
  const chart = screen.getByLabelText(/^Storage sunburst of /)
  await expect.element(chart).toBeVisible()
  return {history, screen, chart, ring: ringPoints(chart.element())}
}

const svgOf = (chart: Element) => (chart instanceof SVGSVGElement ? chart : chart.querySelector('svg'))

describe('chart cards you can use', () => {
  beforeEach(() => gsap.globalTimeline.timeScale(20))
  afterEach(() => {
    gsap.globalTimeline.timeScale(1)
    vi.restoreAllMocks()
  })

  test('a hover preview is anchored to its folder: it holds still while the pointer moves inside the folder', async () => {
    const {chart, ring} = await openStorage()
    await userEvent.hover(chart, {position: ring(0.2, 0).local})
    await expect.element(page.getByRole('status').getByText('~/Library', {exact: true})).toBeVisible()
    await expect.element(page.getByRole('status').getByText(/cleanable in 4 items/)).toBeVisible()
    const card = shownCard()
    const before = await settledBox(card)
    await userEvent.hover(chart, {position: ring(0.42, 0).local})
    await expect.element(page.getByRole('status').getByText('~/Library', {exact: true})).toBeVisible()
    expect(await settledBox(card)).toEqual(before)
    expect(card.querySelector('button, a')).toBeNull()
  })

  test('a click pins the card: the pointer can reach it, it stays put, and its controls work', async () => {
    const {chart, ring, history} = await openStorage()
    await userEvent.click(chart, {position: ring(0.3125, 0).local})
    const pinned = page.getByRole('dialog')
    await expect.element(pinned.getByText(/cleanable in 4 items/)).toBeVisible()
    const card = shownCard()
    const before = await settledBox(card)
    await userEvent.hover(pinned.getByText('of the disk'))
    await userEvent.hover(chart, {position: ring(0.8, 1).local})
    await expect.element(pinned.getByText('~/Library', {exact: true})).toBeVisible()
    expect(await settledBox(card)).toEqual(before)
    await pinned.getByRole('button', {name: 'Copy path'}).click()
    await expect.element(pinned.getByRole('button', {name: /^(Copied|Couldn't copy)$/})).toBeVisible()
    await pinned.getByRole('link', {name: 'Zoom in'}).click()
    await expect.element(page.getByLabelText('Storage sunburst of /Users/you/Library')).toBeVisible()
    expect(history.location.pathname).toBe(zoomed('/Users/you/Library'))
    await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
  })

  test('Escape closes a pinned card and focus goes back to the chart', async () => {
    const {chart, ring} = await openStorage()
    await userEvent.click(chart, {position: ring(0.3125, 0).local})
    const pinned = page.getByRole('dialog')
    await expect.element(pinned).toBeVisible()
    pinned.getByRole('button', {name: 'Copy path'}).element().focus()
    await userEvent.keyboard('{Escape}')
    await expect.element(pinned).not.toBeInTheDocument()
    expect(svgOf(chart.element())?.contains(document.activeElement)).toBe(true)
  })

  test('a click outside or on the folder again closes a pinned card', async () => {
    const {chart, ring, screen} = await openStorage()
    await userEvent.click(chart, {position: ring(0.3125, 0).local})
    await expect.element(page.getByRole('dialog')).toBeVisible()
    await screen.getByText('Where your 500 GB went').click()
    await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
    await userEvent.click(chart, {position: ring(0.3125, 0).local})
    await expect.element(page.getByRole('dialog')).toBeVisible()
    await userEvent.click(chart, {position: ring(0.3125, 0).local})
    await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
  })

  test('the keyboard pins with Enter, tabs into the card, and Escape returns to the chart', async () => {
    const {chart} = await openStorage()
    const svg = svgOf(chart.element())
    if (!svg) throw new Error('the chart drew no svg')
    svg.focus()
    await userEvent.keyboard('{ArrowRight}')
    await expect.poll(() => shownCards().length).toBe(1)
    await userEvent.keyboard('{Enter}')
    const pinned = page.getByRole('dialog')
    await expect.element(pinned).toBeVisible()
    await userEvent.keyboard('{Tab}')
    expect(pinned.element().contains(document.activeElement)).toBe(true)
    await userEvent.keyboard('{Escape}')
    await expect.element(pinned).not.toBeInTheDocument()
    expect(svg.contains(document.activeElement)).toBe(true)
  })

  test('pinning a card shifts nothing on the page', async () => {
    const {chart, ring, screen} = await openStorage()
    const crumbs = screen.getByRole('navigation', {name: 'Folder path'}).element()
    const before = [await settledBox(chart.element()), await settledBox(crumbs), document.documentElement.scrollHeight]
    await userEvent.click(chart, {position: ring(0.3125, 0).local})
    await expect.element(page.getByRole('dialog')).toBeVisible()
    await settledBox(shownCard())
    expect([await settledBox(chart.element()), await settledBox(crumbs), document.documentElement.scrollHeight]).toEqual(before)
  })

  test(`the card ${REDUCED ? 'appears without animation under reduced motion' : 'animates in with motion allowed'}`, async () => {
    const {chart, ring} = await openStorage()
    await userEvent.hover(chart, {position: ring(0.3125, 0).local})
    await expect.poll(() => shownCards().length).toBe(1)
    const running = shownCard().getAnimations().length
    if (REDUCED) expect(running).toBe(0)
    else expect(running).toBeGreaterThan(0)
  })

  test('Insights cards pin the same way and open the folder in Storage or the section in Cleanup', async () => {
    const history = at('/insights')
    const screen = await render(<App loaded={fixture} history={history} />)
    const folders = screen.getByLabelText('Folder size by last-modified age')
    await expect.element(folders).toBeVisible()
    const cell = folders.element().querySelector('rect[fill]:not([fill="transparent"])')
    if (!cell) throw new Error('the folder chart drew no cells')
    await userEvent.click(page.elementLocator(cell))
    const pinned = page.getByRole('dialog')
    await expect.element(pinned.getByRole('button', {name: 'Copy path'})).toBeVisible()
    await pinned.getByRole('link', {name: 'Open in Storage'}).click()
    await expect.element(screen.getByLabelText('Storage sunburst of /Users/you/Library')).toBeVisible()

    await screen.getByRole('tab', {name: 'Insights'}).click()
    const sections = screen.getByLabelText('Cleanup sections by idle time')
    await expect.element(sections).toBeVisible()
    const busy = [...sections.element().querySelectorAll('rect[fill]')].at(-1)
    if (!busy) throw new Error('the section chart drew no cells')
    await userEvent.click(page.elementLocator(busy))
    await page.getByRole('dialog').getByRole('link', {name: 'Open in Cleanup'}).click()
    await expect.poll(() => history.location.pathname).toMatch(/^\/cleanup\//)
  })
})
