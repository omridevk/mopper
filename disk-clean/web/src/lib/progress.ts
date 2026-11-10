import {useLiveQuery} from '@tanstack/react-db'
import {useMemo} from 'react'
import type {CleanupEvent, EventRow, Of, OutcomeKind} from './cleanup-feed'
import type {TrashEntry} from './data'
import type {Db, Link, Planned} from './db'
import {useDisk, useSession} from './views'

export type LogRow = EventRow

export interface Outcome extends LogRow {
  kind: OutcomeKind
}

export interface Job {
  kind: 'empty' | 'undo'
  id: string
  count: number
  bytes: number
  free: number | null
  done: Of<'empty_done'> | Of<'undo_done'> | null
}

export interface Cleanup {
  waiting: boolean
  queued: boolean
  started: Of<'started'> | null
  done: Of<'done'> | null
  free: Of<'free'> | null
  abandoned: Of<'abandoned'> | null
  job: Job | null
  latestFree: number | null
}

export interface PlannedSection {
  id: string
  title: string
  bytes: number
  count: number
}

export interface FilmPlan {
  items: ReadonlyMap<string, Planned>
  sections: PlannedSection[]
  approved: number
  total: number
  headline: ReadonlySet<string>
}

export interface Removal {
  bytes: number
  count: number
  restored: number
}

export interface CleanupProgress {
  active: boolean
  plan: FilmPlan
  cleanup: Cleanup
  outcomes: readonly Outcome[]
  byKey: ReadonlyMap<string, Outcome>
  removals: ReadonlyMap<string, Removal>
  freed: number
  trashed: number
  inTrash: InTrash
  restored: number
  handled: number
  count: number
  total: number
  free: number | null
  freeChange: number | null
  elapsed: number
  link: Link
}

interface Total {
  kind: OutcomeKind | null
  jobId: string
  bytes: number
  count: number
}

const NO_CLEANUP: Cleanup = {waiting: false, queued: false, started: null, done: null, free: null, abandoned: null, job: null, latestFree: null}

function startedJob(event: Extract<CleanupEvent, {type: 'empty_started' | 'undo_started'}>): Job {
  const {job, count, bytes} = event.data
  if (event.type === 'empty_started') return {kind: 'empty', id: job, count, bytes, free: event.data.free, done: null}
  return {kind: 'undo', id: job, count, bytes, free: null, done: null}
}

function finishedJob(job: Job | null, event: Extract<CleanupEvent, {type: 'empty_done' | 'undo_done'}>): Job | null {
  return job?.id === event.data.job ? {...job, done: event.data} : job
}

function withJob(cleanup: Cleanup, event: CleanupEvent): Cleanup {
  if (event.type === 'empty_started' || event.type === 'undo_started') return {...cleanup, job: startedJob(event)}
  if (event.type === 'empty_done' || event.type === 'undo_done') return {...cleanup, job: finishedJob(cleanup.job, event)}
  return cleanup
}

function freeOf(event: CleanupEvent) {
  const data: object = event.data
  if (event.type === 'done' || event.type === 'empty_done') return event.data.free_after
  if (event.type === 'started' || event.type === 'free' || event.type === 'empty_started') return 'free' in data && typeof data.free === 'number' ? data.free : null
  return null
}

function withLatestFree(cleanup: Cleanup, event: CleanupEvent): Cleanup {
  const free = freeOf(event)
  return free === null ? cleanup : {...cleanup, latestFree: free}
}

function withStatusOnly(cleanup: Cleanup, event: CleanupEvent): Cleanup {
  switch (event.type) {
    case 'approved':
      return {...cleanup, waiting: true}
    case 'queued':
      return {...cleanup, queued: true}
    case 'started':
      return {...cleanup, started: event.data}
    case 'done':
      return {...cleanup, done: event.data}
    case 'abandoned':
      return {...cleanup, abandoned: event.data}
    case 'free':
      return {...cleanup, free: event.data}
    default:
      return withJob(cleanup, event)
  }
}

function withStatus(cleanup: Cleanup, event: CleanupEvent): Cleanup {
  return withLatestFree(withStatusOnly(cleanup, event), event)
}

export function statusOf(events: readonly {event: CleanupEvent}[]) {
  return events.reduce((cleanup, row) => withStatus(cleanup, row.event), NO_CLEANUP)
}

export const isOutcome = <T extends {kind: OutcomeKind | null}>(row: T): row is T & {kind: OutcomeKind} => row.kind !== null

function sumOf(totals: readonly Total[], wanted: (total: Total) => boolean, field: 'bytes' | 'count' = 'bytes') {
  return totals.reduce((sum, total) => (wanted(total) ? sum + total[field] : sum), 0)
}

const FREED = new Set<OutcomeKind | null>(['removed', 'emptied'])

function handledOf(cleanup: Cleanup, totals: readonly Total[]) {
  const job = cleanup.job
  if (job && !job.done) return sumOf(totals, t => t.jobId === job.id)
  return sumOf(totals, t => t.jobId === '' && (t.kind === 'removed' || t.kind === 'trashed'))
}

function freeNow({latestFree}: Cleanup) {
  return latestFree
}

function totalOf(plan: FilmPlan, {started}: Cleanup) {
  return started ? started.paths + started.worktrees + started.commands : plan.items.size
}

function removalsOf(rows: readonly {section: string; kind: OutcomeKind | null; bytes: number; count: number}[]) {
  const removals = new Map<string, Removal>()
  for (const row of rows) {
    const restored = row.kind === 'restored'
    if (!restored && row.kind !== 'removed' && row.kind !== 'trashed' && row.kind !== 'emptied') continue
    const known = removals.get(row.section) ?? {bytes: 0, count: 0, restored: 0}
    removals.set(row.section, {bytes: known.bytes + row.bytes, count: known.count + (restored ? 0 : row.count), restored: known.restored + (restored ? row.count : 0)})
  }
  return removals
}

function usePlan(db: Db): FilmPlan {
  const {state: items} = useLiveQuery(db.plan.collection)
  const {data: sections} = useLiveQuery(db.queries.plannedSections)
  const {data: headline} = useLiveQuery(db.queries.headline)
  const {approvedBytes} = useSession(db)
  const {total} = useDisk(db)
  return useMemo(
    () => ({items, sections, approved: approvedBytes, total, headline: new Set(headline.map(h => h.path))}),
    [items, sections, approvedBytes, total, headline],
  )
}

function useCleanup(db: Db): Cleanup {
  const {data} = useLiveQuery(db.queries.status)
  return useMemo(() => statusOf(data), [data])
}

function useOutcomes(db: Db): readonly Outcome[] {
  const {data} = useLiveQuery(db.queries.outcomes)
  return useMemo(() => data.filter(isOutcome), [data])
}

export function useLatest(db: Db): readonly Outcome[] {
  const {data} = useLiveQuery(db.queries.latest)
  return useMemo(() => data.filter(isOutcome), [data])
}

function figuresOf(cleanup: Cleanup, totals: readonly Total[], latest: readonly Total[]) {
  return {
    freed: sumOf(latest, t => FREED.has(t.kind)),
    trashed: sumOf(totals, t => t.kind === 'trashed'),
    restored: sumOf(latest, t => t.kind === 'restored'),
    handled: handledOf(cleanup, totals),
    count: sumOf(totals, t => t.jobId === '', 'count'),
  }
}

function useFigures(db: Db, cleanup: Cleanup) {
  const {data: totals} = useLiveQuery(db.queries.totals)
  const {data: latest} = useLiveQuery(db.queries.latestTotals)
  const {data: bySection} = useLiveQuery(db.queries.bySection)
  const {data: clock} = useLiveQuery(db.cleanup.clock.collection)
  return useMemo(
    () => ({...figuresOf(cleanup, totals, latest), removals: removalsOf(bySection), elapsed: clock[0]?.at ?? 0}),
    [cleanup, totals, latest, bySection, clock],
  )
}

function useByKey(db: Db) {
  const latest = useLatest(db)
  return useMemo(() => new Map(latest.map(o => [o.key, o])), [latest])
}

export interface InTrash {
  count: number
  bytes: number
  ids: string[]
}

function inTrashOf(entries: readonly TrashEntry[], run: string): InTrash {
  const mine = entries.filter(e => e.run === run && e.state === 'trashed')
  return {count: mine.length, bytes: mine.reduce((sum, e) => sum + e.bytes, 0), ids: mine.map(e => e.id)}
}

function useInTrash(db: Db) {
  const {data} = useLiveQuery(db.trash.collection)
  const run = useSession(db).trashRun || (db.loaded.run ?? '')
  return useMemo(() => inTrashOf(data, run), [data, run])
}

export function useCleanupProgress(db: Db): CleanupProgress | null {
  const session = useSession(db)
  const inTrash = useInTrash(db)
  const plan = usePlan(db)
  const cleanup = useCleanup(db)
  const outcomes = useOutcomes(db)
  const byKey = useByKey(db)
  const figures = useFigures(db, cleanup)
  return useMemo(() => {
    if (!session.approved) return null
    const {done} = cleanup
    return {
      active: session.active,
      plan,
      cleanup,
      outcomes,
      byKey,
      ...figures,
      inTrash,
      total: totalOf(plan, cleanup),
      free: session.freshDisk ? null : freeNow(cleanup),
      freeChange: done ? done.free_after - done.free_before : null,
      link: session.cleanupLink,
    }
  }, [session, plan, cleanup, outcomes, byKey, figures, inTrash])
}

export function jobRunning(progress: CleanupProgress) {
  return progress.cleanup.job !== null && progress.cleanup.job.done === null
}

export type Phase = 'scanning' | 'reviewing' | 'waiting' | 'queued' | 'trashing' | 'deleting' | 'trashed' | 'undoing' | 'emptying' | 'finished' | 'stopped'

export function phaseOf(scanning: boolean, progress: CleanupProgress | null): Phase {
  if (!progress) return scanning ? 'scanning' : 'reviewing'
  const {job, abandoned, started, done} = progress.cleanup
  if (job && !job.done) return job.kind === 'empty' ? 'emptying' : 'undoing'
  if (abandoned) return 'stopped'
  if (!started) return progress.cleanup.queued ? 'queued' : 'waiting'
  if (!done) return (started.trash ?? 0) > 0 ? 'trashing' : 'deleting'
  return progress.inTrash.count > 0 ? 'trashed' : 'finished'
}

export const isPutBack = (phase: Phase, progress: CleanupProgress) => phase === 'finished' && progress.restored > 0

export function heroBytes(phase: Phase, progress: CleanupProgress) {
  if (phase === 'trashing') return progress.handled
  if (phase === 'trashed') return progress.inTrash.bytes
  if (phase === 'undoing' || phase === 'emptying') return progress.handled
  if (isPutBack(phase, progress)) return progress.restored
  return progress.freed
}

export function formatDuration(seconds: number) {
  const m = Math.floor(seconds / 60)
  return m > 0 ? `${m}m ${seconds % 60}s` : `${seconds}s`
}

export interface Totals {
  removed: Outcome[]
  trashed: Outcome[]
  failed: Outcome[]
  kept: Outcome[]
  sections: number
  biggest: Outcome | null
  reclaimed: number
  trashedBytes: number
  seconds: number
}

const sum = (all: readonly Outcome[]) => all.reduce((total, o) => total + o.bytes, 0)
const isStillTrashed = (o: Outcome) => o.kind === 'trashed' || (o.kind === 'kept' && o.job)

export function finaleOf(latest: readonly Outcome[], done: Of<'done'> | null, elapsed: number): Totals {
  const removed = latest.filter(o => FREED.has(o.kind))
  const trashed = latest.filter(isStillTrashed)
  const cleared = [...removed, ...trashed]
  return {
    removed,
    trashed,
    failed: latest.filter(o => o.kind === 'failed'),
    kept: latest.filter(o => o.kind === 'kept' && !o.job),
    sections: new Set(cleared.map(o => o.section)).size,
    biggest: cleared.reduce<Outcome | null>((best, o) => (best && best.bytes >= o.bytes ? best : o), null),
    reclaimed: sum(removed),
    trashedBytes: sum(trashed),
    seconds: Math.round((done?.elapsed_ms ?? elapsed) / 1000),
  }
}

export interface MovieFeed {
  db: Db
  plan: FilmPlan
  cleanup: Cleanup
  elapsed: number
}

export function useMovie(db: Db): MovieFeed {
  const {data: clock} = useLiveQuery(db.cleanup.clock.collection)
  return {db, plan: usePlan(db), cleanup: useCleanup(db), elapsed: clock[0]?.at ?? 0}
}

export function useStaged(db: Db): readonly Outcome[] {
  const {data} = useLiveQuery(db.queries.staged)
  return useMemo(() => data.filter(isOutcome), [data])
}

const bySeq = (a: LogRow, b: LogRow) => a.seq - b.seq

export interface LogFeed {
  rows: readonly LogRow[]
  cleanup: () => Cleanup
  subscribe: (onChange: () => void) => () => void
}

function appendTo(rows: LogRow[], status: {cleanup: Cleanup}, added: readonly LogRow[]) {
  for (const row of added.toSorted(bySeq)) {
    rows.push(row)
    status.cleanup = withStatus(status.cleanup, row.event)
  }
}

export function logFeed(db: Db): LogFeed {
  const log = db.queries.log
  const rows: LogRow[] = []
  const status = {cleanup: NO_CLEANUP}
  const reread = () => {
    rows.length = 0
    status.cleanup = NO_CLEANUP
    appendTo(rows, status, log.toArray)
  }
  log.startSyncImmediate()
  reread()
  const subscribe = (onChange: () => void) => {
    if (log.size !== rows.length) reread()
    const subscription = log.subscribeChanges(changes => {
      if (changes.some(change => change.type === 'delete')) {
        rows.length = 0
        status.cleanup = NO_CLEANUP
      }
      appendTo(rows, status, changes.flatMap(change => (change.type === 'insert' ? [change.value] : [])))
      onChange()
    })
    return () => subscription.unsubscribe()
  }
  return {rows, cleanup: () => status.cleanup, subscribe}
}
