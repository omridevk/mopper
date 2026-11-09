import {eq, useLiveQuery, type Collection} from '@tanstack/react-db'
import type {RowSelectionState} from '@tanstack/react-table'
import {useCallback, useMemo, useSyncExternalStore} from 'react'
import {outermost, sumBytes, type Category} from './data'
import {NO_SESSION, type Action, type Db, type Request, type Session} from './db'
import type {Folder} from './folders'
import type {CategoryHead, Disk, Entry, ScanProgress, ScanState} from './scan-feed'

function first<T>(rows: readonly T[], fallback: T) {
  return rows[0] ?? fallback
}

export function useScanState(db: Db): ScanState {
  const {data} = useLiveQuery(db.scan.scan.collection)
  return first(data, db.scan.scan.synced.get('scan') ?? NO_SCAN)
}

const NO_SCAN: ScanState = {id: 'scan', walked: true, done: true, error: '', worktrees: 0, stopped: false, elapsed: 0, walkedAt: 0, rescans: 0, listed: 0, caughtUp: true, home: 0, reclaimable: 0, tree: null, insights: null}
const NO_DISK: Disk = {id: 'disk', total: 0, used: 0, free: 0, snapshots: 0}
const NO_PROGRESS: ScanProgress = {id: 'progress', files: 0, bytes: 0, dir: ''}

export function useFolders(db: Db): ReadonlyMap<string, Folder> {
  const {data} = useLiveQuery(db.scan.folders.collection)
  return useMemo(() => new Map(data.map(folder => [folder.path, folder])), [data])
}

export function useDisk(db: Db): Disk {
  const {data} = useLiveQuery(db.scan.disk.collection)
  return first(data, NO_DISK)
}

export function useScanProgress(db: Db): ScanProgress {
  const {data} = useLiveQuery(db.scan.progress.collection)
  return first(data, NO_PROGRESS)
}

export function useSession(db: Db): Session {
  const {data} = useLiveQuery(db.session.collection)
  return first(data, NO_SESSION)
}

export function useRequest(db: Db, action: Action): Request | undefined {
  const {state} = useLiveQuery(db.requests.collection)
  return state.get(action)
}

export function usePending(db: Db, actions: readonly Action[]) {
  const {state} = useLiveQuery(db.requests.collection)
  return actions.some(action => state.get(action)?.status === 'pending')
}

function useEntries(db: Db): Entry[] {
  return useLiveQuery(db.scan.items.collection).data
}

export function useSections(db: Db): CategoryHead[] {
  return useLiveQuery(db.scan.sections.collection).data
}

const byRiskThenSize = (a: Category, b: Category) => Number(a.risk === 'report') - Number(b.risk === 'report') || b.bytes - a.bytes

export function categoriesOf(sections: readonly CategoryHead[], entries: readonly Entry[]): Category[] {
  const items = new Map<string, Entry[]>()
  for (const entry of entries) {
    const known = items.get(entry.section)
    if (known) known.push(entry)
    else items.set(entry.section, [entry])
  }
  return sections
    .flatMap(head => {
      const mine = (items.get(head.id) ?? []).toSorted((a, b) => b.bytes - a.bytes)
      return mine.length > 0 ? [{...head, items: mine, bytes: sumBytes(mine)}] : []
    })
    .toSorted(byRiskThenSize)
}

export function useCategories(db: Db): Category[] {
  const entries = useEntries(db)
  const sections = useSections(db)
  return useMemo(() => categoriesOf(sections, entries), [entries, sections])
}

const versions = new WeakMap<object, number>()

export function useVersion<T extends object, K extends string | number>(collection: Collection<T, K>) {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const subscription = collection.subscribeChanges(() => {
        versions.set(collection, (versions.get(collection) ?? 0) + 1)
        onChange()
      })
      return () => subscription.unsubscribe()
    },
    [collection],
  )
  return useSyncExternalStore(subscribe, () => versions.get(collection) ?? 0)
}

export function useCleanable(db: Db) {
  const {data} = useLiveQuery({
    query: q =>
      q
        .from({i: db.scan.items.collection})
        .where(({i}) => eq(i.report, false))
        .select(({i}) => ({path: i.path})),
  })
  return useMemo(() => new Set(data.map(row => row.path)), [data])
}

export function useInside(db: Db, path: string, on: RowSelectionState) {
  const prefix = path.endsWith('/') ? path : `${path}/`
  const items = db.scan.items.collection
  const {data} = useLiveQuery({
    queryKey: ['inside', items.id, path],
    query: q =>
      q
        .from({i: items})
        .where(({i}) => eq(i.report, false))
        .fn.where(({i}) => i.path === path || i.path.startsWith(prefix)),
  })
  return useMemo(
    () => ({
      bytes: sumBytes(outermost(data)),
      count: data.length,
      selected: sumBytes(outermost(data.filter(i => on[i.path] === true))),
      risk: data.some(i => i.risk === 'review') ? ('review' as const) : ('safe' as const),
    }),
    [data, on],
  )
}
