import {ancestorsOf, isExact, isPickable, type Category, type Insights, type Item, type Loaded, type TreeNode} from './data'
import {ownedCollection, type Writes} from './owned'
import {foldersOf, type Folder} from './folders'

export type CategoryHead = Omit<Category, 'items' | 'bytes'>

type Timed<T> = T & {elapsed_ms: number}

export interface Progress {
  files: number
  bytes: number
  dir: string
}

export type ScanEvent =
  | {type: 'disk'; data: Timed<{total: number; used: number; free: number; snapshots: number}>}
  | {type: 'progress'; data: Timed<Progress>}
  | {type: 'item'; data: Timed<{category: CategoryHead; item: Item}>}
  | {type: 'growing'; data: Timed<{tree: TreeNode | null; insights: Insights}>}
  | {type: 'walked'; data: Timed<{home: number; tree: TreeNode | null; insights: Insights | null; worktrees: number}>}
  | {type: 'done'; data: Timed<{reclaimable: number}>}
  | {type: 'error'; data: Timed<{message: string}>}
  | {type: 'rescan'; data: Timed<object>}
  | {type: 'unlisted'; data: Timed<{path: string}>}
  | {type: 'replayed'; data: Timed<object>}

export interface Entry extends Item {
  section: string
  risk: Category['risk']
  search: string
  exact: boolean
  selectable: number
  scan: number
  order: string
}

export interface Nest {
  id: string
  outer: string
  inner: string
}

export interface Disk {
  id: 'disk'
  total: number
  used: number
  free: number
  snapshots: number
}

export interface ScanProgress extends Progress {
  id: 'progress'
}

export interface ScanState {
  id: 'scan'
  walked: boolean
  done: boolean
  error: string
  worktrees: number
  stopped: boolean
  elapsed: number
  walkedAt: number
  rescans: number
  listed: number
  caughtUp: boolean
  home: number
  reclaimable: number
  tree: TreeNode | null
  insights: Insights | null
}

const NO_PROGRESS: ScanProgress = {id: 'progress', files: 0, bytes: 0, dir: ''}

const DIGITS = /\d+/g
const MARKS = /\p{M}/gu

const orderOf = (label: string) => label.normalize('NFD').replace(MARKS, '').toLowerCase().replace(DIGITS, digits => digits.padStart(16, '0'))

function entryOf(item: Item, head: CategoryHead, scan: number): Entry {
  return {...item, section: head.id, risk: head.risk, search: `${item.label} ${item.path} ${head.title} ${item.note}`.toLowerCase(), exact: isExact(item), selectable: isPickable(item) ? 1 : 0, scan, order: orderOf(item.label)}
}

function startState(loaded: Loaded): ScanState {
  const finished = !loaded.live
  const {data} = loaded
  return {
    id: 'scan',
    walked: finished,
    done: finished,
    error: '',
    worktrees: 0,
    stopped: false,
    elapsed: 0,
    walkedAt: 0,
    rescans: 0,
    listed: 0,
    caughtUp: finished,
    home: data.home,
    reclaimable: data.reclaimable,
    tree: data.tree,
    insights: data.insights ?? null,
  }
}

const headOf = ({items: _items, bytes: _bytes, ...head}: Category): CategoryHead => head

function nestsOf(paths: readonly string[]) {
  const known = new Set(paths)
  return paths.flatMap(inner => ancestorsOf(inner).flatMap(outer => (known.has(outer) ? [{id: `${outer}\n${inner}`, outer, inner}] : [])))
}

function underOf(paths: readonly string[]) {
  const under = new Map<string, Set<string>>()
  for (const path of paths) for (const outer of ancestorsOf(path)) addUnder(under, outer, path)
  return under
}

export function createScanStore(loaded: Loaded) {
  const {data} = loaded
  const entries = data.categories.flatMap(c => c.items.map(i => entryOf(i, headOf(c), 0)))
  const paths = entries.map(e => e.path)
  return {
    folders: ownedCollection<Folder>(f => f.token, foldersOf(data.tree)),
    items: ownedCollection<Entry>(e => e.path, entries),
    sections: ownedCollection<CategoryHead>(s => s.id, data.categories.map(headOf)),
    nests: ownedCollection<Nest>(n => n.id, nestsOf(paths)),
    disk: ownedCollection<Disk>(d => d.id, [{id: 'disk', total: data.total, used: data.used, free: data.free, snapshots: data.snapshots}]),
    progress: ownedCollection<ScanProgress>(p => p.id, [NO_PROGRESS]),
    scan: ownedCollection<ScanState>(s => s.id, [startState(loaded)], !loaded.live),
    under: underOf(paths),
    bySection: bySectionOf(entries),
    restarts: new Set<() => void>(),
    turns: new Set<() => void>(),
  }
}

export type ScanStore = ReturnType<typeof createScanStore>

function addUnder(under: Map<string, Set<string>>, outer: string, inner: string) {
  const known = under.get(outer)
  if (known) known.add(inner)
  else under.set(outer, new Set([inner]))
}

interface Batch {
  state: ScanState
  items: Entry[]
  removed: string[]
  heads: Map<string, CategoryHead>
  disk: Disk | null
  progress: ScanProgress | null
  restarted: boolean
}

type Handlers = {[K in ScanEvent['type']]: (batch: Batch, data: Extract<ScanEvent, {type: K}>['data'], store: ScanStore) => void}

export const RESTART: Partial<ScanState> = {walked: false, done: false, error: '', worktrees: 0, stopped: false, elapsed: 0, walkedAt: 0, listed: 0}

function takeItem(batch: Batch, {category, item}: {category: CategoryHead; item: Item}) {
  batch.heads.set(category.id, category)
  batch.items.push(entryOf(item, category, batch.state.rescans))
  if (item.line !== undefined && item.line > batch.state.listed) batch.state = {...batch.state, listed: item.line}
}

function stale(store: ScanStore, scan: number) {
  return [...store.items.synced.values()].filter(e => e.scan !== scan).map(e => e.path)
}

function stillChecking(store: ScanStore, batch: Batch) {
  const latest = new Map<string, Entry>()
  for (const entry of store.items.synced.values()) latest.set(entry.path, entry)
  for (const entry of batch.items) latest.set(entry.path, entry)
  return [...latest.values()].filter(e => e.checking === true).map(e => e.path)
}

const HANDLERS: Handlers = {
  disk: (batch, {total, used, free, snapshots}) => {
    batch.disk = {id: 'disk', total, used, free, snapshots}
  },
  progress: (batch, {files, bytes, dir}) => {
    batch.progress = {id: 'progress', files, bytes, dir}
  },
  item: takeItem,
  growing: (batch, {tree, insights}) => {
    batch.state = {...batch.state, tree: tree ?? batch.state.tree, insights}
  },
  walked: (batch, {home, tree, insights, worktrees, elapsed_ms}) => {
    batch.state = {...batch.state, home, tree, insights, worktrees, walked: true, walkedAt: elapsed_ms}
  },
  done: (batch, {reclaimable}, store) => {
    if (batch.state.rescans > 0) {
      const fresh = new Set(batch.items.filter(e => e.scan === batch.state.rescans).map(e => e.path))
      batch.removed.push(...stale(store, batch.state.rescans).filter(path => !fresh.has(path)))
    }
    batch.removed.push(...stillChecking(store, batch))
    batch.state = {...batch.state, reclaimable, done: true, caughtUp: true}
  },
  unlisted: (batch, {path}) => {
    batch.removed.push(path)
  },
  error: (batch, {message}) => {
    batch.state = {...batch.state, error: message, caughtUp: true}
  },
  replayed: batch => {
    batch.state = {...batch.state, caughtUp: true}
  },
  rescan: batch => {
    batch.state = {...batch.state, ...RESTART, rescans: batch.state.rescans + 1}
    batch.progress = NO_PROGRESS
    batch.restarted = true
  },
}

function take(batch: Batch, event: ScanEvent, store: ScanStore) {
  const handle = HANDLERS[event.type] as (batch: Batch, data: ScanEvent['data'], store: ScanStore) => void
  handle(batch, event.data, store)
  batch.state = {...batch.state, elapsed: Math.max(batch.state.elapsed, event.data.elapsed_ms)}
}

function writeNests(store: ScanStore, items: readonly Entry[], writes: Writes<Nest>) {
  for (const {path} of items) {
    for (const outer of ancestorsOf(path)) {
      if (store.items.synced.has(outer)) writes.put({id: `${outer}\n${path}`, outer, inner: path})
      addUnder(store.under, outer, path)
    }
    for (const inner of store.under.get(path) ?? []) writes.put({id: `${path}\n${inner}`, outer: path, inner})
  }
}

function dropNests(store: ScanStore, removed: ReadonlySet<string>, writes: Writes<Nest>) {
  for (const nest of store.nests.synced.values()) if (removed.has(nest.outer) || removed.has(nest.inner)) writes.remove(nest.id)
  for (const path of removed) for (const outer of ancestorsOf(path)) store.under.get(outer)?.delete(path)
}

function sectionOf(store: ScanStore, section: string) {
  const known = store.bySection.get(section)
  if (known) return known
  const fresh = {version: 0, items: new Map<string, Entry>()}
  store.bySection.set(section, fresh)
  return fresh
}

function leave(store: ScanStore, path: string) {
  const section = store.items.synced.get(path)?.section
  if (section === undefined) return
  const group = sectionOf(store, section)
  group.items.delete(path)
  group.version += 1
}

function indexSections(store: ScanStore, items: readonly Entry[], removed: ReadonlySet<string>) {
  for (const path of removed) leave(store, path)
  for (const entry of items) {
    if (store.items.synced.get(entry.path)?.section !== entry.section) leave(store, entry.path)
    const group = sectionOf(store, entry.section)
    group.items.set(entry.path, entry)
    group.version += 1
  }
}

function bySectionOf(entries: readonly Entry[]) {
  const groups = new Map<string, {version: number; items: Map<string, Entry>}>()
  for (const entry of entries) {
    const group = groups.get(entry.section) ?? {version: 0, items: new Map<string, Entry>()}
    group.items.set(entry.path, entry)
    groups.set(entry.section, group)
  }
  return groups
}

function writeItems(store: ScanStore, batch: Batch, removed: ReadonlySet<string>) {
  const items = removed.size === 0 ? batch.items : batch.items.filter(e => !removed.has(e.path))
  if (items.length === 0 && removed.size === 0) return
  indexSections(store, items, removed)
  store.items.write(writes => {
    for (const entry of items) writes.put(entry)
    for (const path of removed) writes.remove(path)
  })
  if (batch.heads.size > 0) store.sections.write(writes => batch.heads.forEach(head => writes.put(head)))
  store.nests.write(writes => {
    writeNests(store, items, writes)
    dropNests(store, removed, writes)
  })
}

const settledOf = (state: ScanState) => state.done || state.error !== '' || state.stopped

function turned(before: ScanState, after: ScanState, sectionsBefore: number, sectionsAfter: number) {
  return (sectionsBefore === 0) !== (sectionsAfter === 0) || settledOf(before) !== settledOf(after) || before.walked !== after.walked
}

function writeFolders(store: ScanStore, tree: TreeNode | null) {
  store.folders.write(writes => {
    writes.clear()
    for (const folder of foldersOf(tree)) writes.put(folder)
  })
}

export function receiveScan(store: ScanStore, events: readonly ScanEvent[]) {
  const state = store.scan.synced.get('scan')
  if (!state) return
  const sections = store.sections.synced.size
  const batch: Batch = {state, items: [], removed: [], heads: new Map(), disk: null, progress: null, restarted: false}
  for (const event of events) take(batch, event, store)
  const removed = new Set(batch.removed)
  writeItems(store, batch, removed)
  const {disk, progress} = batch
  if (disk) store.disk.write(writes => writes.put(disk))
  if (progress) store.progress.write(writes => writes.put(progress))
  if (batch.state.tree !== state.tree) writeFolders(store, batch.state.tree)
  store.scan.write(writes => writes.put(batch.state))
  if (batch.state.caughtUp) store.scan.markReady()
  if (store.scan.collection.isReady() && turned(state, batch.state, sections, store.sections.synced.size)) for (const turn of store.turns) turn()
  if (!batch.restarted) return
  for (const restarted of store.restarts) restarted()
  store.restarts.clear()
}
