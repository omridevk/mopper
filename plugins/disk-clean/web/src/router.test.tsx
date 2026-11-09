import type {RouterHistory} from '@tanstack/react-router'
import {gsap} from 'gsap'
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest'
import {page, userEvent} from 'vitest/browser'
import {render} from 'vitest-browser-react'
import {App} from './App'
import {NO_DATA, type Loaded} from './lib/data'
import {fullToken, NO_PICKS, picksOf, rowSelectionOf} from './lib/selection'
import {approvedEvent, at, cleanupEvents, fixture, trashedEvents} from './test/fixture'
import {PLAN} from './test/page'
import {address, fakeEventSource, mockServer, query, ringPoints, sendAll, zoomed} from './test/page'
import './index.css'

type Screen = Awaited<ReturnType<typeof render>>

const details = (screen: Screen) => screen.getByRole('button', {name: 'Details'})

describe('the URL', () => {
  const APPROVED = ['/Users/you/Library/Caches/app-a', '/Users/you/code/web/node_modules']

  beforeEach(() => gsap.globalTimeline.timeScale(20))
  afterEach(() => {
    gsap.globalTimeline.timeScale(1)
    vi.restoreAllMocks()
  })

  const where = (history: RouterHistory) => history.location.pathname
  const planned = () => mockServer()

  async function open(url: string, loaded: Loaded = fixture) {
    const history = at(url)
    const screen = await render(<App loaded={loaded} history={history} />)
    return {history, screen}
  }

  async function reload(screen: Screen, history: RouterHistory, loaded: Loaded = fixture) {
    await screen.unmount()
    return open(history.location.href, loaded)
  }

  const ROUTES: [string, (screen: Screen) => Promise<void>][] = [
    ['/', screen => expect.element(screen.getByRole('heading', {name: 'Application caches'})).toBeVisible()],
    ['/cleanup/node', screen => expect.element(screen.getByRole('heading', {name: 'node_modules'})).toBeVisible()],
    [address('/cleanup', {view: 'cards'}), screen => expect.element(screen.getByRole('button', {name: 'Card view'})).toHaveAttribute('aria-pressed', 'true')],
    [address(zoomed('/Users/you/Library'), {shape: 'treemap'}), screen => expect.element(screen.getByLabelText('Storage treemap of /Users/you/Library')).toBeVisible()],
    ['/insights', screen => expect.element(screen.getByText('Largest files')).toBeVisible()],
    ['/nowhere', screen => expect.element(screen.getByText('There is no page at this address.')).toBeVisible()],
  ]

  test('every route renders from a cold deep link and again after a reload', async () => {
    for (const [url, shows] of ROUTES) {
      const first = await open(url)
      await shows(first.screen)
      const again = await reload(first.screen, first.history)
      await shows(again.screen)
      await again.screen.unmount()
    }
    const {history, screen} = await open('/')
    await expect.poll(() => where(history)).toBe('/cleanup/caches')
    await screen.unmount()
  })

  test('back and forward walk through tabs, sections, zoom and the confirm modal', async () => {
    planned()
    const {history, screen} = await open('/cleanup')
    await screen.getByRole('link', {name: /^node_modules/}).click()
    await expect.element(screen.getByRole('heading', {name: 'node_modules'})).toBeVisible()
    expect(where(history)).toBe('/cleanup/node')
    await screen.getByRole('tab', {name: 'Storage'}).click()
    const home = screen.getByLabelText('Storage sunburst of /Users/you')
    await expect.element(home).toBeVisible()
    await userEvent.click(home, {position: ringPoints(home.element())(0.3125, 0).local})
    await page.getByRole('dialog').getByRole('link', {name: 'Zoom in'}).click()
    await expect.element(screen.getByLabelText('Storage sunburst of /Users/you/Library')).toBeVisible()
    expect(where(history)).toBe(zoomed('/Users/you/Library'))

    history.back()
    await expect.element(home).toBeVisible()
    history.back()
    await expect.element(screen.getByRole('heading', {name: 'node_modules'})).toBeVisible()
    await expect.element(screen.getByRole('tab', {name: 'Cleanup'})).toHaveAttribute('aria-selected', 'true')
    history.back()
    await expect.element(screen.getByRole('heading', {name: 'Application caches'})).toBeVisible()
    history.forward()
    await expect.element(screen.getByRole('heading', {name: 'node_modules'})).toBeVisible()

    await screen.getByRole('button', {name: /^Delete \d+ items? · /}).click()
    const dialog = screen.getByRole('dialog')
    await expect.element(dialog.getByText('6 items in total')).toBeVisible()
    expect(where(history)).toBe('/cleanup/node/confirm')
    history.back()
    await expect.element(dialog).not.toBeInTheDocument()
    expect(where(history)).toBe('/cleanup/node')
    history.forward()
    await expect.element(dialog.getByText('6 items in total')).toBeVisible()
  })

  test('filters round-trip through the URL: typing replaces the entry, toggles push one', async () => {
    const {history, screen} = await open('/cleanup')
    const entries = history.length
    await userEvent.type(screen.getByRole('textbox', {name: 'Filter paths'}), 'app')
    await expect.poll(() => query(history).q).toBe('app')
    expect(history.length).toBe(entries)
    await screen.getByRole('button', {name: 'safe', exact: true}).click()
    await expect.poll(() => query(history).risk).toEqual(['safe'])
    expect(history.length).toBe(entries + 1)
    await screen.getByRole('combobox', {name: 'Sort'}).click()
    await screen.getByRole('option', {name: 'Name'}).click()
    await expect.poll(() => query(history).sort).toBe('name-asc')
    await screen.getByRole('button', {name: 'Only selected'}).click()
    await expect.poll(() => query(history).only).toBe(true)
    await screen.getByRole('button', {name: 'Card view'}).click()
    await expect.poll(() => query(history).view).toBe('cards')

    history.back()
    await expect.element(screen.getByRole('button', {name: 'List view'})).toHaveAttribute('aria-pressed', 'true')
    history.forward()
    await expect.element(screen.getByRole('button', {name: 'Card view'})).toHaveAttribute('aria-pressed', 'true')

    const again = await reload(screen, history)
    await expect.element(again.screen.getByRole('textbox', {name: 'Filter paths'})).toHaveValue('app')
    await expect.element(again.screen.getByRole('button', {name: 'safe', exact: true})).toHaveAttribute('aria-pressed', 'true')
    await expect.element(again.screen.getByRole('combobox', {name: 'Sort'})).toMatchTextContent(/Name/)
    await expect.element(again.screen.getByRole('button', {name: 'Only selected'})).toHaveAttribute('aria-pressed', 'true')
    await expect.element(again.screen.getByRole('button', {name: 'Card view'})).toHaveAttribute('aria-pressed', 'true')
    await again.screen.getByRole('button', {name: 'Only selected'}).click()
    await expect.poll(() => query(again.history)).toEqual({q: 'app', risk: ['safe'], sort: 'name-asc', view: 'cards'})
  })

  test('invalid search values fall back to the defaults without errors', async () => {
    const errors = vi.spyOn(console, 'error')
    const bad = {view: 'grid', q: [1], risk: ['nope', 'safe'], minSize: 5, minAge: 7, sort: 'bogus', only: 'yes', overlay: 'nope', log: 'bad', take: -3}
    const {screen} = await open(address('/cleanup', bad))
    await expect.element(screen.getByRole('button', {name: 'List view'})).toHaveAttribute('aria-pressed', 'true')
    await expect.element(screen.getByRole('textbox', {name: 'Filter paths'})).toHaveValue('')
    await expect.element(screen.getByRole('button', {name: 'safe', exact: true})).toHaveAttribute('aria-pressed', 'true')
    await expect.element(screen.getByRole('button', {name: 'review', exact: true})).toHaveAttribute('aria-pressed', 'false')
    await expect.element(screen.getByRole('combobox', {name: 'Minimum size'})).toMatchTextContent(/Any size/)
    await expect.element(screen.getByRole('combobox', {name: 'Minimum idle time'})).toMatchTextContent(/Any age/)
    await expect.element(screen.getByRole('combobox', {name: 'Sort'})).toMatchTextContent(/Largest first/)
    await expect.element(screen.getByRole('button', {name: 'Only selected'})).toHaveAttribute('aria-pressed', 'false')
    await expect.element(screen.getByRole('dialog')).not.toBeInTheDocument()
    await screen.unmount()
    const storage = await open(address('/storage/zzzzzzzz', {shape: 'pie'}))
    await expect.element(storage.screen.getByLabelText('Storage sunburst of /Users/you')).toBeVisible()
    expect(errors).not.toHaveBeenCalled()
  })

  test('the confirm modal opens from the URL and Escape goes back to the list it came from', async () => {
    planned()
    const cold = await open(address('/cleanup/caches/confirm', {q: 'you'}))
    const dialog = cold.screen.getByRole('dialog')
    await expect.element(dialog.getByText('6 items in total')).toBeVisible()
    expect(window.fetch).toHaveBeenCalledWith('/preview', expect.objectContaining({method: 'POST'}))
    await userEvent.keyboard('{Escape}')
    await expect.element(dialog).not.toBeInTheDocument()
    expect(cold.history.location.href).toBe(address('/cleanup/caches', {q: 'you'}))

    await cold.screen.getByRole('link', {name: /^node_modules/}).click()
    await cold.screen.getByRole('button', {name: /^Delete \d+ items? · /}).click()
    await expect.element(dialog.getByText('6 items in total')).toBeVisible()
    expect(cold.history.location.href).toBe(address('/cleanup/node/confirm', {q: 'you'}))
    await userEvent.keyboard('{Escape}')
    await expect.element(dialog).not.toBeInTheDocument()
    expect(cold.history.location.href).toBe(address('/cleanup/node', {q: 'you'}))
  })

  test('the Empty confirm has its own URL over a Trash run: Escape goes back, forward and a reload reopen it', async () => {
    mockServer()
    const {source} = fakeEventSource()
    const loaded = {...fixture, openEvents: () => source}
    const {history, screen} = await open(address('/cleanup', {q: 'you'}), loaded)
    sendAll(source, [approvedEvent(APPROVED), ...trashedEvents])
    await screen.getByRole('contentinfo').getByRole('button', {name: 'Empty these from Trash'}).click()
    const dialog = screen.getByRole('dialog', {name: 'Empty these from the Trash?'})
    await expect.element(dialog).toBeVisible()
    expect(history.location.href).toBe(address('/cleanup/caches/empty', {q: 'you'}))
    await userEvent.keyboard('{Escape}')
    await expect.element(dialog).not.toBeInTheDocument()
    expect(history.location.href).toBe(address('/cleanup/caches', {q: 'you'}))
    history.forward()
    await expect.element(dialog).toBeVisible()

    const again = await reload(screen, history, loaded)
    sendAll(source, [approvedEvent(APPROVED), ...trashedEvents, {type: 'replayed', data: {}}])
    await expect.element(again.screen.getByRole('dialog', {name: 'Empty these from the Trash?'})).toBeVisible()
    expect(again.history.location.href).toBe(address('/cleanup/caches/empty', {q: 'you'}))
    await again.screen.unmount()
    const refused = await open(address('/cleanup/caches/empty', {q: 'you'}))
    await expect.poll(() => refused.history.location.href).toBe(address('/cleanup/caches', {q: 'you'}))
  })

  test('the progress panel and the movie open from the URL, and Escape returns to the previous URL', async () => {
    const {source} = fakeEventSource()
    const loaded = {...fixture, openEvents: () => source}
    const {history, screen} = await open(address('/cleanup', {overlay: 'progress', log: 'problems'}), loaded)
    sendAll(source, cleanupEvents)
    const panel = screen.getByRole('dialog', {name: 'Cleanup progress'})
    await expect.element(panel.getByRole('button', {name: 'Problems'})).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(() => panel.getByRole('listitem').elements().length).toBe(2)
    const entries = history.length
    await panel.getByRole('button', {name: 'Removed'}).click()
    await expect.poll(() => query(history).log).toBe('removed')
    expect(history.length).toBe(entries)
    await userEvent.keyboard('{Escape}')
    await expect.element(panel).not.toBeInTheDocument()
    expect(history.location.href).toBe('/cleanup/caches')

    await details(screen).click()
    await expect.poll(() => query(history).overlay).toBe('progress')
    await screen.getByRole('button', {name: 'Watch the movie'}).click()
    await expect.poll(() => query(history).overlay).toBe('movie')
    const movie = screen.getByRole('dialog', {name: 'Cleanup movie'})
    await expect.element(movie).toBeInTheDocument()
    await expect.poll(() => document.querySelector('[data-film]')?.closest('[data-settled]'), {timeout: 10_000}).not.toBeNull()
    await movie.getByRole('button', {name: 'Replay'}).click()
    await expect.poll(() => query(history).take).toBe(1)
    await userEvent.keyboard('{Escape}')
    await expect.element(movie).not.toBeInTheDocument()
    expect(history.location.href).toBe('/cleanup/caches')
    await expect.element(details(screen)).toHaveFocus()
    history.forward()
    await expect.element(movie).toBeInTheDocument()

    const again = await reload(screen, history, loaded)
    sendAll(source, [...cleanupEvents, {type: 'replayed', data: {}}])
    const reopened = again.screen.getByRole('dialog', {name: 'Cleanup movie'})
    await expect.element(reopened).toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    await expect.element(reopened).not.toBeInTheDocument()
    expect(again.history.location.href).toBe('/cleanup/caches')
  })

  test('an unknown section is not found, inside the Cleanup tab', async () => {
    const {screen} = await open('/cleanup/nope')
    await expect.element(screen.getByText('There is no section called “nope” in this scan.')).toBeVisible()
    await expect.element(screen.getByRole('tab', {name: 'Cleanup'})).toHaveAttribute('aria-selected', 'true')
    await screen.getByRole('link', {name: 'Show the first section'}).click()
    await expect.element(screen.getByRole('heading', {name: 'Application caches'})).toBeVisible()
  })

  test('an unknown address shows the root not-found page without the chrome', async () => {
    const {screen} = await open('/nowhere')
    await expect.element(screen.getByText('There is no page at this address.')).toBeVisible()
    await expect.element(screen.getByRole('tablist')).not.toBeInTheDocument()
  })

  test('a /cleanup/empty deep link with nothing in the Trash redirects to the list', async () => {
    const {history, screen} = await open('/cleanup/caches/empty')
    await expect.poll(() => history.location.href).toBe('/cleanup/caches')
    await expect.element(screen.getByRole('heading', {name: 'Application caches'})).toBeVisible()
    await expect.element(screen.getByRole('dialog')).not.toBeInTheDocument()
  })

  test('the confirm route shows its pending state, then the plan', async () => {
    let answer: (plan: Response) => void = () => {}
    vi.spyOn(window, 'fetch').mockImplementation(() => new Promise(resolve => (answer = resolve)))
    const {screen} = await open('/cleanup/caches/confirm')
    const dialog = screen.getByRole('dialog', {name: 'Move to the Trash'})
    await expect.element(dialog.getByText('Checking the selection…')).toBeVisible()
    await expect.element(dialog.getByRole('button', {name: 'Move to the Trash'})).toBeDisabled()
    await expect.poll(() => vi.mocked(window.fetch).mock.calls.length).toBe(1)
    answer(new Response(JSON.stringify(PLAN)))
    await expect.element(dialog.getByText('6 items in total')).toBeVisible()
    await expect.element(dialog.getByText('Checking the selection…')).not.toBeInTheDocument()
  })
})

describe('the selection in the URL', () => {
  const footer = (screen: Screen) => screen.getByRole('contentinfo')
  const categories = fixture.data.categories
  const APP_A = '/Users/you/Library/Caches/app-a'

  beforeEach(() => gsap.globalTimeline.timeScale(20))
  afterEach(() => {
    gsap.globalTimeline.timeScale(1)
    vi.restoreAllMocks()
  })

  async function open(url: string) {
    const history = at(url)
    const screen = await render(<App loaded={fixture} history={history} />)
    return {history, screen}
  }

  test('a reload keeps a custom selection', async () => {
    const first = await open('/cleanup')
    await first.screen.getByText('~/Library/Caches/app-a').click()
    await first.screen.getByRole('checkbox', {name: 'Select all in node_modules'}).click()
    await expect.element(footer(first.screen).getByText('4 items selected · 4.8 GB')).toBeVisible()
    const url = first.history.location.href
    expect(url).toMatch(/[?&]drop=/)
    await first.screen.unmount()
    const again = await open(url)
    await expect.element(footer(again.screen).getByText('4 items selected · 4.8 GB')).toBeVisible()
    await expect.element(again.screen.getByRole('checkbox', {name: '~/Library/Caches/app-a'})).not.toBeChecked()
    await expect.element(again.screen.getByRole('checkbox', {name: '~/Library/Caches/app-b'})).toBeChecked()
  })

  test('a deep link with add and drop applies them over the preselection', async () => {
    const {[APP_A]: _dropped, ...rest} = rowSelectionOf(categories, NO_PICKS)
    const {drop} = picksOf(categories, rest)
    expect(drop).toMatch(/^[0-9a-z]{8}$/)
    const {screen} = await open(address('/cleanup', {add: '_node', drop}))
    await expect.element(footer(screen).getByText('4 items selected · 4.8 GB')).toBeVisible()
    await expect.element(screen.getByRole('checkbox', {name: 'Select all in node_modules'})).toBeChecked()
    await expect.element(screen.getByRole('checkbox', {name: '~/Library/Caches/app-a'})).not.toBeChecked()
  })

  test('garbage selection values fall back to the preselection without errors', async () => {
    const errors = vi.spyOn(console, 'error')
    const {screen} = await open(address('/cleanup', {add: ['x'], drop: '..//.ZZZZZZZZ._nope.12'}))
    await expect.element(footer(screen).getByText('4 items selected · 3.8 GB')).toBeVisible()
    expect(errors).not.toHaveBeenCalled()
  })

  test('ticking replaces the history entry, so Back skips the individual ticks', async () => {
    const {history, screen} = await open('/cleanup')
    await screen.getByRole('link', {name: /^node_modules/}).click()
    await expect.element(screen.getByRole('heading', {name: 'node_modules'})).toBeVisible()
    const entries = history.length
    await screen.getByRole('checkbox', {name: '~/code/web/node_modules'}).click()
    await screen.getByRole('checkbox', {name: 'Select all in Application caches'}).click()
    await screen.getByRole('checkbox', {name: 'Select all in Application caches'}).click()
    await expect.element(footer(screen).getByText('5 items selected · 6.8 GB')).toBeVisible()
    expect(history.length).toBe(entries)
    expect(where(history)).toBe('/cleanup/node')
    history.back()
    await expect.element(screen.getByRole('heading', {name: 'Application caches'})).toBeVisible()
    expect(where(history)).toBe('/cleanup/caches')
  })

  const where = (history: RouterHistory) => history.location.pathname
})

describe('errors are shown, never swallowed', () => {
  beforeEach(() => gsap.globalTimeline.timeScale(20))
  afterEach(() => {
    gsap.globalTimeline.timeScale(1)
    vi.restoreAllMocks()
  })

  async function open(url: string, loaded: Loaded = fixture) {
    const history = at(url)
    const screen = await render(<App loaded={loaded} history={history} />)
    return {history, screen}
  }

  function answering(first: () => Promise<Response>) {
    let failing = true
    vi.spyOn(window, 'fetch').mockImplementation(async () => (failing ? first() : new Response(JSON.stringify(PLAN))))
    return () => {
      failing = false
    }
  }

  test('a /preview 500 shows what failed, and Retry works once the server recovers', async () => {
    const recover = answering(async () => new Response('the selection changed on disk', {status: 500}))
    const {screen} = await open('/cleanup/caches/confirm')
    const failed = screen.getByRole('dialog', {name: "Couldn't check the selection"})
    await expect.element(failed.getByText(/disk-clean answered 500 to \/preview: the selection changed on disk/)).toBeVisible()
    recover()
    await failed.getByRole('button', {name: 'Retry'}).click()
    await expect.element(screen.getByRole('dialog', {name: 'Move to the Trash'}).getByText('6 items in total')).toBeVisible()
  })

  test('an unreachable server says so, and Retry works once it is back', async () => {
    const recover = answering(() => Promise.reject(new TypeError('Failed to fetch')))
    const {screen} = await open('/cleanup/caches/confirm')
    const failed = screen.getByRole('dialog', {name: "Couldn't check the selection"})
    await expect.element(failed.getByText(/Can't reach disk-clean/)).toBeVisible()
    recover()
    await failed.getByRole('button', {name: 'Retry'}).click()
    await expect.element(screen.getByRole('dialog', {name: 'Move to the Trash'}).getByText('6 items in total')).toBeVisible()
  })

  test('a preview that never answers shows the pending dialog, and Escape leaves it', async () => {
    vi.spyOn(window, 'fetch').mockImplementation(() => new Promise(() => {}))
    const {history, screen} = await open('/cleanup')
    await screen.getByRole('button', {name: /^Delete \d+ items? · /}).click()
    const dialog = screen.getByRole('dialog', {name: 'Move to the Trash'})
    await expect.element(dialog.getByText('Checking the selection…')).toBeVisible()
    await userEvent.keyboard('{Escape}')
    await expect.element(dialog).not.toBeInTheDocument()
    expect(history.location.pathname).toBe('/cleanup/caches')
  })

  test('a render error in a tab shows the root error page, not a blank screen', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const tree = JSON.parse('{"name": "~", "path": "/Users/you", "bytes": 1, "files": 1, "mtime": 0, "children": null}')
    const {screen} = await open('/storage', {...fixture, data: {...fixture.data, tree}})
    await expect.element(screen.getByRole('alert').getByText('This page hit a problem')).toBeVisible()
    await expect.element(screen.getByRole('tablist')).not.toBeInTheDocument()
    expect(errors).toHaveBeenCalled()
  })
})

describe('dialogs and tabs keep your place', () => {
  beforeEach(() => gsap.globalTimeline.timeScale(20))
  afterEach(() => {
    gsap.globalTimeline.timeScale(1)
    vi.restoreAllMocks()
  })

  async function open(url: string, loaded: Loaded = fixture) {
    const history = at(url)
    const screen = await render(<App loaded={loaded} history={history} />)
    return {history, screen}
  }

  const sectionTitle = () => document.querySelector('main h2')?.textContent

  test('Delete and Escape keep the open section and every search param', async () => {
    mockServer()
    const url = address('/cleanup/node', {q: 'web', sort: 'name-asc'})
    const {history, screen} = await open(url)
    await expect.element(screen.getByRole('heading', {name: 'node_modules'})).toBeVisible()
    await screen.getByRole('button', {name: /^Delete \d+ items? · /}).click()
    const dialog = screen.getByRole('dialog', {name: 'Move to the Trash'})
    await expect.element(dialog.getByText('6 items in total')).toBeVisible()
    expect(history.location.href).toBe(address('/cleanup/node/confirm', {q: 'web', sort: 'name-asc'}))
    expect(sectionTitle()).toBe('node_modules')
    await userEvent.keyboard('{Escape}')
    await expect.element(dialog).not.toBeInTheDocument()
    expect(history.location.href).toBe(url)
    expect(sectionTitle()).toBe('node_modules')
  })

  test('a tab returns to the section and search it was left at', async () => {
    const {history, screen} = await open(address('/cleanup/node', {q: 'web'}))
    await expect.element(screen.getByRole('heading', {name: 'node_modules'})).toBeVisible()
    await screen.getByRole('tab', {name: 'Storage'}).click()
    await expect.element(screen.getByLabelText('Storage sunburst of /Users/you')).toBeVisible()
    await screen.getByRole('tab', {name: 'Cleanup'}).click()
    await expect.poll(() => history.location.href).toBe(address('/cleanup/node', {q: 'web'}))
    await expect.element(screen.getByRole('heading', {name: 'node_modules'})).toBeVisible()
    await expect.element(screen.getByRole('textbox', {name: 'Filter paths'})).toHaveValue('web')
  })

  test('a tab returns to where you left it after clicking a section and typing a filter', async () => {
    const {history, screen} = await open('/cleanup')
    await expect.poll(() => history.location.pathname).toBe('/cleanup/caches')
    await screen.getByRole('link', {name: /^node_modules/}).click()
    await expect.poll(() => history.location.pathname).toBe('/cleanup/node')
    await screen.getByRole('textbox', {name: 'Filter paths'}).fill('web')
    await expect.poll(() => history.location.href).toBe(address('/cleanup/node', {q: 'web'}))
    await screen.getByRole('tab', {name: 'Storage'}).click()
    await expect.poll(() => history.location.pathname).toBe('/storage')
    await screen.getByRole('tab', {name: 'Cleanup'}).click()
    await expect.poll(() => history.location.href).toBe(address('/cleanup/node', {q: 'web'}))
    await expect.element(screen.getByRole('textbox', {name: 'Filter paths'})).toHaveValue('web')
  })

  test('paths read from the home folder the server reports when the storage map is skipped', async () => {
    mockServer()
    const {screen} = await open('/cleanup/caches/confirm', {...fixture, data: {...fixture.data, tree: null}})
    const held = screen.getByRole('dialog', {name: 'Move to the Trash'}).getByRole('list', {name: 'Moved to the Trash'})
    await expect.element(held.getByRole('listitem').first()).toHaveTextContent('~/Library/Caches/app-a2.0 GB')
    await expect.element(held.getByText('/Users/you', {exact: false})).not.toBeInTheDocument()
  })

  test('closing a dialog finishes its exit animation before the URL changes', async () => {
    mockServer()
    const {history, screen} = await open('/cleanup/caches')
    await screen.getByRole('button', {name: /^Delete \d+ items? · /}).click()
    const dialog = screen.getByRole('dialog', {name: 'Move to the Trash'})
    await expect.element(dialog.getByText('6 items in total')).toBeVisible()
    const popup = dialog.element()
    const order: string[] = []
    const watch = new MutationObserver(() => {
      if (popup.hasAttribute('data-ending-style') && !order.includes('closing')) order.push('closing')
    })
    watch.observe(popup, {attributes: true})
    const running = () => popup.getAnimations({subtree: true}).filter(animation => animation.playState === 'running').length
    const stop = history.subscribe(() => order.push(`url ${history.location.pathname} with ${running()} running`))
    await userEvent.keyboard('{Escape}')
    await expect.poll(() => order.length).toBe(2)
    watch.disconnect()
    stop()
    expect(order).toEqual(['closing', 'url /cleanup/caches with 0 running'])
  })
})


describe('route guards wait for the scan to catch up', () => {
  const GB = 1024 ** 3
  const LIVE: Loaded = {data: NO_DATA, token: 'test-token', home: '/Users/you', live: true}
  const CACHES = {id: 'caches', title: 'Application caches', desc: 'caches', risk: 'safe' as const}
  const listing = fixture.data.categories[0]?.items ?? []
  const backlog = [
    {type: 'disk', data: {total: 500 * GB, used: 400 * GB, free: 50 * GB, snapshots: 0, elapsed_ms: 1}},
    ...listing.map((entry, i) => ({type: 'item', data: {category: CACHES, item: {...entry, line: i + 1}, elapsed_ms: 2 + i}})),
  ]
  const where = (history: RouterHistory) => history.location.pathname

  afterEach(() => vi.restoreAllMocks())

  async function cold(url: string) {
    const {source, catchUp} = fakeEventSource({caughtUp: false})
    const history = at(url)
    const screen = await render(<App loaded={{...LIVE, openEvents: () => source}} history={history} />)
    return {source, catchUp, history, screen}
  }

  test('a reload of the open confirm dialog reopens it once the replay has caught up', async () => {
    mockServer()
    const {source, catchUp, history, screen} = await cold('/cleanup/caches/confirm')
    const dialog = screen.getByRole('dialog', {name: 'Move to the Trash'})
    await expect.element(screen.getByText('Loading the scan…')).toBeVisible()
    await sendAll(source, backlog)
    await expect.element(screen.getByText('Loading the scan…')).toBeVisible()
    expect(where(history)).toBe('/cleanup/caches/confirm')
    catchUp()
    await expect.element(dialog.getByText('6 items in total')).toBeVisible()
    expect(where(history)).toBe('/cleanup/caches/confirm')
  })

  test('/cleanup waits for the first section, then the URL names it', async () => {
    const {source, catchUp, history} = await cold('/cleanup')
    catchUp()
    await new Promise(requestAnimationFrame)
    expect(where(history)).toBe('/cleanup')
    await sendAll(source, backlog)
    await expect.poll(() => where(history)).toBe('/cleanup/caches')
  })

  test('an unknown section waits while scanning and is not found once the scan is done', async () => {
    const {source, catchUp, history, screen} = await cold('/cleanup/nope')
    await sendAll(source, backlog)
    catchUp()
    await expect.element(screen.getByText("Scanning… items appear here as they're found.")).toBeVisible()
    await expect.element(screen.getByRole('heading', {name: 'Application caches'})).not.toBeInTheDocument()
    await sendAll(source, [{type: 'done', data: {reclaimable: GB, elapsed_ms: 50}}])
    await expect.element(screen.getByText('There is no section called “nope” in this scan.')).toBeVisible()
    expect(where(history)).toBe('/cleanup/nope')
  })

  test('a junk child under a real section, and a wrongly cased path, are the plain not-found page', async () => {
    for (const url of ['/cleanup/caches/bogus', '/CLEANUP']) {
      const history = at(url)
      const screen = await render(<App loaded={fixture} history={history} />)
      await expect.element(screen.getByText('There is no page at this address.')).toBeVisible()
      await expect.element(screen.getByText(/There is no section called/)).not.toBeInTheDocument()
      await screen.unmount()
    }
  })

  test('a storage zoom token that matches no folder in the scan moves to the top', async () => {
    const cases: [string, string][] = [
      [zoomed('/Users/you/Library/Caches'), zoomed('/Users/you/Library/Caches')],
      [`/storage/${fullToken('/Users/you/Library/nope/deeper')}`, '/storage'],
      [`/storage/${fullToken('/Users/you/Library')}`, '/storage'],
      [`/storage/${fullToken('/Users/you/nowhere')}`, '/storage'],
      ['/storage/zzzzzzzz', '/storage'],
      ['/storage/not-a-token', '/storage'],
      [zoomed('/Users/you'), '/storage'],
    ]
    for (const [url, landed] of cases) {
      const history = at(url)
      const screen = await render(<App loaded={fixture} history={history} />)
      await expect.poll(() => where(history)).toBe(landed)
      await screen.unmount()
    }
  })
})

describe('URL hygiene', () => {
  const categories = fixture.data.categories
  const tokenOfApp = () => {
    const {'/Users/you/Library/Caches/app-a': _dropped, ...rest} = rowSelectionOf(categories, NO_PICKS)
    return picksOf(categories, rest).drop
  }

  test('invalid values of every param are stripped from the address', async () => {
    const unknownToken = 'zz9zz9zz'
    const drop = `${tokenOfApp()}.${unknownToken}`
    const history = at(`/cleanup/caches?overlay=zzz&view%5B%5D=cards&q=%20%20&drop=${drop}&add=_nope`)
    const screen = await render(<App loaded={fixture} history={history} />)
    await expect.element(screen.getByRole('heading', {name: 'Application caches'})).toBeVisible()
    await expect.poll(() => history.location.search).toBe(address('', {drop: tokenOfApp()}))
  })

  test('tab links carry no empty selection params', async () => {
    const history = at('/cleanup/node')
    const screen = await render(<App loaded={fixture} history={history} />)
    await screen.getByRole('tab', {name: 'Storage'}).click()
    await expect.element(screen.getByLabelText('Storage sunburst of /Users/you')).toBeVisible()
    const hrefs = [...document.querySelectorAll('[role="tab"]')].map(tab => tab.getAttribute('href') ?? '')
    expect(hrefs).toEqual(['/cleanup/node', '/storage', '/insights', '/trash'])
  })
})
