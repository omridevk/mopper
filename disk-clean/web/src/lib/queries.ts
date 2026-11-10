import {count, createLiveQueryCollection, eq, inArray, isNull, like, not, or, sum, type Collection} from '@tanstack/db'
import type {CleanupEvent, EventRow} from './cleanup-feed'
import type {Planned} from './db'
import type {CategoryHead, Entry} from './scan-feed'

interface Sources {
  items: Collection<Entry, string>
  events: Collection<EventRow, string>
  plan: Collection<Planned, string>
  sections: Collection<CategoryHead, string>
}

const STATUS_TYPES: CleanupEvent['type'][] = ['approved', 'queued', 'started', 'free', 'done', 'abandoned', 'empty_started', 'empty_done', 'undo_started', 'undo_done']

function logOf(db: Sources) {
  return createLiveQueryCollection(q => q.from({e: db.events}).orderBy(({e}) => e.seq))
}

function outcomesOf(log: ReturnType<typeof logOf>) {
  return createLiveQueryCollection(q =>
    q
      .from({o: log})
      .where(({o}) => not(isNull(o.kind)))
      .orderBy(({o}) => o.seq),
  )
}

type Outcomes = ReturnType<typeof outcomesOf>

const STAGED = ['kept', 'failed'] as const

function stagedOf(outcomes: Outcomes) {
  return createLiveQueryCollection(q =>
    q
      .from({o: outcomes})
      .where(({o}) => or(inArray(o.kind, [...STAGED]), like(o.key, 'cmd:%')))
      .orderBy(({o}) => o.seq),
  )
}

function latestOf(outcomes: Outcomes) {
  return createLiveQueryCollection(q => q.from({o: outcomes}).where(({o}) => eq(o.latest, true)))
}

type Latest = ReturnType<typeof latestOf>

function totalsOf(source: Outcomes | Latest) {
  return createLiveQueryCollection(q =>
    q
      .from({o: source})
      .groupBy(({o}) => [o.kind, o.jobId])
      .select(({o}) => ({kind: o.kind, jobId: o.jobId, bytes: sum(o.bytes), count: count(o.id)})),
  )
}

function bySectionOf(latest: Latest) {
  return createLiveQueryCollection(q =>
    q
      .from({o: latest})
      .groupBy(({o}) => [o.section, o.kind])
      .select(({o}) => ({section: o.section, kind: o.kind, bytes: sum(o.bytes), count: count(o.id)})),
  )
}

function statusOf(db: Sources) {
  return createLiveQueryCollection(q =>
    q
      .from({e: db.events})
      .where(({e}) => inArray(e.type, STATUS_TYPES))
      .orderBy(({e}) => e.seq)
      .select(({e}) => ({id: e.id, event: e.event})),
  )
}

function plannedSectionsOf(db: Sources) {
  return createLiveQueryCollection(q =>
    q
      .from({p: db.plan})
      .innerJoin({s: db.sections}, ({p, s}) => eq(p.section, s.id))
      .groupBy(({p, s}) => [p.section, s.title])
      .select(({p, s}) => ({id: p.section, title: s.title, bytes: sum(p.bytes), count: count(p.path)})),
  )
}

const HEADLINE = 6

function headlineOf(db: Sources) {
  return createLiveQueryCollection(q =>
    q
      .from({p: db.plan})
      .where(({p}) => not(like(p.path, 'cmd:%')))
      .orderBy(({p}) => p.bytes, 'desc')
      .limit(HEADLINE)
      .select(({p}) => ({path: p.path})),
  )
}

export function createQueries(db: Sources) {
  const log = logOf(db)
  const outcomes = outcomesOf(log)
  const latest = latestOf(outcomes)
  return {
    log,
    outcomes,
    latest,
    staged: stagedOf(outcomes),
    totals: totalsOf(outcomes),
    latestTotals: totalsOf(latest),
    bySection: bySectionOf(latest),
    status: statusOf(db),
    plannedSections: plannedSectionsOf(db),
    headline: headlineOf(db),
  }
}
