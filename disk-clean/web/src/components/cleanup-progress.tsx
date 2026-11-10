import {Activity, Clapperboard, Trash2, Undo2} from 'lucide-react'
import {useVirtualizer} from '@tanstack/react-virtual'
import {useNavigate, useSearch} from '@tanstack/react-router'
import {memo, useMemo, useRef, type ReactNode, type Ref, type RefObject} from 'react'
import {Button} from '@/components/ui/button'
import {Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle} from '@/components/ui/sheet'
import {ToggleGroup, ToggleGroupItem} from '@/components/ui/toggle-group'
import {counted, formatBytes, plural, tilde} from '@/lib/data'
import {useHome} from '@/lib/page-data'
import {usePlatform} from '@/lib/platform'
import type {Db} from '@/lib/db'
import {formatDuration, heroBytes, isPutBack, jobRunning, useMovie, type CleanupProgress, type Outcome, type Phase} from '@/lib/progress'
import {useBack} from '@/lib/navigation'
import {LOG_FILTERS, type LogFilter, type Overlay} from '@/lib/search'
import {useReducedMotion} from '@/lib/motion'
import {CleanupFilm} from './cleanup-film'
import LatticeLoader from './react-bits/lattice-loader'
import {SpinningBytes} from './numbers'

const LOG_ROW_HEIGHT = 52
const LOG_OVERSCAN = 10
const WAITING = 'Approved · waiting for Claude to run it'
const QUEUED = 'Approved · queued until the cleanup before it finishes'

const FILTERS: Record<LogFilter, (o: Outcome) => boolean> = {
  all: () => true,
  removed: o => o.kind === 'removed' || o.kind === 'trashed' || o.kind === 'emptied' || o.kind === 'restored',
  problems: o => o.kind === 'failed' || o.kind === 'kept',
  commands: o => o.key.startsWith('cmd:'),
}

const FILTER_LABEL: Record<LogFilter, string> = {all: 'All', removed: 'Removed', problems: 'Problems', commands: 'Commands'}

function signedBytes(n: number) {
  return `${n < 0 ? '−' : '+'}${formatBytes(Math.abs(n))}`
}

function share(progress: CleanupProgress) {
  const {cleanup, handled, count, total, plan} = progress
  if (cleanup.job && !cleanup.job.done) return cleanup.job.bytes > 0 ? Math.min(1, handled / cleanup.job.bytes) : 0
  if (cleanup.done) return 1
  const bytes = plan.approved > 0 ? handled / plan.approved : 0
  return Math.min(1, Math.max(bytes, total > 0 ? count / total : 0))
}

function problemCount(n: number, label: string, tone: string) {
  return (
    <span className={n > 0 ? tone : undefined}>
      {' · '}
      {counted(n)} {label}
    </span>
  )
}

function Problems({progress}: {progress: CleanupProgress}) {
  const latest = [...progress.byKey.values()]
  return (
    <>
      {problemCount(latest.filter(o => o.kind === 'kept').length, 'kept', 'text-amber-300')}
      {problemCount(latest.filter(o => o.kind === 'failed').length, 'not removed', 'text-red-300')}
    </>
  )
}

function TrashedText({progress}: {progress: CleanupProgress}) {
  const {bin} = usePlatform()
  return (
    <>
      {bin('Moved to Trash')} {formatBytes(progress.inTrash.bytes)} · undo available
      {progress.freed > 0 && ` · freed ${formatBytes(progress.freed)}`}
      <Problems progress={progress} />
    </>
  )
}

function FinishedText({progress}: {progress: CleanupProgress}) {
  const {bin} = usePlatform()
  const latest = [...progress.byKey.values()]
  if (progress.restored > 0) {
    return (
      <>
        Put back {formatBytes(progress.restored)} · {bin('nothing left in the Trash')}
        {progress.freed > 0 && ` · freed ${formatBytes(progress.freed)}`}
        <Problems progress={progress} />
      </>
    )
  }
  const removed = latest.filter(o => o.kind === 'removed' || o.kind === 'emptied').length
  return (
    <>
      Freed {formatBytes(progress.freed)} · {counted(removed)} removed
      <Problems progress={progress} />
    </>
  )
}

const JOB_VERB = {empty: 'Emptying from the Trash', undo: 'Putting back'}

function JobText({progress}: {progress: CleanupProgress}) {
  const job = progress.cleanup.job
  const {bin} = usePlatform()
  if (!job) return null
  return (
    <>
      {bin(JOB_VERB[job.kind])} · {formatBytes(progress.handled)} of {formatBytes(job.bytes)} · {plural(job.count, 'item', 'items')}
    </>
  )
}

function AbandonedText({progress, reason}: {progress: CleanupProgress; reason: string}) {
  if (!progress.cleanup.started) return <span className="text-red-300">The cleanup did not start · {reason}</span>
  return (
    <span className="text-red-300">
      The cleanup stopped · {reason} · freed {formatBytes(progress.freed)}
    </span>
  )
}

const LOST = 'Lost contact with disk-clean: the cleanup keeps running; reload to reconnect'

const LINK_TEXT = {reconnecting: 'Reconnecting to disk-clean…', lost: LOST}

const WORKING = {trashing: 'Moving to the Trash', deleting: 'Deleting'}

function WorkingText({progress, verb}: {progress: CleanupProgress; verb: string}) {
  const last = progress.outcomes.at(-1)
  const {path, bin} = usePlatform()
  return (
    <>
      {bin(verb)} · {formatBytes(progress.handled)} of {formatBytes(progress.plan.approved)} · {counted(progress.count)} of {counted(progress.total)}
      {last && <span className="text-muted-foreground"> · {path(last.label)}</span>}
    </>
  )
}

export function BarText({progress, phase}: {progress: CleanupProgress; phase: Phase}) {
  if (progress.link !== 'live') return <span className="text-red-300">{LINK_TEXT[progress.link]}</span>
  if (phase === 'undoing' || phase === 'emptying') return <JobText progress={progress} />
  if (phase === 'trashed') return <TrashedText progress={progress} />
  if (phase === 'finished') return <FinishedText progress={progress} />
  if (phase === 'stopped') return <AbandonedText progress={progress} reason={progress.cleanup.abandoned?.reason ?? ''} />
  if (phase === 'trashing' || phase === 'deleting') return <WorkingText progress={progress} verb={WORKING[phase]} />
  return <span className="t-pulse">{phase === 'queued' ? QUEUED : WAITING}</span>
}

export function ProgressTrack({progress, phase}: {progress: CleanupProgress; phase: Phase}) {
  const waiting = phase === 'waiting' || phase === 'queued'
  return (
    <span aria-hidden className="absolute inset-x-0 -bottom-px h-[3px] overflow-hidden bg-zinc-800">
      <span
        className={`block size-full origin-left bg-blue-500 transition-transform duration-(--duration-very-slow) ease-(--ease-smooth-out) motion-reduce:transition-none ${waiting ? 't-pulse' : ''}`}
        style={{transform: `scaleX(${waiting ? 1 : share(progress)})`}}
      />
    </span>
  )
}

const STATUS_LABEL: Record<Phase, string> = {
  scanning: '',
  reviewing: '',
  waiting: 'Waiting to start',
  queued: 'Queued',
  trashing: 'Moving to the Trash',
  deleting: 'Deleting',
  trashed: 'In the Trash · undo available',
  undoing: 'Putting back',
  emptying: 'Emptying the Trash',
  finished: 'Cleanup finished',
  stopped: 'Cleanup stopped',
}

const WORKING_PHASES = new Set<Phase>(['waiting', 'queued', 'trashing', 'deleting', 'undoing', 'emptying'])

function cleanupStatusOf(phase: Phase) {
  if (phase === 'stopped') return 'error'
  return WORKING_PHASES.has(phase) ? 'working' : 'done'
}

export function CleanupStatus({progress, phase}: {progress: CleanupProgress; phase: Phase}) {
  const label = usePlatform().bin(STATUS_LABEL[phase])
  if (phase === 'waiting' || phase === 'queued') return <span className="t-pulse text-[13px] text-muted-foreground">{label}</span>
  return (
    <LatticeLoader
      key={label}
      label={label}
      doneLabel={label}
      errorLabel={label}
      status={cleanupStatusOf(phase)}
      elapsed={progress.elapsed / 1000}
      fontSize={13}
      cellSize={4}
      className="text-muted-foreground"
    />
  )
}

export function CleanupCounter({progress, phase}: {progress: CleanupProgress; phase: Phase}) {
  const job = progress.cleanup.job
  const working = phase === 'trashing' || phase === 'deleting'
  const {path} = usePlatform()
  const last = working ? path(progress.outcomes.at(-1)?.label ?? '') : ''
  const figures =
    job && (phase === 'undoing' || phase === 'emptying')
      ? `${plural(job.count, 'item', 'items')} · ${formatBytes(progress.handled)} of ${formatBytes(job.bytes)}`
      : `${counted(progress.count)} of ${plural(progress.total, 'item', 'items')} done · ${formatBytes(progress.handled)} of ${formatBytes(progress.plan.approved)}`
  return (
    <div className="flex h-5 min-w-0 items-baseline gap-3 text-[13px] text-muted-foreground tabular-nums">
      <span className="w-64 shrink-0 truncate">{figures}</span>
      <span className="truncate font-mono text-xs text-muted-foreground/70">{last}</span>
    </div>
  )
}

export function DetailsButton({onClick, ref}: {onClick: () => void; ref?: Ref<HTMLButtonElement>}) {
  return (
    <Button ref={ref} variant="outline" aria-haspopup="dialog" onClick={onClick}>
      <Activity /> Details
    </Button>
  )
}

function Stat({label, children}: {label: string; children: ReactNode}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="truncate text-sm font-semibold tabular-nums">{children}</span>
    </div>
  )
}

function elapsedOf(progress: CleanupProgress) {
  return Math.round(progress.elapsed / 1000)
}

function FreeSpace({progress}: {progress: CleanupProgress}) {
  const before = progress.cleanup.started?.free
  if (progress.freeChange !== null) return <Stat label="Free space change, all apps">{signedBytes(progress.freeChange)}</Stat>
  return <Stat label="Free space">{before === undefined || progress.free === null ? 'not started' : `${formatBytes(before)} → ${formatBytes(progress.free)}`}</Stat>
}

export const HERO_LABEL: Record<Phase, string> = {
  scanning: 'Selected to free',
  reviewing: 'Selected to free',
  waiting: 'Approved · waiting to start',
  queued: 'Approved · queued',
  trashing: 'Moving to the Trash',
  deleting: 'Deleting for good',
  trashed: 'In the Trash · undo available',
  undoing: 'Putting back',
  emptying: 'Emptying from the Trash',
  finished: 'Freed',
  stopped: 'Stopped',
}

function headlineOf(phase: Phase, progress: CleanupProgress) {
  if (phase === 'trashed') return {label: HERO_LABEL.trashed, note: progress.freed > 0 ? `Freed ${formatBytes(progress.freed)} · space comes back when the Trash is emptied` : 'Space comes back when the Trash is emptied'}
  if (isPutBack(phase, progress)) return {label: 'Put back', note: progress.freed > 0 ? `Nothing left in the Trash · freed ${formatBytes(progress.freed)}` : 'Nothing left in the Trash'}
  return {label: HERO_LABEL[phase], note: ''}
}

function Stats({progress, phase}: {progress: CleanupProgress; phase: Phase}) {
  const {bin} = usePlatform()
  const headline = headlineOf(phase, progress)
  const label = bin(headline.label)
  const note = bin(headline.note)
  return (
    <div className="flex flex-col gap-4 px-4">
      <div className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span className="text-4xl leading-none font-bold tracking-tighter tabular-nums">
          <SpinningBytes bytes={heroBytes(phase, progress)} />
        </span>
        {note && <span className="text-xs text-muted-foreground">{note}</span>}
      </div>
      <div className="grid grid-cols-3 gap-3">
        <Stat label="Items done">
          {counted(progress.count)} of {counted(progress.total)}
        </Stat>
        <Stat label="Elapsed">{formatDuration(elapsedOf(progress))}</Stat>
        <FreeSpace progress={progress} />
      </div>
    </div>
  )
}

const KIND_TEXT: Record<Outcome['kind'], string> = {
  removed: 'Removed',
  failed: 'Not removed',
  kept: 'Kept',
  ran: 'Ran',
  trashed: 'Moved to the Trash',
  emptied: 'Emptied from the Trash',
  restored: 'Put back',
}
const KIND_TONE: Record<Outcome['kind'], string> = {
  removed: 'text-foreground',
  failed: 'text-red-300',
  kept: 'text-amber-300',
  ran: 'text-foreground',
  trashed: 'text-sky-300',
  emptied: 'text-foreground',
  restored: 'text-foreground',
}
const QUIET = new Set<Outcome['kind']>(['removed', 'ran', 'trashed', 'emptied', 'restored'])

function detailOf(outcome: Outcome) {
  if (outcome.key.startsWith('cmd:')) return outcome.kind === 'ran' ? 'ok' : 'failed'
  if (outcome.reason) return outcome.reason
  return `${formatBytes(outcome.bytes)}${outcome.secs > 0 ? ` in ${outcome.secs.toFixed(1)}s` : ''}`
}

interface RowProps {
  outcome: Outcome
  index: number
  count: number
  start: number
  ref: Ref<HTMLLIElement>
}

const Row = memo(function Row({outcome, index, count, start, ref}: RowProps) {
  const {path, bin} = usePlatform()
  return (
    <li
      ref={ref}
      data-index={index}
      aria-setsize={count}
      aria-posinset={index + 1}
      className="absolute top-0 left-0 grid w-full grid-cols-[3.5rem_minmax(0,1fr)] gap-x-3 border-b border-border/50 px-4 py-2 text-xs"
      style={{transform: `translateY(${start}px)`}}
    >
      <span className="text-muted-foreground tabular-nums">{(outcome.at / 1000).toFixed(1)}s</span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className={`font-medium ${KIND_TONE[outcome.kind]}`}>
          {bin(KIND_TEXT[outcome.kind])} <span className="font-mono font-normal">{path(outcome.label)}</span>
        </span>
        <span className={QUIET.has(outcome.kind) ? 'text-muted-foreground' : KIND_TONE[outcome.kind]}>{detailOf(outcome)}</span>
      </span>
    </li>
  )
})

function Rows({outcomes}: {outcomes: readonly Outcome[]}) {
  const scroller = useRef<HTMLDivElement>(null)
  const newest = (index: number) => outcomes[outcomes.length - 1 - index]
  const virtualizer = useVirtualizer({
    count: outcomes.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => LOG_ROW_HEIGHT,
    getItemKey: index => newest(index)?.id ?? index,
    overscan: LOG_OVERSCAN,
  })
  return (
    <div ref={scroller} className="min-h-0 grow overflow-y-auto border-t">
      {outcomes.length === 0 ? (
        <p className="px-4 py-6 text-xs text-muted-foreground">Nothing here yet.</p>
      ) : (
        <ol aria-label="Cleanup events" className="relative" style={{height: virtualizer.getTotalSize()}}>
          {virtualizer.getVirtualItems().map(virtual => {
            const outcome = newest(virtual.index)
            return outcome && <Row key={outcome.id} ref={virtualizer.measureElement} outcome={outcome} index={virtual.index} count={outcomes.length} start={virtual.start} />
          })}
        </ol>
      )}
    </div>
  )
}

const PANEL_STATE: Record<Phase, string> = {
  scanning: '',
  reviewing: '',
  waiting: 'Waiting for the cleanup to start',
  queued: 'Queued: it starts when the cleanup before it finishes',
  trashing: 'Moving to the Trash in the background',
  deleting: 'Deleting in the background',
  trashed: "In the Trash: Undo puts everything back, Empty these from Trash deletes them for good",
  undoing: 'Putting the items back from the Trash',
  emptying: 'Emptying these items from the Trash for good',
  finished: 'Finished',
  stopped: 'Stopped before it finished',
}

function ProgressPanel({
  progress,
  phase,
  open,
  onOpenChange,
  onMovie,
  log,
  setLog,
  actions,
}: {
  progress: CleanupProgress
  phase: Phase
  open: boolean
  onOpenChange: (open: boolean) => void
  onMovie: () => void
  log: LogFilter
  setLog: (log: LogFilter) => void
  actions: ReactNode
}) {
  const reduced = useReducedMotion()
  const {bin} = usePlatform()
  const shown = useMemo(() => progress.outcomes.filter(FILTERS[log]), [progress.outcomes, log])
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="gap-4 data-[side=right]:sm:max-w-md">
        <SheetHeader className="pb-0">
          <SheetTitle>Cleanup progress</SheetTitle>
          <SheetDescription>{progress.cleanup.abandoned && !progress.cleanup.started ? 'The cleanup did not start' : bin(PANEL_STATE[phase])}</SheetDescription>
        </SheetHeader>
        <Stats progress={progress} phase={phase} />
        {actions && <div className="px-4">{actions}</div>}
        <div className="flex items-center gap-2 px-4">
          <ToggleGroup value={[log]} onValueChange={v => v[0] && setLog(v[0] as LogFilter)} variant="outline" size="sm" aria-label="Show">
            {LOG_FILTERS.map(f => (
              <ToggleGroupItem key={f} value={f}>
                {FILTER_LABEL[f]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
        <Rows outcomes={shown} />
        {!reduced && (
          <div className="border-t p-4">
            <Button variant="outline" className="w-full" onClick={onMovie}>
              <Clapperboard /> Watch the movie
            </Button>
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}

const FOOTER_TITLE: Record<Phase, string> = {
  scanning: '',
  reviewing: '',
  waiting: 'Approved: the cleanup runs in the background',
  queued: 'Approved: queued behind the cleanup before it',
  trashing: 'Moving to the Trash…',
  deleting: 'Deleting for good…',
  trashed: '',
  undoing: 'Putting the items back…',
  emptying: 'Emptying these from the Trash…',
  finished: 'Cleanup finished',
  stopped: 'The cleanup stopped before it finished',
}

function footerTitle(phase: Phase, progress: CleanupProgress) {
  if (phase === 'trashed') return `Moved to Trash ${formatBytes(progress.inTrash.bytes)} · undo available`
  if (isPutBack(phase, progress)) return `Put back ${formatBytes(progress.restored)} · nothing left in the Trash`
  if (phase === 'stopped' && !progress.cleanup.started) return 'The cleanup did not start'
  return FOOTER_TITLE[phase]
}

function FooterFigures({progress}: {progress: CleanupProgress}) {
  if (progress.freeChange === null || progress.freed === 0) return null
  return <>Freed {formatBytes(progress.freed)} · </>
}

const NOT_DONE_SHOWN = 3

function NotDone({progress}: {progress: CleanupProgress}) {
  const home = useHome()
  const {path} = usePlatform()
  const problems = [...progress.byKey.values()].filter(o => o.kind === 'failed' || o.kind === 'kept')
  if (problems.length === 0) return null
  const shown = problems.slice(0, NOT_DONE_SHOWN)
  return (
    <ul aria-label="Not done" className="flex flex-col gap-0.5 text-xs">
      {shown.map(o => (
        <li key={o.key} className={`truncate ${o.kind === 'failed' ? 'text-red-300' : 'text-amber-300'}`}>
          {o.kind === 'failed' ? 'Not removed' : 'Kept'} <span className="font-mono">{path(tilde(o.label, home))}</span>
          {o.reason && `: ${o.reason}`}
        </li>
      ))}
      {problems.length > shown.length && <li className="text-muted-foreground">{plural(problems.length - shown.length, 'more in Details', 'more in Details')}</li>}
    </ul>
  )
}

function TrashNote({phase}: {phase: Phase}) {
  const {bin} = usePlatform()
  if (phase !== 'trashed') return null
  return <>{bin('in your Trash until you empty it; space comes back then · ')}</>
}

export function ProgressFooter({progress, phase, actions}: {progress: CleanupProgress; phase: Phase; actions?: ReactNode}) {
  const {bin} = usePlatform()
  return (
    <footer className="flex items-center gap-2.5 border-t bg-card px-7 py-3.5">
      <div className="flex grow flex-col gap-0.5">
        <div className="flex h-6 items-center text-sm font-semibold tabular-nums">{bin(footerTitle(phase, progress))}</div>
        <div className="flex h-5 items-center text-xs whitespace-nowrap text-muted-foreground tabular-nums">
          <FooterFigures progress={progress} />
          <TrashNote phase={phase} />
          {plural(progress.plan.items.size, 'item', 'items')} · {formatBytes(progress.plan.approved)} approved
        </div>
        <NotDone progress={progress} />
      </div>
      {actions}
    </footer>
  )
}

export function RoundResult({progress, phase}: {progress: CleanupProgress; phase: Phase}) {
  const {bin} = usePlatform()
  return (
    <section aria-label="Last cleanup" className="flex flex-col gap-0.5">
      <p className="truncate text-xs leading-5 whitespace-nowrap text-muted-foreground tabular-nums">
        <span className="font-semibold text-foreground">{bin(footerTitle(phase, progress))}</span> · <FooterFigures progress={progress} />
        <TrashNote phase={phase} />
        {plural(progress.plan.items.size, 'item', 'items')} · {formatBytes(progress.plan.approved)} approved
      </p>
      <NotDone progress={progress} />
    </section>
  )
}

export function trashOffer(progress: CleanupProgress, phase: Phase, busy: boolean) {
  const away = progress.link !== 'live'
  return {offered: phase === 'trashed', away, waiting: busy || jobRunning(progress) || away}
}

export function TrashActions({
  progress,
  phase,
  busy,
  error,
  onUndo,
  onEmpty,
}: {
  progress: CleanupProgress
  phase: Phase
  busy: boolean
  error: ReactNode
  onUndo: () => void
  onEmpty: () => void
}) {
  const {offered, away, waiting} = trashOffer(progress, phase, busy)
  const {bin} = usePlatform()
  if (!offered && !error) return null
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2">
      {error}
      {offered && away && <span className="text-xs text-red-300">Undo and Empty wait until disk-clean is reachable again</span>}
      {offered && (
        <>
          <Button variant="outline" disabled={waiting} onClick={onUndo}>
            <Undo2 /> Undo
          </Button>
          <Button variant="destructive" disabled={waiting} aria-haspopup="dialog" onClick={onEmpty}>
            <Trash2 /> {bin('Empty these from Trash')}
          </Button>
        </>
      )}
    </div>
  )
}

export function CleanupTracker({db, progress, phase, returnFocus, actions}: {db: Db; progress: CleanupProgress; phase: Phase; returnFocus: RefObject<HTMLButtonElement | null>; actions: ReactNode}) {
  const movie = useMovie(db)
  const overlay = useSearch({strict: false, select: search => search.overlay})
  const log = useSearch({strict: false, select: search => search.log}) ?? 'all'
  const take = useSearch({strict: false, select: search => search.take}) ?? 0
  const navigate = useNavigate()
  const back = useBack()
  const close = () => back({to: '.', search: prev => ({...prev, overlay: undefined, log: undefined, take: undefined})})
  const layer = (patch: {overlay?: Overlay; log?: LogFilter; take?: number}) => navigate({to: '.', search: prev => ({...prev, ...patch}), replace: true})
  return (
    <>
      <ProgressPanel
        progress={progress}
        phase={phase}
        open={overlay === 'progress'}
        onOpenChange={open => open || close()}
        onMovie={() => layer({overlay: 'movie', take: 0})}
        log={log}
        setLog={next => layer({log: next})}
        actions={actions}
      />
      <CleanupFilm
        {...movie}
        actions={actions}
        open={overlay === 'movie'}
        take={take}
        onReplay={() => layer({take: take + 1})}
        onClose={close}
        returnFocus={returnFocus}
      />
    </>
  )
}
