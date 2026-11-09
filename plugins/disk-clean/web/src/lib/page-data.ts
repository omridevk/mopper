import {queryCollectionOptions} from '@tanstack/query-db-collection'
import {createCollection, useLiveQuery} from '@tanstack/react-db'
import {getRouteApi, useNavigate} from '@tanstack/react-router'
import {functionalUpdate, type RowSelectionState, type Updater} from '@tanstack/react-table'
import {useCallback, useDeferredValue, useMemo} from 'react'
import {approve as approveItems, askTrash, cancel as cancelRun, restartScan} from './actions'
import {preview, type Mode, type Plan, type Selected} from './api'
import {firstSection, isPickable, sumBytes} from './data'
import {useDb, type Db} from './db'
import {phaseOf, useCleanupProgress} from './progress'
import type {CategoryHead, Entry, Nest, ScanState} from './scan-feed'
import {createSelector, fingerprint, NO_PICKS, picksOf, type Decoded, type Picks, type Selector} from './selection'
import {useScanState, useSession, useVersion} from './views'

export interface Ending {
  title: string
  body: string
}

export interface Selection {
  picked: ReadonlyMap<string, number>
  count: number
  nests: Nest[]
  rowSelection: RowSelectionState
  setRowSelection: (update: Updater<RowSelectionState>) => void
  isOn: (item: {path: string}) => boolean
  reset: () => void
  clear: () => void
  selectable: number
  recommended: boolean
  selected: Entry[]
  exactBytes: number
  apparentBytes: number
  risky: number
  sections: number
}

const CANCELLED: Ending = {title: 'Cancelled', body: 'Nothing more will be deleted. Claude closes the session in your terminal; you can close this tab.'}
const CLOSED: Ending = {title: 'Session closed', body: 'Claude closed this disk-clean session. Nothing more will be deleted; you can close this tab.'}

interface Cached {
  version: number
  head: CategoryHead
  section: Section
}

interface Section extends CategoryHead {
  items: Entry[]
  bytes: number
  selectable: number
}

interface Grouped {
  items: number
  sections: number
  bySection: Map<string, Cached>
  categories: Section[]
}

const grouped = new WeakMap<Db, Grouped>()
const byRiskThenSize = (a: Section, b: Section) => Number(a.risk === 'report') - Number(b.risk === 'report') || b.bytes - a.bytes

function sectionNow(db: Db, head: CategoryHead, known: Cached | undefined): Cached | null {
  const group = db.scan.bySection.get(head.id)
  if (!group || group.items.size === 0) return null
  if (known?.version === group.version && known.head === head) return known
  const items = [...group.items.values()]
  return {version: group.version, head, section: {...head, items, bytes: sumBytes(items), selectable: items.filter(isPickable).length}}
}

function categoriesNow(db: Db) {
  const items = db.scan.items.version()
  const sections = db.scan.sections.version()
  const known = grouped.get(db)
  if (known?.items === items && known.sections === sections) return known.categories
  const bySection = new Map<string, Cached>()
  for (const head of db.scan.sections.synced.values()) {
    const cached = sectionNow(db, head, known?.bySection.get(head.id))
    if (cached) bySection.set(head.id, cached)
  }
  const categories = [...bySection.values()].map(c => c.section).toSorted(byRiskThenSize)
  grouped.set(db, {items, sections, bySection, categories})
  return categories
}

const selectors = new WeakMap<Db, Selector<Entry>>()

function selectorOf(db: Db) {
  const known = selectors.get(db)
  if (known) return known
  const selector = createSelector<Entry>()
  selectors.set(db, selector)
  return selector
}

function decodedNow(db: Db, picks: Picks): Decoded<Entry> {
  return selectorOf(db).decode(categoriesNow(db), picks)
}

function rowSelectionNow(db: Db, picks: Picks): RowSelectionState {
  return decodedNow(db, picks).on
}

function shadowOf(db: Db, nests: readonly Nest[], on: RowSelectionState) {
  let exact = 0
  let apparent = 0
  const counted = new Set<string>()
  for (const nest of nests) {
    if (counted.has(nest.inner) || on[nest.outer] !== true || on[nest.inner] !== true) continue
    counted.add(nest.inner)
    const inner = db.scan.items.synced.get(nest.inner)
    if (inner?.exact) exact += inner.bytes
    else apparent += inner?.bytes ?? 0
  }
  return {exact, apparent}
}

interface Derived {
  selected: Entry[]
  nests: Nest[]
  exactBytes: number
  apparentBytes: number
  risky: number
  sections: number
  picked: ReadonlyMap<string, number>
}

const derivations = new WeakMap<Decoded<Entry>, {nests: number; derived: Derived}>()

function derive(db: Db, decoded: Decoded<Entry>): Derived {
  const nests = [...db.scan.nests.synced.values()]
  const shadow = shadowOf(db, nests, decoded.on)
  const parts = decoded.parts.filter(part => part.selected.length > 0)
  return {
    selected: parts.flatMap(part => part.selected),
    nests,
    exactBytes: parts.reduce((sum, part) => sum + part.exactBytes, 0) - shadow.exact,
    apparentBytes: parts.reduce((sum, part) => sum + part.apparentBytes, 0) - shadow.apparent,
    risky: parts.reduce((sum, part) => sum + (part.risk === 'review' ? part.selected.length : 0), 0),
    sections: parts.length,
    picked: new Map(parts.map(part => [part.selected[0]?.section ?? '', part.selected.length])),
  }
}

function derivedOf(db: Db, decoded: Decoded<Entry>): Derived {
  const nestsVersion = db.scan.nests.version()
  const known = derivations.get(decoded)
  if (known?.nests === nestsVersion) return known.derived
  const derived = derive(db, decoded)
  derivations.set(decoded, {nests: nestsVersion, derived})
  return derived
}

function selectedNow(db: Db, picks: Picks) {
  return derivedOf(db, decodedNow(db, picks)).selected
}

function scanNow(db: Db) {
  return db.scan.scan.synced.get('scan')
}

export function firstSectionNow(db: Db) {
  return firstSection(categoriesNow(db))
}

export function canConfirm(db: Db, picks: Picks) {
  const scan = scanNow(db)
  const active = db.session.synced.get('session')?.active ?? false
  return scan !== undefined && scan.error === '' && !active && selectedNow(db, picks).length > 0
}

export function hasSection(db: Db, section: string) {
  return db.scan.sections.synced.has(section)
}

export function scanSettled(db: Db) {
  const scan = scanNow(db)
  return scan === undefined || scan.done || scan.error !== '' || scan.stopped
}

export function knownPicks(db: Db, picks: Picks): Picks {
  if (!scanSettled(db)) return picks
  const selector = selectorOf(db)
  selector.sync(categoriesNow(db))
  const known = (value: string) =>
    value
      .split('.')
      .filter(token => token !== '' && selector.knows(token))
      .join('.')
  return {add: known(picks.add), drop: known(picks.drop)}
}

export function scanReady(db: Db) {
  const {collection} = db.scan.scan
  return collection.isReady() ? Promise.resolve() : new Promise<void>(resolve => collection.onFirstReady(resolve))
}

export function cleanupReady(db: Db) {
  const connected = db.connection.subscribeChanges(() => {})
  return db.cleanup.replayed.finally(() => connected.unsubscribe())
}

export function isApproved(db: Db) {
  return db.session.synced.get('session')?.approved ?? false
}

interface PreviewRow extends Plan {
  id: 'plan'
}

function previewCollection(db: Db, key: string, selected: Selected) {
  return createCollection(
    queryCollectionOptions({
      queryKey: ['preview', key],
      queryFn: async (): Promise<PreviewRow[]> => [{...(await preview(db.loaded.token, selected)), id: 'plan'}],
      queryClient: db.queryClient,
      getKey: row => row.id,
      startSync: false,
    }),
  )
}

interface Preview {
  collection: ReturnType<typeof previewCollection>
  items: readonly Entry[]
  bytes: number
  selected: Selected
}

const previews = new WeakMap<Db, Map<string, Preview>>()

const NO_SCAN_YET = {done: false, rescans: 0, listed: 0}

function requestOf(db: Db, picks: Picks, selected: readonly Entry[]) {
  const {done, rescans, listed} = scanNow(db) ?? NO_SCAN_YET
  const print = fingerprint(selected.map(e => e.path))
  const streaming = db.loaded.live === true && !done
  const request: Selected = {...picks, listed: streaming ? listed : null, fingerprint: print}
  return {key: `${rescans}|${done ? 'done' : 'scanning'}|${print}`, request}
}

function previewOf(db: Db, picks: Picks): [string, Preview] {
  const {selected, exactBytes} = derivedOf(db, decodedNow(db, picks))
  const {key, request} = requestOf(db, picks, selected)
  const mine = previews.get(db) ?? new Map<string, Preview>()
  previews.set(db, mine)
  const known = mine.get(key)
  if (known) return [key, known]
  const made = {collection: previewCollection(db, key, request), items: selected, bytes: exactBytes, selected: request}
  mine.set(key, made)
  return [key, made]
}

export function previewAt(db: Db, key: string) {
  const known = previews.get(db)?.get(key)
  if (!known) throw new Error('This preview is no longer available. Close the dialog and press Delete again.')
  return known
}

export async function loadPreview(db: Db, picks: Picks) {
  const [key, {collection}] = previewOf(db, picks)
  if (collection.status === 'error') await collection.utils.refetch({throwOnError: true})
  else await collection.preload()
  return key
}

const root = getRouteApi('__root__')

function usePicks(): Picks {
  const add = root.useSearch({select: search => search.add})
  const drop = root.useSearch({select: search => search.drop})
  return useMemo(() => ({add, drop}), [add, drop])
}

function useCategoriesNow(db: Db) {
  useVersion(db.scan.items.collection)
  useVersion(db.scan.sections.collection)
  useVersion(db.scan.nests.collection)
  return categoriesNow(db)
}

export function useSelection(): Selection {
  const db = useDb()
  const picks = usePicks()
  const navigate = useNavigate()
  const categories = useCategoriesNow(db)
  const decoded = decodedNow(db, picks)
  const on = decoded.on
  const derived = derivedOf(db, useDeferredValue(decoded))
  const setRowSelection = useCallback(
    (update: Updater<RowSelectionState>) =>
      navigate({
        to: '.',
        search: prev => {
          const current = rowSelectionNow(db, {add: prev.add ?? '', drop: prev.drop ?? ''})
          return {...prev, ...picksOf(categoriesNow(db), functionalUpdate(update, current), selectorOf(db))}
        },
        replace: true,
      }),
    [db, navigate],
  )
  const reset = useCallback(() => navigate({to: '.', search: prev => ({...prev, ...NO_PICKS}), replace: true}), [navigate])
  const clear = useCallback(() => setRowSelection({}), [setRowSelection])
  const count = categories.reduce((sum, c) => sum + c.items.length, 0)
  const selectable = categories.reduce((sum, c) => sum + c.selectable, 0)
  const recommended = picks.add === '' && picks.drop === ''
  return useMemo(
    () => ({count, selectable, recommended, rowSelection: on, setRowSelection, isOn: item => on[item.path] === true, reset, clear, ...derived}),
    [count, selectable, recommended, on, setRowSelection, reset, clear, derived],
  )
}

function settledOf(live: boolean, scan: ScanState) {
  return {tracking: live || scan.rescans > 0, settled: scan.walked || scan.rescans > 0 || scan.error !== '' || scan.stopped}
}

export function useScan() {
  const db = useDb()
  const scan = useScanState(db)
  const live = db.loaded.live === true
  const rescan = useCallback(() => void restartScan(db), [db])
  return {scan, live, rescan, ...settledOf(live, scan)}
}

export function useHome() {
  return useDb().loaded.home
}

export function useProgress() {
  const db = useDb()
  const scan = useScanState(db)
  const progress = useCleanupProgress(db)
  const scanning = !scan.done && scan.error === '' && !scan.stopped
  return {progress, phase: phaseOf(scanning, progress), idle: phaseOf(scanning, null), active: progress?.active === true}
}

function endingOf({closed, cancelled}: {closed: boolean; cancelled: boolean}) {
  if (cancelled) return CANCELLED
  return closed ? CLOSED : null
}

const attempts = new WeakMap<Db, Preview & {mode: Mode}>()
const trashAttempts = new WeakMap<Db, Map<'undo' | 'empty', readonly string[]>>()

export function useDecisions() {
  const db = useDb()
  const session = useSession(db)
  const approve = (preview: Preview, mode: Mode) => {
    if (preview.items.length === 0) return
    attempts.set(db, {...preview, mode})
    void approveItems(db, {...preview, mode})
  }
  const retry = () => {
    const last = attempts.get(db)
    if (last) approve(last, last.mode)
  }
  const cancel = () => void cancelRun(db)
  const trash = (action: 'undo' | 'empty', ids: readonly string[]) => {
    const tried = trashAttempts.get(db) ?? new Map<'undo' | 'empty', readonly string[]>()
    trashAttempts.set(db, tried.set(action, ids))
    void askTrash(db, action, ids)
  }
  const retryTrash = (action: 'undo' | 'empty') => trash(action, trashAttempts.get(db)?.get(action) ?? [])
  return {active: session.active, done: endingOf(session), approve, retry, cancel, trash, retryTrash}
}

export function useConnection() {
  useLiveQuery(useDb().connection)
}
