import {describe, expect, test} from 'vitest'
import {render} from 'vitest-browser-react'
import {App} from './App'
import {formatBytes, NO_DATA, type Insights, type Loaded, type TreeNode} from './lib/data'
import type {ScanEvent} from './lib/scan-feed'
import {at} from './test/fixture'
import {fakeEventSource} from './test/page'
import './index.css'

const GB = 1024 ** 3
const LIVE: Loaded = {data: NO_DATA, token: 'test-token', home: '/Users/you', live: true}
const STILL_READING = 'Still reading the disk; these numbers grow until it finishes.'
const insights: Insights = {
  generated_at: 0,
  modified_by_day: [{day: '2026-01-01', bytes: 2 * GB, files: 10}],
  age_by_folder: {buckets: ['<1w', 'older'], folders: [{path: '~/code', bytes: [GB, 2 * GB]}]},
  by_kind: [{kind: 'code', bytes: GB, files: 900}],
  largest_files: [],
}

function disk(root: number, home: number): TreeNode {
  const node = (name: string, path: string, bytes: number, children: TreeNode[] = []): TreeNode => ({name, path, bytes, files: 0, mtime: 0, children})
  return node('Whole disk (apparent sizes)', '/', root, [node('~', '/Users/you', home, [node('code', '/Users/you/code', home / 2)])])
}

const DISK: ScanEvent = {type: 'disk', data: {total: 500 * GB, used: 400 * GB, free: 50 * GB, snapshots: 0, elapsed_ms: 10}}
const WALKED: ScanEvent = {type: 'walked', data: {home: 40 * GB, tree: disk(380 * GB, 40 * GB), insights, worktrees: 0, elapsed_ms: 5000}}
const growing = (tree: TreeNode | null, elapsed_ms: number): ScanEvent => ({type: 'growing', data: {tree, insights, elapsed_ms}})

async function live(url: string) {
  const {source, send} = fakeEventSource()
  const screen = await render(<App loaded={{...LIVE, openEvents: () => source}} history={at(url)} />)
  send(DISK)
  return {screen, send}
}

describe('Storage and Insights grow while the disk is walked', () => {
  test('Storage draws each snapshot with so-far rows and a not-read-yet row until the walk ends', async () => {
    const {screen, send} = await live('/storage')
    await expect.element(screen.getByText('Reading the disk…')).toBeVisible()
    await expect.element(screen.getByText(/No storage map/)).not.toBeInTheDocument()

    send(growing(disk(100 * GB, 30 * GB), 1000))
    await expect.element(screen.getByLabelText('Storage sunburst of /')).toBeVisible()
    await expect.element(screen.getByText(formatBytes(300 * GB))).toBeVisible()

    send(growing(disk(150 * GB, 40 * GB), 2000))
    await expect.element(screen.getByText(/^Your home folder · so far/)).toBeVisible()
    await expect.element(screen.getByText(/^Rest of the data volume · so far/)).toBeVisible()
    await expect.element(screen.getByText(formatBytes(110 * GB))).toBeVisible()
    await expect.element(screen.getByText('Not read yet')).toBeVisible()
    await expect.element(screen.getByText(formatBytes(250 * GB))).toBeVisible()

    send(growing(null, 3000))
    await expect.element(screen.getByLabelText('Storage sunburst of /')).toBeVisible()
    await expect.element(screen.getByText(formatBytes(250 * GB))).toBeVisible()

    send(WALKED)
    await expect.element(screen.getByText(/^Your home folder/)).toBeVisible()
    await expect.element(screen.getByText(/· so far/)).not.toBeInTheDocument()
    await expect.element(screen.getByText('Not read yet')).not.toBeInTheDocument()
    await expect.element(screen.getByText(formatBytes(360 * GB))).toBeVisible()
  })

  test('a rescan drops the finished tree and grows the new one from nothing', async () => {
    const {screen, send} = await live('/storage')
    send(growing(disk(100 * GB, 30 * GB), 1000))
    send(WALKED)
    await expect.element(screen.getByText(formatBytes(360 * GB))).toBeVisible()

    send({type: 'rescan', data: {elapsed_ms: 0}})
    await expect.element(screen.getByText('Reading the disk…')).toBeVisible()
    await expect.element(screen.getByText(/· so far/)).not.toBeInTheDocument()

    send(growing(disk(20 * GB, 10 * GB), 1000))
    await expect.element(screen.getByLabelText('Storage sunburst of /')).toBeVisible()
    await expect.element(screen.getByText(/^Your home folder · so far/)).toBeVisible()
    await expect.element(screen.getByText(formatBytes(380 * GB))).toBeVisible()
  })

  test('Insights says it is still reading until the walk ends', async () => {
    const {screen, send} = await live('/insights')
    await expect.element(screen.getByText('Reading the disk…')).toBeVisible()
    await expect.element(screen.getByText(/Re-run the scan/)).not.toBeInTheDocument()

    send(growing(disk(100 * GB, 30 * GB), 1000))
    await expect.element(screen.getByText(STILL_READING)).toBeVisible()
    await expect.element(screen.getByRole('heading', {name: 'When your files last changed'})).toBeVisible()

    send(WALKED)
    await expect.element(screen.getByText(STILL_READING)).not.toBeInTheDocument()
    await expect.element(screen.getByRole('heading', {name: 'When your files last changed'})).toBeVisible()
  })
})
