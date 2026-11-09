import {useDebouncer} from '@tanstack/react-pacer/debouncer'
import {Link, useNavigate, useParams} from '@tanstack/react-router'
import type {RowSelectionState, Updater} from '@tanstack/react-table'
import {LayoutGrid, List, Search} from 'lucide-react'
import {createContext, use, useMemo, useRef, useState, type ReactNode, type RefObject} from 'react'
import {Badge} from '@/components/ui/badge'
import {Button, buttonVariants} from '@/components/ui/button'
import {Checkbox} from '@/components/ui/checkbox'
import {Input} from '@/components/ui/input'
import {Kbd} from '@/components/ui/kbd'
import {Select, SelectContent, SelectItem, SelectTrigger, SelectValue} from '@/components/ui/select'
import {ToggleGroup, ToggleGroupItem} from '@/components/ui/toggle-group'
import {counted, formatBytes, isPickable, RISK_LABEL, type Risk} from '@/lib/data'
import {useDb, type Db} from '@/lib/db'
import type {CleanupProgress, Removal} from '@/lib/progress'
import type {CategoryHead, Entry as Item} from '@/lib/scan-feed'
import {CLEANUP_DEFAULTS, MIN_AGES, MIN_SIZES, NO_FILTERS, RISKS, SORTS, type CleanupSearch, type Sort, type View} from '@/lib/search'
import {STATE_MOTION, useReveal} from '@/lib/motion'
import {useProgress, useSelection, type Selection} from '@/lib/page-data'
import {usePlatform} from '@/lib/platform'
import {isFiltering, predicateOf, useShaped, type SectionTotal} from '@/lib/shaping'
import {useScanState, useSections} from '@/lib/views'
import {DataTable} from './data-table'

const GROUPS: [string, Risk][] = [
  ['Safe to delete', 'safe'],
  ['Review first', 'review'],
  ['Report only', 'report'],
]
const RISK_BADGE: Record<Risk, string> = {
  safe: 'bg-emerald-500/15 text-emerald-300',
  review: 'bg-amber-500/15 text-amber-300',
  report: 'bg-muted text-muted-foreground',
}
export const RISK_BAR: Record<Risk, string> = {safe: 'bg-blue-400', review: 'bg-amber-500', report: 'bg-zinc-600'}
export const SORT_LABEL: Record<Sort, string> = {
  'size-desc': 'Largest first',
  'size-asc': 'Smallest first',
  'name-asc': 'Name',
  'age-desc': 'Oldest first',
  'age-asc': 'Newest first',
}
export const SIZE_LABEL = (n: number) => (n === 0 ? 'Any size' : `≥ ${formatBytes(n)}`)
export const AGE_LABEL = (n: number) => (n === -1 ? 'Any age' : `Idle ${n}+ days`)
export const QUICK_SELECT_MIN = 4
export const toggled = (risks: readonly Risk[], risk: Risk) => (risks.includes(risk) ? risks.filter(r => r !== risk) : [...risks, risk])

const SEARCH_WAIT = 150

interface Section extends CategoryHead {
  count: number
  bytes: number
}

interface Shown {
  count: number
  bytes: number
  selectable: number
  aged: number
  picked: number
}

export interface Group {
  category: Section
  shown: Shown
}

type Keep = (entry: Item) => boolean

export type Choose = (section: string | null, wanted: Keep) => void

function sectionProgress(removal: Removal | undefined, total: number) {
  const done = removal?.count ?? 0
  const restored = removal?.restored ?? 0
  if (restored === 0) return `${done} of ${total} done`
  return done === 0 ? `${restored} restored` : `${done} of ${total} done · ${restored} restored`
}

function onlyRestored(removal: Removal | undefined) {
  return removal !== undefined && removal.count === 0 && removal.restored > 0
}

interface Progressed {
  progress: CleanupProgress
  removals: ReadonlyMap<string, Removal>
}

function planned(section: string, progressed: Progressed) {
  return progressed.progress.plan.sections.find(s => s.id === section)
}

function pickedLabel({category, shown}: Group, progressed: Progressed | null) {
  if (category.risk === 'report') return `${counted(shown.count)} listed`
  if (progressed) {
    const plan = planned(category.id, progressed)
    return plan ? sectionProgress(progressed.removals.get(category.id), plan.count) : 'not approved'
  }
  return `${counted(shown.picked)}/${counted(shown.selectable)}`
}

function SectionCheckbox({group, locked, choose}: {group: Group; locked: boolean; choose: Choose}) {
  const {category, shown} = group
  if (category.risk === 'report') return null
  if (shown.selectable === 0) return <span className="mt-0.5 size-4 shrink-0" />
  const all = shown.picked >= shown.selectable
  return (
    <Checkbox
      aria-label={`Select all in ${category.title}`}
      checked={all}
      indeterminate={shown.picked > 0 && !all}
      disabled={locked}
      onCheckedChange={() => choose(category.id, () => !all)}
      className="mt-0.5"
    />
  )
}

function SectionBar({group, max, progressed}: {group: Group; max: number; progressed: Progressed | null}) {
  const {category} = group
  if (!progressed) {
    return (
      <span className="h-[3px] grow overflow-hidden rounded-full bg-zinc-800">
        <span className={`block h-[3px] ${RISK_BAR[category.risk]}`} style={{width: `${Math.max(2, (group.shown.bytes / max) * 100)}%`}} />
      </span>
    )
  }
  const plan = planned(category.id, progressed)
  const removal = progressed.removals.get(category.id)
  const share = plan && plan.bytes > 0 ? Math.min(1, (removal?.bytes ?? 0) / plan.bytes) : 0
  return (
    <span
      role="progressbar"
      aria-label={`${category.title} done`}
      aria-valuetext={plan ? sectionProgress(removal, plan.count) : undefined}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(share * 100)}
      className="h-[3px] grow overflow-hidden rounded-full bg-zinc-800"
    >
      <span
        className={`block h-[3px] origin-left transition-transform duration-(--duration-very-slow) ease-(--ease-smooth-out) motion-reduce:transition-none ${onlyRestored(removal) ? 'bg-muted-foreground' : RISK_BAR[category.risk]}`}
        style={{transform: `scaleX(${share})`}}
      />
    </span>
  )
}

function QuickSelect({group, choose}: {group: Group; choose: Choose}) {
  const {category, shown} = group
  const few = shown.selectable < QUICK_SELECT_MIN
  const idle = (days: number) => () => choose(category.id, entry => (entry.age ?? -1) >= days)
  return (
    <div className={`flex items-center gap-1 text-xs text-muted-foreground ${few ? 'invisible' : ''}`} inert={few}>
      <span className="pr-1">Select:</span>
      <Button size="xs" variant="ghost" onClick={() => choose(category.id, () => true)}>
        all {counted(shown.selectable)}
      </Button>
      {shown.aged > 0 && (
        <Button size="xs" variant="ghost" onClick={idle(90)}>
          idle 90+ days
        </Button>
      )}
      {shown.aged > 0 && (
        <Button size="xs" variant="ghost" onClick={idle(365)}>
          idle 1+ year
        </Button>
      )}
      <Button size="xs" variant="ghost" onClick={() => choose(category.id, () => false)}>
        none
      </Button>
    </div>
  )
}

export type ChangeList = (patch: Partial<CleanupSearch>, how?: {replace: boolean}) => void

function SectionLink({section, ...props}: {section: string; className?: string; children?: ReactNode}) {
  return <Link to="/cleanup/$section" params={{section}} search activeOptions={{includeSearch: false}} {...props} />
}

const OPEN_SECTION = 'has-[a[data-status=active]]:border-zinc-700 has-[a[data-status=active]]:bg-zinc-900'
const DEFAULT_SECTION = '[&:not(:has(a[data-status=active]))_[data-default]]:border-zinc-700 [&:not(:has(a[data-status=active]))_[data-default]]:bg-zinc-900'

function SectionButton({group, first, max, progressed, choose}: {group: Group; first: boolean; max: number; progressed: Progressed | null; choose: Choose}) {
  const {category, shown} = group
  const lit = !progressed && shown.picked > 0
  return (
    <div data-default={first || undefined} className={`flex items-start gap-2.5 rounded-lg border p-2.5 ${STATE_MOTION} ${lit ? 'border-blue-400/35 bg-blue-400/5' : 'border-transparent'} ${OPEN_SECTION}`}>
      <SectionCheckbox group={group} locked={progressed !== null} choose={choose} />
      <SectionLink section={category.id} className="flex grow flex-col gap-1.5 text-left">
        <span className="flex w-full items-baseline gap-2">
          <span className="grow text-[13px] font-medium">{category.title}</span>
          <span className="text-[13px] font-semibold whitespace-nowrap tabular-nums">{formatBytes(shown.bytes)}</span>
        </span>
        <span className="flex w-full items-center gap-2">
          <SectionBar group={group} max={max} progressed={progressed} />
          <span className="text-[11px] text-muted-foreground">{pickedLabel(group, progressed)}</span>
        </span>
      </SectionLink>
    </div>
  )
}

function ListView({groups, progressed, choose, children}: {groups: Group[]; progressed: Progressed | null; choose: Choose; children: ReactNode}) {
  const max = Math.max(1, ...groups.map(g => g.shown.bytes))
  const first = groups[0]?.category.id
  return (
    <div className="flex min-h-0 grow">
      <nav aria-label="Sections" className={`flex w-80 shrink-0 flex-col gap-3.5 overflow-auto border-r px-3 py-4 ${DEFAULT_SECTION}`}>
        {GROUPS.map(([label, risk]) => {
          const inGroup = groups.filter(g => g.category.risk === risk)
          if (inGroup.length === 0) return null
          return (
            <div key={risk} className="flex flex-col gap-1.5">
              <div className="px-1 pb-0.5 text-[11px] font-medium tracking-wider text-muted-foreground/70 uppercase">{label}</div>
              {inGroup.map(group => (
                <SectionButton key={group.category.id} group={group} first={group.category.id === first} max={max} progressed={progressed} choose={choose} />
              ))}
            </div>
          )
        })}
      </nav>
      {children}
    </div>
  )
}

function SectionPanel({group, view}: {group: Group; view: ListState}) {
  const {category, shown} = group
  const replay = useReveal(category.id)
  return (
    <main key={category.id} data-replay={replay || undefined} data-open="true" className="t-panel-slide flex min-w-0 grow flex-col">
      <div className="flex flex-col gap-2.5 border-b px-6 pt-4 pb-3">
        <div className="flex items-center gap-2.5">
          <h2 className="text-lg font-semibold tracking-tight">{category.title}</h2>
          <Badge className={RISK_BADGE[category.risk]}>{RISK_LABEL[category.risk]}</Badge>
          <span className="grow" />
          <span className="text-[13px] text-muted-foreground tabular-nums">
            {formatBytes(shown.bytes)} · {counted(shown.count)} of {counted(category.count)} shown
          </span>
        </div>
        <p className="text-[13px] text-muted-foreground">{category.desc}</p>
        {!view.progressed && <QuickSelect group={group} choose={view.choose} />}
      </div>
      <DataTable
        key={category.id}
        rows={view.rows}
        label={category.title}
        progress={view.progressed?.progress ?? null}
        rowSelection={view.on}
        onRowSelectionChange={view.setRowSelection}
      />
    </main>
  )
}

function LearnChevron() {
  return (
    <span className="t-learn-chevron">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round">
        <path className="t-learn-arm t-learn-arm-top" d="M6 4L10 8" />
        <path className="t-learn-arm t-learn-arm-bot" d="M10 8L6 12" />
      </svg>
    </span>
  )
}

function SectionCard({group, progressed, choose}: {group: Group; progressed: Progressed | null; choose: Choose}) {
  const {category, shown} = group
  const lit = !progressed && shown.picked > 0
  return (
    <div className={`flex flex-col gap-3 rounded-xl border p-4 ${STATE_MOTION} ${lit ? 'border-blue-400/45 bg-blue-400/5' : 'bg-card'} has-[a[data-status=active]]:ring-2 has-[a[data-status=active]]:ring-blue-400/60`}>
      <div className="flex items-center gap-2.5">
        <SectionCheckbox group={group} locked={progressed !== null} choose={choose} />
        <span className="grow text-sm font-medium">{category.title}</span>
        <Badge className={RISK_BADGE[category.risk]}>{RISK_LABEL[category.risk]}</Badge>
      </div>
      <div className="flex items-baseline gap-2">
        <span className="text-2xl font-semibold tracking-tight tabular-nums">{formatBytes(shown.bytes)}</span>
        <span className="text-xs text-muted-foreground">{pickedLabel(group, progressed)}</span>
      </div>
      <p className="grow text-xs leading-relaxed text-muted-foreground">{category.desc}</p>
      <SectionLink section={category.id} className={buttonVariants({variant: 'link', size: 'xs', className: 't-learn self-start px-0 data-[status=active]:no-underline'})}>
        <span className="in-data-[status=active]:hidden">Show items</span>
        <span className="hidden in-data-[status=active]:inline">Items shown below</span> <LearnChevron />
      </SectionLink>
    </div>
  )
}

function CardsView({groups, progressed, choose, children}: {groups: Group[]; progressed: Progressed | null; choose: Choose; children: ReactNode}) {
  return (
    <div className="flex min-h-0 grow flex-col gap-5 overflow-auto px-7 py-5">
      {GROUPS.map(([label, risk]) => {
        const inGroup = groups.filter(g => g.category.risk === risk)
        if (inGroup.length === 0) return null
        return (
          <section key={risk} className="flex flex-col gap-2.5">
            <h3 className="text-[11px] font-medium tracking-wider text-muted-foreground/70 uppercase">{label}</h3>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3">
              {inGroup.map(group => (
                <SectionCard key={group.category.id} group={group} progressed={progressed} choose={choose} />
              ))}
            </div>
          </section>
        )
      })}
      {children}
    </div>
  )
}

function FilterSelect<T extends string | number>({label, value, options, render, onChange}: {label: string; value: T; options: readonly T[]; render: (value: T) => string; onChange: (value: T) => void}) {
  return (
    <Select value={String(value)} onValueChange={v => onChange(options.find(o => String(o) === v) ?? value)}>
      <SelectTrigger size="sm" aria-label={label}>
        <SelectValue>{() => render(value)}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {options.map(option => (
          <SelectItem key={option} value={String(option)}>
            {render(option)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function useTyped(value: string) {
  const [typed, setTyped] = useState(value)
  const [seen, setSeen] = useState(value)
  const [sent, setSent] = useState(value)
  if (seen !== value) {
    setSeen(value)
    if (value !== sent) setTyped(value)
  }
  return {typed, setTyped, setSent}
}

function SearchBox({value, onChange, inputRef}: {value: string; onChange: (q: string) => void; inputRef: RefObject<HTMLInputElement | null>}) {
  const {typed, setTyped, setSent} = useTyped(value)
  const {label} = usePlatform()
  const send = (q: string) => {
    setSent(q)
    onChange(q)
  }
  const later = useDebouncer(send, {wait: SEARCH_WAIT})
  return (
    <div className="relative w-44 shrink xl:w-72">
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        ref={inputRef}
        value={typed}
        onChange={e => {
          setTyped(e.target.value)
          later.maybeExecute(e.target.value)
        }}
        onBlur={() => later.flush()}
        onKeyDown={e => {
          if (e.key !== 'Escape') return
          later.cancel()
          setTyped('')
          send('')
          e.currentTarget.blur()
        }}
        placeholder="Filter paths…"
        aria-label="Filter paths"
        className="pr-8 pl-8"
      />
      <Kbd className="absolute top-1/2 right-2 -translate-y-1/2">{label('/')}</Kbd>
    </div>
  )
}

function Toggle({on, label, onClick}: {on: boolean; label: string; onClick: () => void}) {
  return (
    <Button size="sm" variant={on ? 'secondary' : 'outline'} aria-pressed={on} onClick={onClick}>
      {label}
    </Button>
  )
}

function Toolbar({list, onList, onSearch, searchRef}: {list: CleanupSearch; onList: ChangeList; onSearch: (q: string) => void; searchRef: RefObject<HTMLInputElement | null>}) {
  return (
    <div className="flex items-center gap-2 border-b px-7 py-3">
      <SearchBox value={list.q} onChange={onSearch} inputRef={searchRef} />
      {RISKS.map(risk => (
        <Toggle key={risk} on={list.risk.includes(risk)} label={RISK_LABEL[risk]} onClick={() => onList({risk: toggled(list.risk, risk)})} />
      ))}
      <FilterSelect label="Minimum size" value={list.minSize} options={MIN_SIZES} render={SIZE_LABEL} onChange={minSize => onList({minSize})} />
      <FilterSelect label="Minimum idle time" value={list.minAge} options={MIN_AGES} render={AGE_LABEL} onChange={minAge => onList({minAge})} />
      <FilterSelect label="Sort" value={list.sort} options={SORTS} render={s => SORT_LABEL[s]} onChange={sort => onList({sort})} />
      <Toggle on={list.only} label="Only selected" onClick={() => onList({only: !list.only})} />
      <span className="grow" />
      <ToggleGroup value={[list.view]} onValueChange={v => v[0] && onList({view: v[0] as View})} variant="outline" size="sm" aria-label="View">
        <ToggleGroupItem value="list" aria-label="List view">
          <List /> List
        </ToggleGroupItem>
        <ToggleGroupItem value="cards" aria-label="Card view">
          <LayoutGrid /> Cards
        </ToggleGroupItem>
      </ToggleGroup>
    </div>
  )
}

function chosen(db: Db, section: string | null, keep: Keep, wanted: Keep, old: RowSelectionState) {
  const next = {...old}
  const groups = section === null ? [...db.scan.bySection.values()] : [db.scan.bySection.get(section)]
  for (const group of groups) {
    for (const entry of group?.items.values() ?? []) {
      if (!isPickable(entry) || !keep(entry)) continue
      if (wanted(entry)) next[entry.path] = true
      else delete next[entry.path]
    }
  }
  return next
}

function shadowOf(db: Db, keep: Keep) {
  const items = db.scan.items.synced
  const inner = new Map<string, Item>()
  for (const nest of db.scan.nests.synced.values()) {
    const outer = items.get(nest.outer)
    const inside = items.get(nest.inner)
    if (outer && inside && outer.section === inside.section && keep(outer) && keep(inside)) inner.set(inside.path, inside)
  }
  const bySection = new Map<string, number>()
  for (const entry of inner.values()) bySection.set(entry.section, (bySection.get(entry.section) ?? 0) + entry.bytes)
  return bySection
}

function sectionsOf(heads: readonly CategoryHead[], totals: readonly {id: string; count: number; bytes: number}[]): Section[] {
  const byId = new Map(totals.map(total => [total.id, total]))
  return heads
    .flatMap(head => {
      const total = byId.get(head.id)
      return total ? [{...head, count: total.count, bytes: total.bytes}] : []
    })
    .toSorted((a, b) => b.bytes - a.bytes)
}

interface Shaping {
  totals: readonly SectionTotal[]
  shadow: ReadonlyMap<string, number>
  picked: ReadonlyMap<string, number> | null
}

function groupsOf(sections: readonly Section[], {totals, shadow, picked}: Shaping): Group[] {
  const byId = new Map(totals.map(total => [total.id, total]))
  return GROUPS.flatMap(([, risk]) =>
    sections.filter(c => c.risk === risk).flatMap(category => {
      const total = byId.get(category.id)
      if (!total || total.count === 0) return []
      const bytes = total.bytes - (shadow.get(category.id) ?? 0)
      return [{category, shown: {count: total.count, bytes, selectable: total.selectable, aged: total.aged, picked: picked === null ? total.picked : (picked.get(category.id) ?? 0)}}]
    }),
  )
}

export function useListChange(): ChangeList {
  const navigate = useNavigate()
  return (patch, how) => navigate({to: '.', search: prev => ({...prev, ...patch}), replace: how?.replace})
}

interface ListState {
  groups: Group[]
  progressed: Progressed | null
  list: CleanupSearch
  onList: ChangeList
  listed: ReadonlySet<string>
  rows: readonly Item[]
  selected: number
  on: RowSelectionState
  setRowSelection: (update: Updater<RowSelectionState>) => void
  choose: Choose
}

const ListContext = createContext<ListState | null>(null)

export interface Listing {
  list: CleanupSearch
  groups: Group[]
  listed: ReadonlySet<string>
  rows: readonly Item[]
  choose: Choose
  search: RefObject<HTMLInputElement | null>
}

export const ListingContext = createContext<Listing | null>(null)

export function useListing(db: Db, list: CleanupSearch, selection: Selection): Listing {
  const on = selection.rowSelection
  const {typed} = usePlatform()
  const keep = useMemo(() => predicateOf(list, on, typed), [list, on, typed])
  const search = useRef<HTMLInputElement>(null)
  const heads = useSections(db)
  const section = useParams({strict: false, select: params => params.section})
  const open = useMemo(() => heads.find(head => head.id === section) ?? null, [heads, section])
  const scan = useScanState(db)
  const {all, shown: totals, rows} = useShaped(db, open, list, on, scan.done || scan.error !== '' || scan.stopped)
  const sections = useMemo(() => sectionsOf(heads, all), [heads, all])
  const filtering = isFiltering(list)
  const items = db.scan.items.version()
  const nests = db.scan.nests.version()
  const shadow = useMemo(() => shadowOf(db, keep), [db, keep, items, nests])
  const listed = useMemo(() => new Set(sections.filter(section => section.count > 0).map(section => section.id)), [sections])
  const choose: Choose = (section, wanted) => selection.setRowSelection(old => chosen(db, section, keep, wanted, old))
  return {list, groups: groupsOf(sections, {totals, shadow, picked: filtering ? null : selection.picked}), listed, rows, choose, search}
}

function Body({groups, list, progressed, choose, children}: {groups: Group[]; list: CleanupSearch; progressed: Progressed | null; choose: Choose; children: ReactNode}) {
  if (groups.length === 0) return <div className="flex min-h-0 grow flex-col">{children}</div>
  if (list.view === 'list') {
    return (
      <ListView groups={groups} progressed={progressed} choose={choose}>
        {children}
      </ListView>
    )
  }
  return (
    <CardsView groups={groups} progressed={progressed} choose={choose}>
      {children}
    </CardsView>
  )
}

export function Cleanup({children}: {children: ReactNode}) {
  const listing = use(ListingContext)
  const selection = useSelection()
  const {progress} = useProgress()
  const onList = useListChange()
  const replay = useReveal(listing?.list.view ?? CLEANUP_DEFAULTS.view)
  if (!listing) return null
  const {list, groups, listed, rows, choose, search} = listing
  const progressed = progress?.active ? {progress, removals: progress.removals} : null
  const on = selection.rowSelection

  return (
    <ListContext value={{groups, progressed, list, onList, listed, rows, selected: selection.selected.length, on, setRowSelection: selection.setRowSelection, choose}}>
      <div className="flex min-h-0 grow flex-col">
        <Toolbar
          list={list}
          onList={onList}
          onSearch={q => onList({q}, {replace: true})}
          searchRef={search}
        />
        <div key={list.view} data-replay={replay || undefined} data-open="true" className="t-panel-slide flex min-h-0 grow flex-col">
          <Body groups={groups} list={list} progressed={progressed} choose={choose}>
            {children}
          </Body>
        </div>
      </div>
    </ListContext>
  )
}

type Empty = 'scanning' | 'unselected' | 'filtered' | 'nothing'

function emptyOf(view: ListState, section: string, scanning: boolean): Empty {
  if (scanning && !view.listed.has(section)) return 'scanning'
  if (view.list.only && view.selected === 0) return 'unselected'
  if (isFiltering(view.list)) return 'filtered'
  return 'nothing'
}

const SCANNING = "Scanning… items appear here as they're found."

const EMPTY_TEXT: Record<Exclude<Empty, 'scanning'>, string> = {
  unselected: 'Nothing is selected.',
  filtered: 'Nothing matches these filters.',
  nothing: 'Nothing to clean up.',
}

const EMPTY_ACTION: Partial<Record<Empty, {label: string; patch: Partial<CleanupSearch>}>> = {
  unselected: {label: 'Show all items', patch: {only: false}},
  filtered: {label: 'Clear filters', patch: NO_FILTERS},
}

function EmptyText({cause, inSection}: {cause: Empty; inSection: boolean}) {
  if (cause === 'scanning') {
    return (
      <p className="t-shimmer" data-text={SCANNING}>
        {SCANNING}
      </p>
    )
  }
  return <p>{cause === 'filtered' && inSection ? 'Nothing in this section matches these filters.' : EMPTY_TEXT[cause]}</p>
}

function EmptyState({view, section}: {view: ListState; section: string}) {
  const scan = useScanState(useDb())
  const cause = emptyOf(view, section, !scan.done && scan.error === '' && !scan.stopped)
  const action = EMPTY_ACTION[cause]
  return (
    <div className="flex grow flex-col items-center justify-center gap-3 p-10 text-center text-sm text-muted-foreground">
      <EmptyText cause={cause} inSection={view.groups.length > 0} />
      {action && (
        <Button variant="outline" size="sm" onClick={() => view.onList(action.patch)}>
          {action.label}
        </Button>
      )}
    </div>
  )
}

export function SectionDetail({section, framed}: {section: string; framed: boolean}) {
  const view = use(ListContext)
  const group = view?.groups.find(g => g.category.id === section)
  if (!view) return null
  if (!group) return <EmptyState view={view} section={section} />
  const panel = <SectionPanel group={group} view={view} />
  return framed ? <div className="flex h-[32rem] shrink-0 flex-col overflow-hidden rounded-xl border bg-card">{panel}</div> : panel
}
