import {useLiveQuery} from '@tanstack/react-db'
import {useNavigate} from '@tanstack/react-router'
import {useVirtualizer} from '@tanstack/react-virtual'
import {Trash2, Undo2} from 'lucide-react'
import {useMemo, useRef, type ReactNode} from 'react'
import {Badge} from '@/components/ui/badge'
import {Button} from '@/components/ui/button'
import {Checkbox} from '@/components/ui/checkbox'
import {Select, SelectContent, SelectItem, SelectTrigger, SelectValue} from '@/components/ui/select'
import {Tooltip, TooltipContent, TooltipTrigger} from '@/components/ui/tooltip'
import {counted, formatBytes, plural, tilde, type TrashEntry, type TrashState} from '@/lib/data'
import {useDb, type Action} from '@/lib/db'
import {useDecisions, useHome} from '@/lib/page-data'
import {usePlatform} from '@/lib/platform'
import type {TrashSearch} from '@/lib/search'
import {usePending} from '@/lib/views'
import {RequestError} from './request-error'

const ROW = 40
const HEAD = 44
export const BUSY: readonly Action[] = ['undo', 'empty']

export interface Run {
  id: string
  at: number
  entries: TrashEntry[]
  inTrash: TrashEntry[]
  bytes: number
}

type Line = {kind: 'run'; run: Run} | {kind: 'item'; entry: TrashEntry}

const stateOf = (putBack: string): Record<TrashState, [string, 'secondary' | 'outline' | 'destructive']> => ({
  trashed: ['In the Trash', 'secondary'],
  restored: ['Put back', 'outline'],
  'put-back': [putBack, 'outline'],
  emptied: ['Emptied', 'outline'],
  failed: ['Failed', 'destructive'],
})

const isTrashed = (entry: TrashEntry) => entry.state === 'trashed'
const sumOf = (entries: readonly TrashEntry[]) => entries.reduce((sum, e) => sum + e.bytes, 0)

export function whenOf(seconds: number) {
  return new Date(seconds * 1000).toLocaleString(undefined, {month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'})
}

function runsOf(entries: readonly TrashEntry[]): Run[] {
  const byRun = new Map<string, TrashEntry[]>()
  for (const entry of entries) byRun.set(entry.run, [...(byRun.get(entry.run) ?? []), entry])
  return [...byRun.entries()]
    .map(([id, mine]) => {
      const sorted = mine.toSorted((a, b) => b.bytes - a.bytes)
      const inTrash = sorted.filter(isTrashed)
      return {id, at: Math.max(...mine.map(e => e.at)), entries: sorted, inTrash, bytes: sumOf(inTrash)}
    })
    .toSorted((a, b) => b.at - a.at)
}

export function useTrashRuns() {
  const {data} = useLiveQuery(useDb().trash.collection)
  return useMemo(() => runsOf(data), [data])
}

export interface TrashActions {
  onPick: (ids: readonly string[], on: boolean) => void
  onUndo: (ids: readonly string[]) => void
  onEmpty: (target: string) => void
  onRun: (run: string) => void
  onRetry: (action: 'undo' | 'empty') => void
}

function picksAfter(pick: string, ids: readonly string[], on: boolean) {
  const picked = new Set(pick.split('.').filter(Boolean))
  for (const id of ids) {
    if (on) picked.add(id)
    else picked.delete(id)
  }
  return [...picked].join('.')
}

export function useTrashActions(): TrashActions {
  const navigate = useNavigate()
  const {trash, retryTrash} = useDecisions()
  return {
    onPick: (ids, on) => navigate({to: '/trash', search: prev => ({...prev, pick: picksAfter(prev.pick ?? '', ids, on)}), replace: true}),
    onUndo: ids => trash('undo', ids),
    onEmpty: target => navigate({to: '/trash/empty', search: prev => ({...prev, target})}),
    onRun: run => navigate({to: '/trash', search: prev => ({...prev, run, pick: ''})}),
    onRetry: retryTrash,
  }
}

export function pickedIn(runs: readonly Run[], search: TrashSearch) {
  const shown = search.run ? runs.filter(run => run.id === search.run) : runs
  const picked = new Set(search.pick.split('.').filter(Boolean))
  const inTrash = shown.flatMap(run => run.inTrash)
  return {shown, picked, inTrash, chosen: inTrash.filter(entry => picked.has(entry.id))}
}

function Icon({label, disabled, onClick, children}: {label: string; disabled: boolean; onClick: () => void; children: ReactNode}) {
  return (
    <Tooltip>
      <TooltipTrigger delay={80} render={<span className="inline-flex" />}>
        <Button variant="ghost" size="icon-xs" aria-label={label} disabled={disabled} onClick={onClick}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

function StateBadge({entry}: {entry: TrashEntry}) {
  const {putBack, bin} = usePlatform()
  const [said, variant] = stateOf(putBack)[entry.state]
  const text = bin(said)
  const badge = <Badge variant={variant}>{text}</Badge>
  if (!entry.reason) return badge
  return (
    <Tooltip>
      <TooltipTrigger delay={80} render={<span className="inline-flex min-w-0 items-center gap-1.5" />}>
        {badge}
        <span className={`truncate text-xs ${entry.state === 'failed' ? 'text-destructive' : 'text-amber-300'}`}>{entry.reason}</span>
      </TooltipTrigger>
      <TooltipContent className="max-w-sm">{entry.reason}</TooltipContent>
    </Tooltip>
  )
}

function ItemLine({entry, picked, busy, home, actions}: {entry: TrashEntry; picked: boolean; busy: boolean; home: string; actions: TrashActions}) {
  const live = isTrashed(entry)
  const {path, bin} = usePlatform()
  const shown = path(tilde(entry.original, home))
  return (
    <div className="grid h-full grid-cols-[1.5rem_minmax(0,1fr)_6rem_8rem_minmax(0,14rem)_3.5rem] items-center gap-3 border-b border-border/50 px-7 text-sm">
      <Checkbox aria-label={shown} checked={live && picked} disabled={!live} onCheckedChange={on => actions.onPick([entry.id], on)} />
      <span className="truncate font-mono text-xs" title={shown}>
        {shown}
      </span>
      <span className="text-right text-xs text-muted-foreground tabular-nums">{formatBytes(entry.bytes)}</span>
      <span className="text-xs text-muted-foreground tabular-nums">{whenOf(entry.at)}</span>
      <span className="flex min-w-0">
        <StateBadge entry={entry} />
      </span>
      <span className="flex justify-end gap-0.5">
        {live && (
          <>
            <Icon label="Undo: put it back" disabled={busy} onClick={() => actions.onUndo([entry.id])}>
              <Undo2 />
            </Icon>
            <Icon label={bin('Empty from the Trash…')} disabled={busy} onClick={() => actions.onEmpty(`item:${entry.id}`)}>
              <Trash2 />
            </Icon>
          </>
        )}
      </span>
    </div>
  )
}

function RunLine({run, current, picked, busy, actions}: {run: Run; current: boolean; picked: ReadonlySet<string>; busy: boolean; actions: TrashActions}) {
  const ids = run.inTrash.map(e => e.id)
  const on = ids.length > 0 && ids.every(id => picked.has(id))
  const some = !on && ids.some(id => picked.has(id))
  const {bin} = usePlatform()
  return (
    <div className="flex h-full items-center gap-3 border-b bg-muted/40 px-7 text-sm">
      <Checkbox aria-label={`Select the cleanup of ${whenOf(run.at)}`} checked={on} indeterminate={some} disabled={ids.length === 0} onCheckedChange={next => actions.onPick(ids, next)} />
      <span className="font-medium">
        Cleanup of {whenOf(run.at)}
        {current && <span className="text-muted-foreground"> · this cleanup</span>}
      </span>
      <span className="grow text-xs text-muted-foreground tabular-nums">
        {plural(run.inTrash.length, 'item', 'items')} {bin('in the Trash')} · {formatBytes(run.bytes)}
        {run.entries.length > run.inTrash.length && ` · ${counted(run.entries.length - run.inTrash.length)} no longer there`}
      </span>
      <Button variant="ghost" size="xs" disabled={busy || ids.length === 0} onClick={() => actions.onUndo(ids)}>
        <Undo2 /> Undo
      </Button>
      <Button variant="ghost" size="xs" disabled={busy || ids.length === 0} aria-haspopup="dialog" onClick={() => actions.onEmpty(`run:${run.id}`)}>
        <Trash2 /> Empty…
      </Button>
    </div>
  )
}

function linesOf(runs: readonly Run[]): Line[] {
  return runs.flatMap(run => [{kind: 'run' as const, run}, ...run.entries.map(entry => ({kind: 'item' as const, entry}))])
}

function Lines({runs, current, picked, busy, actions}: {runs: readonly Run[]; current: string; picked: ReadonlySet<string>; busy: boolean; actions: TrashActions}) {
  const home = useHome()
  const {bin} = usePlatform()
  const scroller = useRef<HTMLDivElement>(null)
  const lines = useMemo(() => linesOf(runs), [runs])
  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => scroller.current,
    estimateSize: index => (lines[index]?.kind === 'run' ? HEAD : ROW),
    getItemKey: index => {
      const line = lines[index]
      if (!line) return index
      return line.kind === 'run' ? `run:${line.run.id}` : line.entry.id
    },
    overscan: 12,
  })
  return (
    <div ref={scroller} className="min-h-0 grow overflow-y-auto">
      <div role="list" aria-label={bin('Items disk-clean moved to the Trash')} className="relative" style={{height: virtualizer.getTotalSize()}}>
        {virtualizer.getVirtualItems().map(virtual => {
          const line = lines[virtual.index]
          if (!line) return null
          return (
            <div key={virtual.key} role="listitem" className="absolute top-0 left-0 w-full" style={{height: virtual.size, transform: `translateY(${virtual.start}px)`}}>
              {line.kind === 'run' ? (
                <RunLine run={line.run} current={line.run.id === current} picked={picked} busy={busy} actions={actions} />
              ) : (
                <ItemLine entry={line.entry} picked={picked.has(line.entry.id)} busy={busy} home={home} actions={actions} />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

const ALL = '__all__'

function RunFilter({runs, value, onRun}: {runs: readonly Run[]; value: string; onRun: (run: string) => void}) {
  const label = (id: string) => {
    const run = runs.find(r => r.id === id)
    return run ? `Cleanup of ${whenOf(run.at)}` : 'All cleanups'
  }
  return (
    <Select value={value || ALL} onValueChange={next => onRun(next === ALL || next === null ? '' : next)}>
      <SelectTrigger size="sm" aria-label="Show cleanup" className="w-56">
        <SelectValue>{(id: string) => label(id)}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>All cleanups</SelectItem>
        {runs.map(run => (
          <SelectItem key={run.id} value={run.id}>
            {label(run.id)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function Empty({filtered, onAll}: {filtered: boolean; onAll: () => void}) {
  const {bin} = usePlatform()
  return (
    <div className="flex grow flex-col items-center justify-center gap-3 p-10 text-center text-sm text-muted-foreground">
      <p>{bin(filtered ? 'This cleanup put nothing in the Trash.' : 'Nothing disk-clean moved to the Trash yet.')}</p>
      {filtered && (
        <Button variant="outline" size="sm" onClick={onAll}>
          Show all cleanups
        </Button>
      )}
    </div>
  )
}

export function TrashView({search, actions}: {search: TrashSearch; actions: TrashActions}) {
  const db = useDb()
  const runs = useTrashRuns()
  const busy = usePending(db, BUSY)
  const {shown, picked, inTrash, chosen} = useMemo(() => pickedIn(runs, search), [runs, search])
  const chosenIds = chosen.map(entry => entry.id)
  const picking = !busy && chosen.length > 0
  const {bin} = usePlatform()
  return (
    <div className="flex min-h-0 grow flex-col">
      <div className="flex h-12 shrink-0 items-center gap-3 border-b px-7">
        <RunFilter runs={runs} value={search.run} onRun={actions.onRun} />
        <span className="w-72 shrink-0 truncate text-sm tabular-nums">
          {plural(inTrash.length, 'item', 'items')} {bin('in the Trash')} · {formatBytes(sumOf(inTrash))}
        </span>
        <span className="w-40 shrink-0 text-sm text-muted-foreground tabular-nums">{counted(chosen.length)} selected</span>
        <div className="flex min-w-0 grow justify-end gap-2">
          <RequestError db={db} action="undo" onRetry={() => actions.onRetry('undo')} />
          <RequestError db={db} action="empty" onRetry={() => actions.onRetry('empty')} />
        </div>
        <Button variant="outline" size="sm" disabled={!picking} onClick={() => actions.onUndo(chosenIds)}>
          <Undo2 /> Undo selected
        </Button>
        <Button variant="destructive" size="sm" disabled={!picking} aria-haspopup="dialog" onClick={() => actions.onEmpty('')}>
          <Trash2 /> Empty selected…
        </Button>
      </div>
      {shown.length === 0 ? (
        <Empty filtered={search.run !== ''} onAll={() => actions.onRun('')} />
      ) : (
        <Lines runs={shown} current={db.loaded.run ?? ''} picked={picked} busy={busy} actions={actions} />
      )}
    </div>
  )
}
