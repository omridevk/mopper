import {and, eq, gte, useLiveQuery, type InitialQueryBuilder, type Ref} from '@tanstack/react-db'
import type {RowSelectionState} from '@tanstack/react-table'
import {useMemo} from 'react'
import type {Risk} from './data'
import type {Db} from './db'
import {textIn} from './platform'
import type {Entry} from './scan-feed'
import type {CleanupSearch, Sort} from './search'

type Shape = Pick<CleanupSearch, 'q' | 'risk' | 'minSize' | 'minAge' | 'sort' | 'only'>

export const isFiltering = (shape: Shape) => shape.q !== '' || shape.risk.length > 0 || shape.minSize > 0 || shape.minAge >= 0 || shape.only

export function predicateOf(shape: Shape, on: RowSelectionState, typed: (text: string) => string) {
  const q = typed(shape.q.toLowerCase())
  const risks = new Set(shape.risk)
  const anyRisk = risks.size === 0
  const {minSize, minAge, only} = shape
  return (entry: Entry) =>
    entry.search.includes(q) &&
    (anyRisk || risks.has(entry.risk)) &&
    entry.bytes >= minSize &&
    (minAge < 0 || (entry.age ?? -1) >= minAge) &&
    (!only || on[entry.path] === true)
}

type Items = Db['scan']['items']['collection']

const shows = (shape: Shape, risk: Risk) => shape.risk.length === 0 || shape.risk.includes(risk)

function narrowed(i: Ref<Entry>, shape: Shape, own: ReturnType<typeof eq>) {
  return [
    own,
    ...(shape.minSize > 0 ? [gte(i.bytes, shape.minSize)] : []),
    ...(shape.minAge >= 0 ? [gte(i.age, shape.minAge)] : []),
  ].reduce((left, right) => and(left, right))
}

function riskRows(q: InitialQueryBuilder, items: Items, shape: Shape, risk: Risk) {
  return shows(shape, risk) ? q.from({i: items}).where(({i}) => narrowed(i, shape, eq(i.risk, risk))) : undefined
}

type From = ReturnType<typeof fromItems>

const fromItems = (q: InitialQueryBuilder, items: Items) => q.from({i: items})

const ORDER: Record<Sort, (rows: From) => From> = {
  'size-desc': rows => rows.orderBy(({i}) => i.bytes, 'desc'),
  'size-asc': rows => rows.orderBy(({i}) => i.bytes, 'asc'),
  'name-asc': rows => rows.orderBy(({i}) => i.order, {direction: 'asc', stringSort: 'lexical'}),
  'age-desc': rows => rows.orderBy(({i}) => i.age, {direction: 'desc', nulls: 'last'}),
  'age-asc': rows => rows.orderBy(({i}) => i.age, {direction: 'asc', nulls: 'last'}),
}

export interface SectionTotal {
  id: string
  count: number
  bytes: number
  selectable: number
  aged: number
  picked: number
  pickedExact: number
  pickedApparent: number
}

const UNFILTERED: Shape = {q: '', risk: [], minSize: 0, minAge: -1, sort: 'size-desc', only: false}

type Keep = ((row: Entry) => boolean) | null

function useKept(shape: Shape, on: RowSelectionState, typed: (text: string) => string): Keep {
  return useMemo(() => (shape.q === '' && !shape.only ? null : predicateOf(shape, on, typed)), [shape, on, typed])
}

type On = RowSelectionState | null

const emptyTotal = (id: string): SectionTotal => ({id, count: 0, bytes: 0, selectable: 0, aged: 0, picked: 0, pickedExact: 0, pickedApparent: 0})

function addTo(total: SectionTotal, row: Entry, on: On) {
  total.count += 1
  total.bytes += row.bytes
  total.selectable += row.selectable
  total.aged += Number(row.age !== null && row.age !== undefined)
  if (on === null || on[row.path] !== true) return
  total.picked += 1
  if (row.exact) total.pickedExact += row.bytes
  else total.pickedApparent += row.bytes
}

const skipsFor = (keep: Keep, open: SectionTotal | null) => (row: Entry) => row.section === open?.id || (keep !== null && !keep(row))

function totalIn(totals: Map<string, SectionTotal>, section: string) {
  const known = totals.get(section)
  if (known) return known
  const made = emptyTotal(section)
  totals.set(section, made)
  return made
}

function totalsOf(groups: readonly (readonly Entry[] | undefined)[], keep: Keep, on: On, open: SectionTotal | null): SectionTotal[] {
  const totals = new Map<string, SectionTotal>(open ? [[open.id, open]] : [])
  const skips = skipsFor(keep, open)
  for (const rows of groups) {
    for (const row of rows ?? []) if (!skips(row)) addTo(totalIn(totals, row.section), row, on)
  }
  return [...totals.values()]
}

function useRiskRows(items: Items, shape: Shape | null, risk: Risk) {
  return useLiveQuery(q => (shape === null ? undefined : riskRows(q, items, shape, risk))).data
}

function useTotalsOf(db: Db, shape: Shape | null, keep: Keep, on: On, open: SectionTotal | null) {
  const items = db.scan.items.collection
  const safe = useRiskRows(items, shape, 'safe')
  const review = useRiskRows(items, shape, 'review')
  const report = useRiskRows(items, shape, 'report')
  return useMemo(() => totalsOf([safe, review, report], keep, on, open), [safe, review, report, keep, on, open])
}

function keptOf(loaded: readonly Entry[], keep: Keep, on: On, id: string) {
  const rows: Entry[] = []
  const total = emptyTotal(id)
  for (const row of loaded) {
    if (keep !== null && !keep(row)) continue
    rows.push(row)
    addTo(total, row, on)
  }
  return {rows, total}
}

const NO_ROWS: Entry[] = []
const SORT_KEPT_MS = 5_000

function useOpenRows(db: Db, section: {id: string; risk: Risk} | null, shape: Shape) {
  const items = db.scan.items.collection
  return useLiveQuery({
    query: q => (section !== null && shows(shape, section.risk) ? ORDER[shape.sort](fromItems(q, items)).where(({i}) => narrowed(i, shape, eq(i.section, section.id))) : undefined),
    gcTime: SORT_KEPT_MS,
  })
}

function useNameOrderAhead(db: Db, settled: boolean) {
  const items = db.scan.items.collection
  useLiveQuery({
    query: q => (settled ? ORDER['name-asc'](fromItems(q, items)).where(({i}) => eq(i.section, '')) : undefined),
    gcTime: Infinity,
  })
}

export function useShaped(db: Db, section: {id: string; risk: Risk} | null, shape: Shape, on: RowSelectionState, settled: boolean) {
  useNameOrderAhead(db, settled)
  const filtering = isFiltering(shape)
  const keep = useKept(shape, on, textIn(db.loaded.platform).typed)
  const {data, isReady} = useOpenRows(db, section, shape)
  const loaded = data ?? NO_ROWS
  const id = section?.id ?? ''
  const kept = useMemo(() => (filtering ? keptOf(loaded, keep, on, id) : {rows: loaded, total: null}), [filtering, loaded, keep, on, id])
  const open = isReady && section !== null ? kept.total : null
  const all = useTotalsOf(db, UNFILTERED, null, null, null)
  const shown = useTotalsOf(db, filtering ? shape : null, keep, filtering ? on : null, open)
  return {all, shown: filtering ? shown : all, rows: kept.rows}
}
