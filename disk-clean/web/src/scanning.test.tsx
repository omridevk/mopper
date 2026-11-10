import {afterEach, describe, expect, test, vi} from 'vitest'
import {render} from 'vitest-browser-react'
import {App} from './App'
import {NO_DATA, type Item, type Loaded} from './lib/data'
import {fingerprint} from './lib/selection'
import type {CategoryHead, ScanEvent} from './lib/scan-feed'
import {at, fixture, item} from './test/fixture'
import {fakeEventSource, mockServer, PLAN, query} from './test/page'
import './index.css'

const GB = 1024 ** 3
const LIVE: Loaded = {data: NO_DATA, token: 'test-token', home: '/Users/you', live: true}
const STILL_RUNNING = 'The scan is still running; confirming stops it and uses what was found so far.'

const CACHES: CategoryHead = {id: 'caches', title: 'Application caches', desc: 'caches', risk: 'safe'}
const WORKTREES: CategoryHead = {id: 'worktrees', title: 'Git worktrees with no leftover work', desc: 'worktrees', risk: 'safe'}
const DOCKER: CategoryHead = {id: 'docker', title: 'Docker', desc: 'docker', risk: 'review'}

const cacheA = item('/Users/you/Library/Caches/app-a', 2 * GB, {line: 1})
const cacheB = item('/Users/you/Library/Caches/app-b', GB, {preselect: false, line: 1})
const cacheC = item('/Users/you/Library/Caches/app-c', GB, {line: 2})
const worktree = item('/Users/you/code/wt', 0, {action: 'worktree', label: '~/code/wt', preselect: false, checking: true})
const docker = item('cmd:docker-prune', 0, {action: 'cmd', cmd_id: 'docker-prune', label: 'docker system prune -f', accuracy: 'vm', preselect: false, age: null, checking: true})

function listed(category: CategoryHead, entry: Item, elapsed_ms = 100): ScanEvent {
  return {type: 'item', data: {category, item: entry, elapsed_ms}}
}

const disk: ScanEvent = {type: 'disk', data: {total: 500 * GB, used: 400 * GB, free: 50 * GB, snapshots: 0, elapsed_ms: 10}}

async function live() {
  const {source, send} = fakeEventSource()
  const history = at()
  const screen = await render(<App loaded={{...LIVE, openEvents: () => source}} history={history} />)
  return {screen, send, history}
}

const deleteButton = (screen: Awaited<ReturnType<typeof render>>) => screen.getByRole('contentinfo').getByRole('button', {name: /^(Delete \d|Select items|Scanning|Nothing found|The scan failed)/})

const decided = () => {
  const call = vi.mocked(window.fetch).mock.calls.find(([url]) => url === '/decide')
  return call ? JSON.parse(String(call[1]?.body)) : null
}

describe('delete while the scan is running', () => {
  afterEach(() => vi.restoreAllMocks())

  test('Delete works for listed items mid-scan, the dialog says the scan still runs, and confirming approves exactly what it showed', async () => {
    mockServer({...PLAN, paths: PLAN.paths.slice(0, 1), final: [], final_count: 0, rejected: [], count: 1})
    const {screen, send} = await live()
    send(disk)
    send(listed(CACHES, cacheA))
    await expect.element(deleteButton(screen)).toHaveAccessibleName('Delete 1 item · 2.0 GB')
    await expect.element(deleteButton(screen)).toBeEnabled()
    await deleteButton(screen).click()
    const dialog = screen.getByRole('dialog')
    await expect.element(dialog.getByText(STILL_RUNNING)).toBeVisible()
    send(listed(CACHES, cacheC, 200))
    await expect.element(screen.getByText('2 items selected · 3.0 GB')).toBeInTheDocument()
    await dialog.getByRole('button', {name: /^Move 1 item to the Trash/}).click()
    await expect.poll(decided).not.toBeNull()
    expect(decided()).toMatchObject({decision: 'approve', add: '', drop: '', listed: 1, fingerprint: fingerprint([cacheA.path])})
    await expect.element(screen.getByText('Waiting to start')).toBeVisible()
    await expect.element(screen.getByText('Scan stopped at approval')).not.toBeInTheDocument()
  })

  test('worktree and command rows say checking… and cannot be ticked until their check answers', async () => {
    const {screen, send} = await live()
    send(disk)
    send(listed(WORKTREES, worktree))
    send(listed(DOCKER, docker))
    await expect.element(screen.getByRole('heading', {name: WORKTREES.title})).toBeVisible()
    await expect.element(screen.getByText('checking…')).toBeVisible()
    await expect.element(screen.getByRole('checkbox', {name: '~/code/wt'})).not.toBeInTheDocument()
    await expect.element(screen.getByRole('checkbox', {name: `Select all in ${WORKTREES.title}`})).not.toBeInTheDocument()
    await screen.getByText('~/code/wt').click()
    await expect.element(screen.getByText('0 items selected · 0 B')).toBeVisible()
    await expect.element(deleteButton(screen)).toHaveAccessibleName('Scanning… nothing found yet')

    send(listed(WORKTREES, {...worktree, checking: false, bytes: GB, preselect: true}, 300))
    await expect.element(screen.getByRole('checkbox', {name: '~/code/wt'})).toBeChecked()
    await expect.element(screen.getByText('checking…')).not.toBeInTheDocument()
    await expect.element(deleteButton(screen)).toHaveAccessibleName('Delete 1 item · 1.0 GB')

    await screen.getByRole('link', {name: /^Docker/}).click()
    await expect.element(screen.getByText('checking…')).toBeVisible()
    await expect.element(screen.getByRole('checkbox', {name: 'docker system prune -f'})).not.toBeInTheDocument()
    send({type: 'unlisted', data: {path: 'cmd:docker-prune', elapsed_ms: 400}})
    await expect.element(screen.getByRole('link', {name: /^Docker/})).not.toBeInTheDocument()
  })

  test('the Delete button always says why it is disabled', async () => {
    const {screen, send} = await live()
    await expect.element(deleteButton(screen)).toHaveAccessibleName('Scanning… nothing found yet')
    await expect.element(deleteButton(screen)).toBeDisabled()
    send(disk)
    send(listed(DOCKER, docker))
    await expect.element(screen.getByText('checking…')).toBeVisible()
    await expect.element(deleteButton(screen)).toHaveAccessibleName('Scanning… nothing found yet')
    send(listed(CACHES, cacheB, 200))
    await expect.element(deleteButton(screen)).toHaveAccessibleName('Select items to delete')
    await expect.element(deleteButton(screen)).toBeDisabled()
    await screen.getByRole('link', {name: /^Application caches/}).click()
    await screen.getByRole('checkbox', {name: '~/Library/Caches/app-b'}).click()
    await expect.element(deleteButton(screen)).toHaveAccessibleName('Delete 1 item · 1.0 GB')
    await expect.element(deleteButton(screen)).toBeEnabled()
    send({type: 'done', data: {reclaimable: GB, elapsed_ms: 900}})
    await expect.element(screen.getByText('Scan complete')).toBeVisible()
    await expect.element(screen.getByText('checking…')).not.toBeInTheDocument()
    await expect.element(deleteButton(screen)).toBeEnabled()
    send({type: 'error', data: {message: 'permission denied', elapsed_ms: 950}})
    await expect.element(deleteButton(screen)).toHaveAccessibleName('The scan failed · nothing can be deleted')
    await expect.element(deleteButton(screen)).toBeDisabled()
  })
})

describe('selection buttons in the footer', () => {

  test('Clear selection empties the selection in the address and Reset to recommended brings the preselection back', async () => {
    const history = at()
    const screen = await render(<App loaded={fixture} history={history} />)
    const footer = screen.getByRole('contentinfo')
    await expect.element(screen.getByText('4 items selected · 3.8 GB')).toBeVisible()
    await expect.element(footer.getByRole('button', {name: 'Reset to recommended: already the recommended selection'})).toBeDisabled()
    await footer.getByRole('button', {name: 'Clear selection', exact: true}).click()
    await expect.element(screen.getByText('0 items selected · 0 B')).toBeVisible()
    await expect.poll(() => query(history).drop).toBeTruthy()
    await expect.element(footer.getByRole('button', {name: 'Clear selection: nothing is selected'})).toBeDisabled()
    await footer.getByRole('button', {name: 'Reset to recommended', exact: true}).click()
    await expect.element(screen.getByText('4 items selected · 3.8 GB')).toBeVisible()
    await expect.poll(() => [query(history).add ?? '', query(history).drop ?? '']).toEqual(['', ''])
    await expect.element(footer.getByRole('button', {name: 'Reset to recommended: already the recommended selection'})).toBeDisabled()
  })
})
