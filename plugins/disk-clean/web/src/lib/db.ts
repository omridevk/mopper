import {createCollection} from '@tanstack/db'
import {QueryClient} from '@tanstack/query-core'
import {useRouteContext} from '@tanstack/react-router'
import {CLEANUP_TYPES, createCleanupStore, decisionOf, type Planned, isWorkerEvent, receiveCleanup, startRound, type CleanupEvent, type Round} from './cleanup-feed'
import {ancestorsOf, outermost, sumBytes, type Loaded, type TrashEntry} from './data'
import {ownedCollection} from './owned'
import {createQueries} from './queries'
import {children} from './api'
import {isDiskRoot} from './platform'
import {createScanStore, nodeAt, receiveScan, within, type ScanEvent} from './scan-feed'
import {openEventSource, stream, type Listener} from './stream'

export type Link = 'live' | 'reconnecting' | 'lost'

export interface Session {
  id: 'session'
  approved: boolean
  approvedBytes: number
  trashRun: string
  active: boolean
  freshDisk: boolean
  cancelled: boolean
  closed: boolean
  scanLink: Link
  cleanupLink: Link
}

export type Action = 'approve' | 'cancel' | 'undo' | 'empty' | 'rescan'

export interface Request {
  id: Action
  status: 'pending' | 'failed'
  message: string
  retry: boolean
}

const ENDED = 'closed'
const SCAN_TYPES: (ScanEvent['type'] | typeof ENDED)[] = ['disk', 'progress', 'item', 'growing', 'walked', 'done', 'error', 'rescan', 'unlisted', 'replayed', ENDED]
const TRASH = 'trash'
const REPLAYED = 'replayed'

type Rows = {type: typeof TRASH; data: {entries: TrashEntry[]}}
type Ended = {type: typeof ENDED; data: object}
const FINAL = new Set<string>(['error', ENDED])
const CLOSED = 2

export const NO_SESSION: Session = {id: 'session', approved: false, approvedBytes: 0, trashRun: '', active: false, freshDisk: false, cancelled: false, closed: false, scanLink: 'live', cleanupLink: 'live'}

const linkOf = (state: number): Link => (state === CLOSED ? 'lost' : 'reconnecting')

function scanListener(setLink: (link: Link) => void, finished: () => boolean): Listener<ScanEvent | Rows | Ended> {
  return {
    types: [...SCAN_TYPES, TRASH],
    toEvent: (type, data) => (type === 'done' && isWorkerEvent(type, data) ? null : ({type, data} as ScanEvent | Rows | Ended)),
    isFinal: event => FINAL.has(event.type),
    onDrop: state => {
      setLink(linkOf(state))
      return state === CLOSED && !finished() ? {type: 'error', data: {message: 'Lost the connection to the scan', elapsed_ms: 0}} : null
    },
    onLive: () => setLink('live'),
  }
}

type Replayed = {type: typeof REPLAYED; data: object}
type CleanupFeed = CleanupEvent | Rows | Replayed

function cleanupListener(setLink: (link: Link) => void, caughtUp: () => void): Listener<CleanupFeed> {
  return {
    types: [...CLEANUP_TYPES, TRASH, REPLAYED],
    toEvent: (type, data) => (isWorkerEvent(type, data) ? ({type, data} as CleanupFeed) : null),
    isFinal: () => false,
    onDrop: state => {
      setLink(linkOf(state))
      if (state === CLOSED) caughtUp()
      return null
    },
    onLive: () => setLink('live'),
  }
}

const bytesOf = (plan: readonly Planned[]) => sumBytes(outermost(plan).filter(p => p.exact))

function createBase(loaded: Loaded) {
  const scan = createScanStore(loaded)
  const cleanup = createCleanupStore()
  const session = ownedCollection<Session>(s => s.id, [NO_SESSION])
  const planned = ownedCollection<Planned>(p => p.path, [])
  return {
    loaded,
    scan,
    cleanup,
    plan: planned,
    session,
    requests: ownedCollection<Request>(r => r.id, []),
    trash: ownedCollection<TrashEntry>(e => e.id, loaded.trash ?? []),
    queries: createQueries({items: scan.items.collection, events: cleanup.events.collection, plan: planned.collection, sections: scan.sections.collection}),
    streams: {scan: null as (() => void) | null, cleanup: null as (() => void) | null},
    queryClient: new QueryClient({defaultOptions: {queries: {retry: false, staleTime: Infinity}}}),
  }
}

type Base = ReturnType<typeof createBase>

function connectionOf(base: Base) {
  return createCollection<{id: string}, string>({
    getKey: row => row.id,
    gcTime: 100,
    sync: {
      sync: ({markReady}) => {
        markReady()
        return connect(base)
      },
    },
  })
}

export function createDb(loaded: Loaded) {
  const base = createBase(loaded)
  return {...base, connection: connectionOf(base)}
}

export type Db = ReturnType<typeof createDb>

const opener = (db: Base, path: string) => () => (db.loaded.openEvents ?? openEventSource)(`${path}?token=${encodeURIComponent(db.loaded.token)}`)

const isRows = (event: {type: string}): event is Rows => event.type === TRASH

export function receiveTrash(db: Base, entries: readonly TrashEntry[]) {
  if (entries.length > 0) db.trash.write(writes => entries.forEach(writes.put))
}

function splitRows<E extends {type: string}>(db: Base, events: readonly (E | Rows)[]) {
  receiveTrash(
    db,
    events.filter(isRows).flatMap(event => event.data.entries),
  )
  return events.filter((event): event is E => !isRows(event))
}

function closeStreams(db: Base) {
  db.streams.scan?.()
  db.streams.cleanup?.()
  db.streams.scan = null
  db.streams.cleanup = null
}

const isEnded = (event: {type: string}): event is Ended => event.type === ENDED

export function receiveScanEvents(db: Base, events: readonly (ScanEvent | Rows | Ended)[]) {
  const scan = splitRows<ScanEvent | Ended>(db, events)
  receiveScan(
    db.scan,
    scan.filter((event): event is ScanEvent => !isEnded(event)),
  )
  if (scan.some(event => event.type === 'disk') && db.session.synced.get('session')?.approved) writeSession(db, {freshDisk: true})
  if (!scan.some(isEnded)) return
  writeSession(db, {closed: true, active: false})
  closeStreams(db)
}

export function writeSession(db: Base, patch: Partial<Session>) {
  const current = db.session.synced.get('session')
  if (!current || Object.entries(patch).every(([key, value]) => current[key as keyof Session] === value)) return
  db.session.write(writes => writes.put({...current, ...patch}))
}

export function beginRound(db: Base, {decision, items, trash_run}: Pick<Round, 'decision' | 'items' | 'trash_run'>) {
  startRound(db.cleanup, decision, trash_run)
  db.plan.write(writes => {
    writes.clear()
    items.forEach(writes.put)
  })
  writeSession(db, {approved: true, approvedBytes: bytesOf(items), trashRun: trash_run, active: true, freshDisk: false})
}

function isActive(db: Base) {
  const approved = db.session.synced.get('session')?.approved === true
  return (approved && !db.cleanup.settled) || db.cleanup.job !== ''
}

function waitsItsTurn(db: Base, event: CleanupEvent) {
  const {decision, settled} = db.cleanup
  return decision > 0 && !settled && decisionOf(event) > decision
}

function isPast(db: Base, event: CleanupEvent) {
  const decision = decisionOf(event)
  return event.type !== 'approved' && decision > 0 && decision < db.cleanup.decision
}

const FREE_FIGURES = new Set<string>(['started', 'free', 'done', 'empty_started', 'empty_done'])

const isReplayed = (event: {type: string}): event is Replayed => event.type === REPLAYED

export function receiveCleanupEvents(db: Base, feed: readonly CleanupFeed[]) {
  const events = feed.filter((event): event is CleanupEvent | Rows => !isReplayed(event))
  if (events.length < feed.length) queueMicrotask(db.cleanup.caughtUp)
  let pending: CleanupEvent[] = []
  const flush = () => {
    if (pending.length > 0) receiveCleanup(db.cleanup, db.plan.synced, pending)
    pending = []
  }
  for (const event of splitRows<CleanupEvent>(db, events)) {
    if (isPast(db, event)) continue
    if (waitsItsTurn(db, event)) flush()
    if (waitsItsTurn(db, event)) {
      db.cleanup.later.push(event)
      continue
    }
    if (event.type === 'approved') {
      flush()
      if (event.data.decision !== db.cleanup.decision) beginRound(db, event.data)
      db.cleanup.run ||= event.data.trash_run
      writeSession(db, {trashRun: event.data.trash_run})
    }
    pending.push(event)
  }
  flush()
  if (events.some(event => FREE_FIGURES.has(event.type))) writeSession(db, {freshDisk: false})
  const later = db.cleanup.settled ? db.cleanup.later.splice(0) : []
  if (later.length > 0) return receiveCleanupEvents(db, later)
  writeSession(db, {active: isActive(db)})
}

export function openScan(db: Base) {
  db.streams.scan?.()
  const listener = scanListener(
    scanLink => writeSession(db, {scanLink}),
    () => db.scan.scan.synced.get('scan')?.done === true,
  )
  db.streams.scan = stream(opener(db, '/events'), listener, events => receiveScanEvents(db, events))
}

function openCleanup(db: Base) {
  if (db.streams.cleanup) return
  db.streams.cleanup = stream(
    opener(db, '/clean-events'),
    cleanupListener(cleanupLink => writeSession(db, {cleanupLink}), db.cleanup.caughtUp),
    events => receiveCleanupEvents(db, events),
  )
}

function connect(db: Base) {
  if (!db.streams.scan) openScan(db)
  openCleanup(db)
  return () => closeStreams(db)
}

export function useDb() {
  return useRouteContext({from: '__root__', select: context => context.db})
}

export type {Planned}

const REMEMBERED = 'disk-clean:folders'

function remembered(): Record<string, string> {
  try {
    return JSON.parse(sessionStorage.getItem(REMEMBERED) ?? '{}')
  } catch {
    return {}
  }
}

function remember(db: Base, path: string) {
  const known = remembered()
  for (const folder of db.scan.folders.synced.values()) if (within(folder.path, path)) known[folder.token] = folder.path
  try {
    sessionStorage.setItem(REMEMBERED, JSON.stringify(known))
  } catch {
    return
  }
}

const loading = new Map<string, Promise<void>>()

export function loadFolder(db: Base, path: string) {
  const state = db.scan.scan.synced.get('scan')
  const node = nodeAt(state?.tree ?? null, path)
  if (!node || node.file || node.rest || isDiskRoot(path) || state?.loaded.some(done => done.path === path)) return Promise.resolve()
  const known = loading.get(path)
  if (known) return known
  const load = children(db.loaded.token, path)
    .then(loaded => {
      if (!Array.isArray(loaded.children)) return
      receiveScanEvents(db, [{type: 'children', data: {node: loaded, elapsed_ms: 0}}])
      remember(db, path)
    })
    .finally(() => loading.delete(path))
  loading.set(path, load)
  return load
}

export async function folderOfToken(db: Base, token: string) {
  const found = db.scan.folders.synced.get(token)
  if (found) return found
  const path = remembered()[token]
  if (!path) return undefined
  for (const step of [...ancestorsOf(path), path]) await loadFolder(db, step).catch(() => undefined)
  return db.scan.folders.synced.get(token) ?? [...db.scan.folders.synced.values()].find(folder => folder.path === path)
}
