import {gsap} from 'gsap'
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest'
import {userEvent} from 'vitest/browser'
import {render} from 'vitest-browser-react'
import {App} from './App'
import {approvedEvent, category, cleanupEvents, fixture, trashedEvents, item, at, withSection} from './test/fixture'
import {fakeEventSource, mockServer, PLAN, sendAll} from './test/page'
import './index.css'

const GB = 1024 ** 3
type Screen = Awaited<ReturnType<typeof render>>

const footer = (screen: Screen) => screen.getByRole('contentinfo')
const header = (screen: Screen) => screen.container.querySelector('header p')

beforeEach(() => gsap.globalTimeline.timeScale(20))
afterEach(() => {
  gsap.globalTimeline.timeScale(1)
  vi.restoreAllMocks()
})

async function approved(events: readonly {type: string; data: object}[]) {
  mockServer()
  const {source} = fakeEventSource()
  const paths = ['/Users/you/Library/Caches/app-a', '/Users/you/Library/Caches/app-b', '/Users/you/Library/Caches/app-c', '/Users/you/Library/Caches/app-d']
  const screen = await render(<App loaded={{...fixture, openEvents: () => source}} history={at()} />)
  await sendAll(source, [approvedEvent(paths), ...events.filter(event => event.type !== 'approved')])
  return {screen, source}
}

describe('words and small UI', () => {
  test('an undo refused as busy says why and offers no Retry that cannot work', async () => {
    const {screen} = await approved(trashedEvents)
    vi.mocked(window.fetch).mockImplementation(async () => new Response('busy', {status: 409}))
    await footer(screen).getByRole('button', {name: 'Undo'}).click()
    await expect.element(footer(screen).getByText('Undo did not go through: Another cleanup, undo or empty is running; try again when it finishes')).toBeVisible()
    await expect.element(footer(screen).getByRole('button', {name: 'Retry'})).not.toBeInTheDocument()
  })

  test('what was not done shows its reason on the main page, failures in red as not removed', async () => {
    const {screen} = await approved(cleanupEvents)
    const notDone = footer(screen).getByRole('list', {name: 'Not done'})
    await expect.element(notDone.getByText(/Not removed .*app-d: still present after removal: permission denied/)).toBeVisible()
    await expect.element(notDone.getByText(/Kept .*wt: 1 uncommitted or untracked files/)).toBeVisible()
    expect(getComputedStyle(notDone.getByText(/Not removed/).element()).color).not.toBe(getComputedStyle(document.body).color)
  })

  test('the free-space change of other apps never sits beside the freed figure', async () => {
    const {screen} = await approved(cleanupEvents)
    await expect.poll(() => header(screen)?.textContent).toContain('Freed 3.5 GB')
    expect(footer(screen).element().textContent).not.toMatch(/free space changed/i)
  })

  test('a shortcut pressed right after a listbox opens does nothing', async () => {
    const screen = await render(<App loaded={fixture} history={at()} />)
    await expect.element(footer(screen).getByText('4 items selected · 3.8 GB')).toBeVisible()
    await screen.getByRole('combobox', {name: 'Sort'}).click()
    document.body.dispatchEvent(new KeyboardEvent('keydown', {key: 'd', bubbles: true}))
    await userEvent.keyboard('{Escape}')
    await expect.element(footer(screen).getByText('4 items selected · 3.8 GB')).toBeVisible()
  })

  test('item counts carry thousands separators', async () => {
    const big = category('temp', 'Your macOS temp', 'safe', Array.from({length: 1234}, (_, i) => item(`/Users/you/tmp/f-${i}`, 4096)))
    const screen = await render(<App loaded={withSection(big)} history={at('/cleanup/temp')} />)
    await expect.element(footer(screen).getByText(/^1,238 items selected/)).toBeVisible()
    await expect.element(screen.getByText(/1,234 of 1,234 shown/)).toBeVisible()
    await expect.element(screen.getByRole('button', {name: /^all 1,234$/})).toBeVisible()
  })

  test('estimated items show their approximate size on the Delete button and footer', async () => {
    const screen = await render(<App loaded={fixture} history={at('/cleanup/docker')} />)
    await footer(screen).getByRole('button', {name: 'Clear selection', exact: true}).click()
    await screen.getByRole('checkbox', {name: 'docker system prune -f'}).click()
    await expect.element(footer(screen).getByText('1 item selected · ≈5.0 GB')).toBeVisible()
    await expect.element(footer(screen).getByRole('button', {name: 'Delete 1 item · ≈5.0 GB'})).toBeVisible()
  })

  test('the confirm dialog explains a smaller count than the footer by the rejections', async () => {
    mockServer({...PLAN, count: 3, rejected: [{reason: 'already gone', path: '/Users/you/Library/Caches/app-d'}]})
    const screen = await render(<App loaded={fixture} history={at('/cleanup/caches/confirm')} />)
    await expect.element(screen.getByRole('dialog').getByText('You selected 4 items; 1 rejected by the safety checks, see below, so 3 items run.')).toBeVisible()
  })
})

describe('the scan status shows one state', () => {
  test('a finished scan shows only Scan complete', async () => {
    const {source} = fakeEventSource()
    const screen = await render(<App loaded={{...fixture, live: true, openEvents: () => source}} history={at()} />)
    await sendAll(source, [{type: 'done', data: {reclaimable: GB, elapsed_ms: 70_000}}])
    await expect.element(screen.getByText('Scan complete')).toBeVisible()
    const status = screen.getByRole('status').filter({hasText: 'Scan complete'})
    expect(status.element().textContent).not.toMatch(/Scan failed|Walking disk|Checking/)
    expect(status.element().textContent).toMatch(/1 minute /)
  })
})
