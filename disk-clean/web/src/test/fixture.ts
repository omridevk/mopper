import {createMemoryHistory} from '@tanstack/react-router'
import type {Category, Item, Loaded, ScanData, TrashEntry, TrashState} from '@/lib/data'

const GB = 1024 ** 3

export const at = (url = '/') => createMemoryHistory({initialEntries: [url]})

export function item(path: string, bytes: number, extra: Partial<Item> = {}): Item {
  return {
    path,
    label: path.replace('/Users/you', '~'),
    bytes,
    action: 'rm',
    cmd_id: '-',
    note: '',
    age: 10,
    accuracy: 'exact',
    preselect: true,
    report: false,
    ...extra,
  }
}

export function category(id: string, title: string, risk: Category['risk'], items: Item[]): Category {
  return {id, title, desc: `${title} description`, risk, items, bytes: items.reduce((sum, i) => sum + i.bytes, 0)}
}

const categories: Category[] = [
  category('caches', 'Application caches', 'safe', [
    item('/Users/you/Library/Caches/app-a', 2 * GB),
    item('/Users/you/Library/Caches/app-b', 1 * GB, {age: 400}),
    item('/Users/you/Library/Caches/app-c', 0.5 * GB, {age: 120}),
    item('/Users/you/Library/Caches/app-d', 0.25 * GB, {age: 0}),
  ]),
  category('node', 'node_modules', 'safe', [
    item('/Users/you/code/web/node_modules', 3 * GB, {preselect: false, age: 2, note: 'pnpm project'}),
  ]),
  category('docker', 'Docker', 'review', [
    item('cmd:docker-prune', 5 * GB, {action: 'cmd', cmd_id: 'docker-prune', label: 'docker system prune -f', accuracy: 'vm', preselect: false, age: null}),
  ]),
  category('big', 'Large files', 'report', [item('/Users/you/big.iso', 8 * GB, {report: true, preselect: false})]),
]

const tree = {
  name: '~',
  path: '/Users/you',
  bytes: 40 * GB,
  files: 120_000,
  mtime: 1_700_000_000,
  children: [
    {
      name: 'Library',
      path: '/Users/you/Library',
      bytes: 25 * GB,
      files: 80_000,
      mtime: 1_700_000_000,
      children: [
        {name: 'Caches', path: '/Users/you/Library/Caches', bytes: 15 * GB, files: 50_000, mtime: 1_700_000_000, children: []},
        {name: 'everything else in this folder', path: '/Users/you/Library/*', bytes: 10 * GB, files: 30_000, mtime: 0, children: [], rest: true},
      ],
    },
    {name: 'code', path: '/Users/you/code', bytes: 15 * GB, files: 40_000, mtime: 1_690_000_000, children: []},
  ],
}

const data: ScanData = {
  categories,
  reclaimable: 6.75 * GB,
  free: 50 * GB,
  total: 500 * GB,
  used: 400 * GB,
  home: 40 * GB,
  snapshots: 2,
  tree,
  insights: {
    generated_at: 0,
    modified_by_day: [{day: '2026-01-01', bytes: 2 * GB, files: 10}],
    age_by_folder: {buckets: ['<1w', '<1m', 'older'], folders: [{path: '~/Library', bytes: [GB, 2 * GB, 3 * GB]}]},
    by_kind: [
      {kind: 'video', bytes: 4 * GB, files: 3},
      {kind: 'code', bytes: GB, files: 900},
    ],
    largest_files: [{path: '~/big.iso', bytes: 8 * GB, mtime: 1_700_000_000}],
  },
}

export const RUN = 'run-20261004-161542-a2ad54a5'

export const fixture: Loaded = {data, token: 'test-token', home: '/Users/you', run: RUN, trash: []}

export const onDrive = <T>(value: T): T => JSON.parse(JSON.stringify(value).replaceAll('/Users/you', 'C:/Users/you'))

export const windowsFixture: Loaded = {...onDrive(fixture), platform: 'windows'}

export function approvedEvent(paths: readonly string[], decision = 1, from: readonly Category[] = data.categories) {
  const chosen = new Set(paths)
  const items = from.flatMap(c =>
    c.items.filter(i => chosen.has(i.path)).map(i => ({path: i.path, label: i.label, bytes: i.bytes, section: c.id, exact: i.accuracy === 'exact'})),
  )
  return {
    type: 'approved' as const,
    data: {decision, items, bytes: items.reduce((sum, i) => sum + i.bytes, 0), mode: 'trash' as const, trash_run: decision === 1 ? RUN : `${RUN}-${decision}`, elapsed_ms: 0},
  }
}

export const CACHE_PATHS = ['app-a', 'app-b', 'app-c', 'app-d'].map(name => `/Users/you/Library/Caches/${name}`)

export const cleanupEvents = [
  approvedEvent(CACHE_PATHS),
  {type: 'started', data: {run: 'run-1', free: 50 * GB, paths: 4, worktrees: 1, commands: 0, bytes: 3.75 * GB, elapsed_ms: 0}},
  {type: 'removed', data: {path: '/Users/you/Library/Caches/app-a', bytes: 2 * GB, secs: 1, elapsed_ms: 900}},
  {type: 'free', data: {free: 52 * GB, elapsed_ms: 1000}},
  {type: 'removed', data: {path: '/Users/you/Library/Caches/app-b', bytes: GB, secs: 1, elapsed_ms: 1400}},
  {type: 'removed', data: {path: '/Users/you/Library/Caches/app-c', bytes: 0.5 * GB, secs: 1, elapsed_ms: 1500}},
  {type: 'failed', data: {path: '/Users/you/Library/Caches/app-d', bytes: 0.25 * GB, reason: 'still present after removal: permission denied', elapsed_ms: 1600}},
  {type: 'worktree', data: {path: '/Users/you/code/wt', bytes: GB, outcome: 'kept', reason: '1 uncommitted or untracked files', elapsed_ms: 2000}},
  {type: 'done', data: {free_before: 50 * GB, free_after: 53.4 * GB, elapsed_ms: 2500}},
] as const

export function bigSection(count: number): Category {
  const items = Array.from({length: count}, (_, i) =>
    item(`/Users/you/tmp/item-${String(i).padStart(5, '0')}`, 4096 + ((i * 7919) % 100_000), {age: i % 400, note: i % 3 === 0 ? 'temp file' : ''}),
  )
  return category('temp', 'Your macOS temp', 'safe', items)
}

export function withSection(extra: Category): Loaded {
  const [first, ...rest] = categories
  return {data: {...data, categories: first ? [first, extra, ...rest] : [extra]}, token: 'test-token', home: '/Users/you', run: RUN, trash: []}
}

const CACHES = ['app-a', 'app-b', 'app-c', 'app-d'].map((name, i) => ({path: `/Users/you/Library/Caches/${name}`, bytes: [2, 1, 0.5, 0.25][i]! * GB}))

const IDS = ['a1', 'b2', 'c3', 'd4'].map(id => id.padStart(16, '0'))

export function entry(i: number, state: TrashState, extra: Partial<TrashEntry> = {}): TrashEntry {
  const cache = CACHES[i]!
  return {
    id: IDS[i]!,
    run: RUN,
    original: cache.path,
    trashed: `/Users/you/.Trash/${cache.path.split('/').at(-1)}`,
    bytes: cache.bytes,
    at: 1_790_000_000 + i,
    dev: 1,
    ino: 100 + i,
    state,
    reason: '',
    ...extra,
  }
}

const rows = (state: TrashState) => ({type: 'trash', data: {entries: CACHES.map((_, i) => entry(i, state)), elapsed_ms: 0}})

export const trashedEvents = [
  {type: 'started', data: {run: 'run-h', free: 50 * GB, paths: 4, trash: 4, worktrees: 1, commands: 0, bytes: 4.75 * GB, elapsed_ms: 0}},
  ...CACHES.map((c, i) => ({type: 'trashed', data: {...c, id: IDS[i]!, trashed_path: entry(i, 'trashed').trashed, elapsed_ms: 100 + i}})),
  rows('trashed'),
  {type: 'worktree', data: {path: '/Users/you/code/wt', bytes: GB, outcome: 'removed', reason: '', elapsed_ms: 900}},
  {type: 'done', data: {removed: 1, removed_bytes: GB, trashed: 4, trashed_bytes: 3.75 * GB, free_before: 50 * GB, free_after: 51 * GB, elapsed_ms: 1000}},
] as const

const jobItem = (job: string, c: (typeof CACHES)[number], i: number, outcome: string) => ({
  job,
  id: IDS[i]!,
  ...c,
  trashed_path: entry(i, 'trashed').trashed,
  outcome,
  reason: '',
  elapsed_ms: 1010 + i,
})

export const undoEvents = [
  {type: 'undo_started', data: {job: 'j-undo', count: 4, bytes: 3.75 * GB, elapsed_ms: 1005}},
  ...CACHES.map((c, i) => ({type: 'undone', data: jobItem('j-undo', c, i, 'restored')})),
  rows('restored'),
  {type: 'undo_done', data: {job: 'j-undo', restored: 4, restored_bytes: 3.75 * GB, kept: 0, trashed: 0, trashed_bytes: 0, elapsed_ms: 1050}},
] as const

export const emptyEvents = [
  {type: 'empty_started', data: {job: 'j-empty', count: 4, bytes: 3.75 * GB, free: 51 * GB, elapsed_ms: 1005}},
  ...CACHES.slice(0, 2).map((c, i) => ({type: 'emptied', data: jobItem('j-empty', c, i, 'emptied')})),
  {type: 'free', data: {free: 53 * GB, elapsed_ms: 1020}},
  ...CACHES.slice(2).map((c, i) => ({type: 'emptied', data: jobItem('j-empty', c, i + 2, 'emptied')})),
  rows('emptied'),
  {type: 'empty_done', data: {job: 'j-empty', emptied: 4, emptied_bytes: 3.75 * GB, kept: 0, trashed: 0, trashed_bytes: 0, free_before: 51 * GB, free_after: 54.75 * GB, elapsed_ms: 1080}},
] as const
