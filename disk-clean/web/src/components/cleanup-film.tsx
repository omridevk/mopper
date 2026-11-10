import {Dialog as DialogPrimitive} from '@base-ui/react/dialog'
import {useGSAP} from '@gsap/react'
import {ChevronDown, X} from 'lucide-react'
import {Suspense, use, useMemo, useRef, useState, type ReactNode, type RefObject} from 'react'
import {Button} from '@/components/ui/button'
import {Popover, PopoverContent, PopoverTrigger} from '@/components/ui/popover'
import {counted, formatBytes, plural} from '@/lib/data'
import type {Db} from '@/lib/db'
import {textIn} from '@/lib/platform'
import {finaleOf, formatDuration, logFeed, useLatest, useStaged, type Cleanup, type FilmPlan, type LogFeed, type MovieFeed, type Outcome, type Totals} from '@/lib/progress'
import {createFilm, gaugeOf, pump, type Film as FilmState, type ParticlePhase} from '@/lib/film'
import {cssMs, useReducedMotion} from '@/lib/motion'
import {DISK_COLORS} from './disk-donut'
import {BurningFilm} from './radiant/burning-film'
import ParticleText from './react-bits/particle-text'
import Shredder from './react-bits/shredder'

const WAITING = 'Waiting for the deletion to start'
const CARDS = 8
const SHRED_FALL = 90
const PARTICLE_STAGGER = 420
const PARTICLE_SCATTER = 110
const FIGURE_FONT = {family: "'Geist Variable'", size: 96, weight: 700}
const FIGURE = `${FIGURE_FONT.weight} ${FIGURE_FONT.size}px ${FIGURE_FONT.family}`

type FilmProps = MovieFeed

function bySection(plan: FilmPlan, removed: readonly Outcome[]) {
  return plan.sections
    .map(s => ({section: s, items: removed.filter(o => o.section === s.id)}))
    .concat([{section: {id: '', title: 'Other', bytes: 0, count: 0}, items: removed.filter(o => !plan.sections.some(s => s.id === o.section))}])
    .filter(group => group.items.length > 0)
}

interface GaugeProps {
  root: string
  used: string
  freed?: string
  total: number
  before: number
  now: number
  enlarged: boolean
  children: ReactNode
}

function Gauge({root, used, freed, total, before, now, enlarged, children}: GaugeProps) {
  const gauge = gaugeOf(total, before, now)
  const whole = gaugeOf(total, before, before).used
  return (
    <div data-film={root} className="flex w-full max-w-xl min-w-0 flex-col gap-2.5 rounded-xl border border-white/10 bg-zinc-950 px-5 py-4">
      <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-sm">{children}</div>
      <div className="relative h-2.5 overflow-hidden rounded-full" style={{background: DISK_COLORS.free}}>
        <div data-film={freed} className="absolute inset-0 origin-left" style={{background: DISK_COLORS.selected, transform: `scaleX(${whole})`}} />
        <div data-film={used} data-from={whole} data-to={gauge.rest} className="absolute inset-0 origin-left" style={{background: DISK_COLORS.used, transform: `scaleX(${gauge.rest})`}} />
      </div>
      {enlarged && <span className="text-xs text-muted-foreground">The freed part is too small to see at true scale, so it is drawn larger.</span>}
    </div>
  )
}

function FinaleGauge({plan, done, freed}: {plan: FilmPlan; done: NonNullable<Cleanup['done']>; freed: number}) {
  const before = done.free_before
  const {enlarged} = gaugeOf(plan.total, before, before + freed)
  return (
    <Gauge root="bars" used="gauge-after" total={plan.total} before={before} now={before + freed} enlarged={enlarged}>
      <span className="font-semibold text-sky-300 tabular-nums">{formatBytes(freed)} removed</span>
      <span className="text-muted-foreground tabular-nums">
        free space {formatBytes(before)} → {formatBytes(done.free_after)}
      </span>
    </Gauge>
  )
}

function StageGauge({plan, startFree}: {plan: FilmPlan; startFree: number}) {
  const {enlarged} = gaugeOf(plan.total, startFree, startFree + plan.approved)
  return (
    <Gauge root="build" used="gauge-used" freed="gauge-freed" total={plan.total} before={startFree} now={startFree} enlarged={enlarged}>
      <span className="text-muted-foreground">Free space</span>
      <span className="font-medium tabular-nums">
        {formatBytes(startFree)} → <span data-film="free">{formatBytes(startFree)}</span>
      </span>
    </Gauge>
  )
}

const TILE = 'flex min-w-0 flex-col gap-1 rounded-lg border border-white/10 bg-zinc-900/70 px-4 py-3 text-left'

function Tile({label, children}: {label: string; children: ReactNode}) {
  return (
    <div data-film="tile" className={TILE}>
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="truncate text-lg font-semibold tabular-nums">{children}</span>
    </div>
  )
}

function ProblemTile({label, rows, path}: {label: string; rows: readonly Outcome[]; path: (path: string) => string}) {
  if (rows.length === 0) return <Tile label={label}>0</Tile>
  return (
    <Popover>
      <PopoverTrigger
        data-film="tile"
        className={`${TILE} group cursor-pointer outline-none hover:border-white/25 hover:bg-zinc-800/70 focus-visible:ring-2 focus-visible:ring-ring/50 data-[popup-open]:border-white/25`}
      >
        <span className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          {label}
          <span className="flex items-center gap-0.5 text-foreground">
            show <ChevronDown className="size-3.5 transition-transform duration-(--duration-fast) group-data-[popup-open]:rotate-180 motion-reduce:transition-none" />
          </span>
        </span>
        <span data-ticker={rows.length} className="text-lg font-semibold tabular-nums">
          {rows.length}
        </span>
      </PopoverTrigger>
      <PopoverContent side="top" aria-label={label} className="max-h-72 w-96 overflow-y-auto">
        <ul className="flex flex-col gap-2 text-xs">
          {rows.map(o => (
            <li key={o.key} className="flex min-w-0 flex-col gap-0.5">
              <span className="truncate font-mono">{path(o.label)}</span>
              <span className="text-muted-foreground">{o.reason}</span>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  )
}

function Tiles({totals, path, bin}: {totals: Totals; path: (path: string) => string; bin: (text: string) => string}) {
  return (
    <div className="grid w-full grid-cols-3 gap-3">
      <Tile label="removed for good">
        <span data-ticker={totals.removed.length}>{totals.removed.length}</span> · {formatBytes(totals.reclaimed)}
      </Tile>
      {totals.trashed.length > 0 && (
        <Tile label={bin('in the Trash, can be undone')}>
          <span data-ticker={totals.trashed.length}>{totals.trashed.length}</span> · {formatBytes(totals.trashedBytes)}
        </Tile>
      )}
      <Tile label="sections">
        <span data-ticker={totals.sections}>{totals.sections}</span>
      </Tile>
      <Tile label="biggest item">{totals.biggest ? `${formatBytes(totals.biggest.bytes)} · ${path(totals.biggest.label)}` : 'none'}</Tile>
      <Tile label="time taken">{formatDuration(totals.seconds)}</Tile>
      <ProblemTile label="kept" rows={totals.kept} path={path} />
      <ProblemTile label="not removed" rows={totals.failed} path={path} />
    </div>
  )
}

function CreditList({plan, totals, path}: {plan: FilmPlan; totals: Totals; path: (path: string) => string}) {
  return (
    <>
      {bySection(plan, [...totals.removed, ...totals.trashed]).map(({section, items}) => (
        <li key={section.id} className="flex flex-col gap-1">
          <span className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{section.title}</span>
          {items.map(o => (
            <span key={o.key} className="truncate font-mono text-xs">
              {path(o.label)}
            </span>
          ))}
        </li>
      ))}
      <li className="pt-4 text-sm text-muted-foreground">and that's everything</li>
    </>
  )
}

function Ring() {
  return (
    <svg data-part="ring" viewBox="0 0 24 24" aria-hidden className="size-6 shrink-0">
      <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeOpacity="0.15" strokeWidth="2.5" />
      <circle data-part="arc" cx="12" cy="12" r="10" fill="none" stroke={DISK_COLORS.selected} strokeWidth="2.5" transform="rotate(-90 12 12)" />
      <path data-part="check" d="M8 12.5l2.5 2.5L16 9.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function Card() {
  return (
    <div
      data-film="card"
      className="group absolute inset-0 flex flex-col justify-center gap-1.5 rounded-xl border border-white/20 bg-zinc-900 px-5 opacity-0 shadow-xl shadow-black/60 data-[kind=failed]:border-red-400/60 data-[kind=kept]:border-amber-300/50"
    >
      <div className="flex min-w-0 items-center gap-2">
        <svg data-part="lock" viewBox="0 0 24 24" aria-hidden className="hidden size-4 shrink-0 text-amber-200 group-data-[kind=kept]:block">
          <rect width="18" height="11" x="3" y="11" rx="2" fill="none" stroke="currentColor" strokeWidth="2" />
          <path d="M7 11V7a5 5 0 0 1 10 0v4" fill="none" stroke="currentColor" strokeWidth="2" />
        </svg>
        <span data-part="label" className="truncate font-mono text-sm text-zinc-50" />
      </div>
      <div className="flex min-w-0 justify-between gap-3 text-sm text-zinc-300">
        <span data-part="size" className="shrink-0 tabular-nums" />
        <span data-part="reason" className="truncate text-red-300 group-data-[kind=kept]:text-amber-200" />
      </div>
    </div>
  )
}

function Tray({title, rows, path}: {title: string; rows: readonly Outcome[]; path: (path: string) => string}) {
  if (rows.length === 0) return null
  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-semibold tracking-wide text-zinc-300 uppercase">{title}</span>
      <ul className="flex flex-col gap-1.5">
        {rows.map(o => (
          <li key={o.key} data-film="tray-row" data-key={o.key} className="flex flex-col rounded-md border border-white/15 bg-zinc-900 px-3 py-2 text-sm opacity-0">
            <span className="truncate font-mono">{path(o.label)}</span>
            <span className={title === 'Kept' ? 'text-amber-200' : 'text-red-300'}>{o.reason}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function Slot({shred, path}: {shred: Outcome | null; path: (path: string) => string}) {
  const items = useMemo(() => (shred ? [{id: shred.key, label: path(shred.label), size: formatBytes(shred.bytes)}] : []), [shred, path])
  return (
    <div data-film="slot" className="relative h-[88px] w-full max-w-[440px]">
      {Array.from({length: CARDS}, (_, i) => (
        <Card key={i} />
      ))}
      <div data-film="chip" className="absolute inset-x-0 top-full mx-auto mt-3 w-fit rounded-full bg-zinc-800 px-3 py-1 text-xs tabular-nums opacity-0" />
      {shred && (
        <div aria-hidden className="absolute inset-x-0 top-0">
          <Shredder
            key={shred.key}
            items={items}
            renderItem={item => (
              <div className="flex justify-between gap-3 truncate rounded-md border border-white/15 bg-zinc-800 px-3 py-2 font-mono text-xs text-zinc-200">
                <span className="truncate">{item.label}</span>
                <span>{item.size}</span>
              </div>
            )}
            autoAnimate
            autoDelay={0}
            width={440}
            height={34 + SHRED_FALL + 8}
            fallHeight={SHRED_FALL}
            slitColor="#64748b"
            color="#d4d4d8"
          />
        </div>
      )}
    </div>
  )
}

function Stage({plan, all, startFree, shred, path}: {plan: FilmPlan; all: readonly Outcome[]; startFree: number; shred: Outcome | null; path: (path: string) => string}) {
  const kept = all.filter(o => o.kind === 'kept')
  const failed = all.filter(o => o.kind === 'failed')
  const commands = all.filter(o => o.key.startsWith('cmd:'))
  return (
    <div data-film="stage" className="invisible absolute inset-0 p-12">
      <div className="mx-auto grid h-full max-w-6xl grid-cols-[minmax(0,1fr)_minmax(440px,1.4fr)_minmax(0,1fr)] grid-rows-[1fr_auto] gap-x-8 gap-y-6">
        <ol data-film="leave" className="flex min-w-0 flex-col gap-3 self-center rounded-xl border border-white/10 bg-zinc-950 p-5">
          {plan.sections.map(s => (
            <li key={s.id} data-film="build" className="flex min-w-0 items-center gap-3">
              <div data-section={s.id} className="flex min-w-0 grow items-center gap-3">
                <Ring />
                <span className="truncate text-sm">{s.title}</span>
                <span data-part="left" className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">
                  {formatBytes(s.bytes)}
                </span>
              </div>
            </li>
          ))}
        </ol>
        <div className="flex min-w-0 flex-col items-center justify-center gap-8">
          <div data-film="leave">
            <div data-film="counter-box" className="flex flex-col items-center gap-1 opacity-0">
              <output data-film="counter" aria-label="Cleared" className="inline-block min-w-[7ch] text-center text-7xl leading-none font-bold tracking-tighter tabular-nums [contain:layout_paint]">
                0 B
              </output>
              <div className="text-sm text-muted-foreground">
                of{' '}
                <span data-film="of-total" className="inline-block font-medium text-foreground opacity-0">
                  {formatBytes(plan.approved)}
                </span>{' '}
                approved
              </div>
            </div>
          </div>
          <div data-film="leave" className="flex w-full justify-center">
            <Slot shred={shred} path={path} />
          </div>
        </div>
        <div className="flex min-w-0 flex-col justify-center">
          {kept.length + failed.length > 0 && (
            <div data-film="trays" className="flex flex-col gap-6 rounded-xl border border-white/10 bg-zinc-950 p-5 opacity-0">
              <Tray title="Kept" rows={kept} path={path} />
              <Tray title="Not removed" rows={failed} path={path} />
            </div>
          )}
        </div>
        <div data-film="leave" className="col-span-3 flex min-w-0 flex-col items-center gap-3">
          {commands.length > 0 && (
            <ul className="flex w-full max-w-xl flex-col gap-1 rounded-xl border border-white/10 bg-zinc-950 px-5 py-3">
              {commands.map(o => (
                <li key={o.key} data-film="command" data-key={o.key} className="flex items-center gap-2 font-mono text-xs opacity-0">
                  <span className="text-muted-foreground">$</span>
                  <span data-part="label">{o.label}</span>
                  <svg data-part="status" viewBox="0 0 24 24" aria-label={o.kind === 'failed' ? 'failed' : 'ok'} className={`size-3.5 ${o.kind === 'failed' ? 'text-red-300' : 'text-sky-300'}`}>
                    <path d={o.kind === 'failed' ? 'M18 6 6 18M6 6l12 12' : 'M20 6 9 17l-5-5'} fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
                  </svg>
                </li>
              ))}
            </ul>
          )}
          <StageGauge plan={plan} startFree={startFree} />
        </div>
      </div>
    </div>
  )
}

function inkOffset(text: string) {
  const context = document.createElement('canvas').getContext('2d')
  if (!context) return {x: 0, y: 0}
  context.font = FIGURE
  const m = context.measureText(text)
  const left = Math.ceil(m.actualBoundingBoxLeft)
  const right = Math.ceil(m.actualBoundingBoxRight)
  const ascent = Math.ceil(m.actualBoundingBoxAscent)
  const descent = Math.ceil(m.actualBoundingBoxDescent)
  return {
    x: (3 * left + right - m.width + 1) / 2,
    y: (m.fontBoundingBoxAscent - m.fontBoundingBoxDescent - ascent + descent + 1) / 2,
  }
}

const fontsLoading = new Map<string, Promise<void>>()

function useFigureFont(text: string) {
  if (document.fonts.check(FIGURE, text)) return
  const loading = fontsLoading.get(text) ?? document.fonts.load(FIGURE, text).then(
    () => undefined,
    () => undefined,
  )
  fontsLoading.set(text, loading)
  use(loading)
}

function Particles({text, onLanded}: {text: string; onLanded: () => void}) {
  const gather = cssMs('--gather-dur', 1600)
  useFigureFont(text)
  const offset = useMemo(() => inkOffset(text), [text])
  return (
    <>
      <i aria-hidden className="t-clock absolute" style={{animationDuration: `${gather + cssMs('--duration-medium', 350)}ms`}} onAnimationEnd={onLanded} />
      <ParticleText
        text={text}
        fontFamily={FIGURE_FONT.family}
        fontSize={FIGURE_FONT.size}
        fontWeight={FIGURE_FONT.weight}
        particleSize={2.2}
        density={2}
        color="#f5f8ff"
        highlightColor="#a9c8f0"
        glow={false}
        gatherDuration={gather - PARTICLE_STAGGER}
        stagger={PARTICLE_STAGGER}
        scatter={PARTICLE_SCATTER}
        style={{minHeight: 0, height: 320, transform: `translate(${offset.x}px, ${offset.y}px)`}}
      />
    </>
  )
}

interface FinaleProps {
  plan: FilmPlan
  cleanup: Cleanup
  all: readonly Outcome[]
  db: Db
  elapsed: number
  particles: ParticlePhase
  actions: ReactNode
  onLanded: () => void
  onReplay: () => void
}

function emptyHeading(totals: Totals, all: readonly Outcome[]) {
  if (totals.failed.length + totals.kept.length > 0) return 'Nothing could be removed'
  return all.some(o => o.kind === 'ran') ? 'The cleanup commands ran' : 'Nothing was removed'
}

function emptySummary(totals: Totals, all: readonly Outcome[]) {
  const ran = all.filter(o => o.kind === 'ran').length
  const parts = [totals.failed.length > 0 && `${counted(totals.failed.length)} not removed`, totals.kept.length > 0 && `${counted(totals.kept.length)} kept`, ran > 0 && `${plural(ran, 'command', 'commands')} ran`]
  return parts.filter(Boolean).join(' · ') || 'The cleanup had nothing to do'
}

function headingOf(cleanup: Cleanup, totals: Totals, all: readonly Outcome[]) {
  if (cleanup.abandoned) return cleanup.started ? 'The cleanup stopped before it finished' : 'The cleanup did not start'
  if (totals.trashed.length > 0) return 'Moved to the Trash'
  return totals.removed.length === 0 ? emptyHeading(totals, all) : 'You freed'
}

function figureOf(cleanup: Cleanup, totals: Totals, all: readonly Outcome[], freed: number) {
  if (cleanup.abandoned) return freed > 0 ? `${cleanup.abandoned.reason} · freed ${formatBytes(freed)}` : cleanup.abandoned.reason
  if (totals.trashed.length > 0) return formatBytes(totals.trashedBytes)
  return totals.removed.length === 0 ? emptySummary(totals, all) : formatBytes(freed)
}

function TrashNote({cleanup, totals, actions, bin}: {cleanup: Cleanup; totals: Totals; actions: ReactNode; bin: (text: string) => string}) {
  if (totals.trashed.length === 0 || cleanup.abandoned) return null
  return (
    <div data-film="trash-actions" className="flex flex-col items-center gap-3">
      <p className="text-sm text-muted-foreground">
        {bin('in the Trash · undo available · space comes back when the Trash is emptied')}
        {totals.reclaimed > 0 && ` · freed ${formatBytes(totals.reclaimed)}`}
      </p>
      {actions}
    </div>
  )
}

function Finale({plan, cleanup, all, db, elapsed, particles, actions, onLanded, onReplay}: FinaleProps) {
  const {done, abandoned} = cleanup
  const latest = useLatest(db)
  const totals = useMemo(() => finaleOf(latest, done, elapsed), [latest, done, elapsed])
  const freed = totals.reclaimed
  const empty = (totals.removed.length === 0 && totals.trashed.length === 0) || abandoned !== null
  const {path, bin} = textIn(db.loaded.platform)
  const heading = bin(headingOf(cleanup, totals, all))
  return (
    <div data-film="finale" className="invisible absolute inset-0 overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col items-center gap-6 px-6 py-10 text-center">
        <h2 key={heading} data-film="freed-heading" className="text-2xl font-semibold tracking-tight">
          {heading}
        </h2>
        <div className="relative grid min-h-24 w-full place-items-center">
          <div data-film="freed" className={empty ? 'text-lg text-muted-foreground opacity-0' : 'text-[96px] leading-none font-bold opacity-0'}>
            {figureOf(cleanup, totals, all, freed)}
          </div>
          <div data-film="particles" aria-hidden className="pointer-events-none absolute inset-x-0 -top-28 h-[320px]">
            {particles !== 'off' && (
              <Suspense fallback={null}>
                <Particles text={formatBytes(freed)} onLanded={onLanded} />
              </Suspense>
            )}
          </div>
        </div>
        <TrashNote cleanup={cleanup} totals={totals} actions={actions} bin={bin} />
        {done && <FinaleGauge plan={plan} done={done} freed={freed} />}
        <Tiles totals={totals} path={path} bin={bin} />
        <div
          data-film="credits"
          tabIndex={0}
          role="region"
          aria-label="Everything removed"
          className="t-credits h-56 w-full overflow-y-auto overscroll-contain rounded-md opacity-0 outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <ol className="flex flex-col gap-4 pt-20 pb-20">
            <CreditList plan={plan} totals={totals} path={path} />
          </ol>
        </div>
        <button data-film="replay" type="button" onClick={onReplay} className="invisible rounded-md border border-white/15 px-4 py-2 text-sm">
          Replay
        </button>
      </div>
    </div>
  )
}

function useFilm(container: HTMLElement | null, plan: FilmPlan, feed: LogFeed, running: (on: boolean) => void, path: (path: string) => string) {
  const film = useRef<FilmState | null>(null)
  const landing = useRef({phase: 'off' as ParticlePhase, landed: false})
  const [shred, setShred] = useState<Outcome | null>(null)
  const [particles, setParticles] = useState<ParticlePhase>('off')
  const play = () => void film.current?.tl.play()
  const particlesTo = (phase: ParticlePhase) => {
    if (phase === 'gather') landing.current.landed = false
    landing.current.phase = phase
    setParticles(phase)
    if (phase === 'landing' && landing.current.landed) queueMicrotask(play)
  }
  const landed = () => {
    landing.current.landed = true
    if (landing.current.phase === 'landing') play()
  }
  useGSAP(
    (_, contextSafe) => {
      if (!container || !contextSafe) return
      const tail = contextSafe(() => pump(film.current, feed.cleanup(), feed.rows, true))
      const next = contextSafe(() => pump(film.current, feed.cleanup(), feed.rows))
      const ready = contextSafe(() => {
        if (film.current) film.current.ready = true
        next()
      })
      const visible = contextSafe(() => {
        const current = film.current
        if (document.hidden || !current) return
        current.flood = feed.rows.length > current.processed
        next()
      })
      film.current = createFilm(container, plan, {shred: setShred, particles: particlesTo, running, path}, tail, ready)
      film.current.backlog = feed.rows.length
      const unsubscribe = feed.subscribe(next)
      document.addEventListener('visibilitychange', visible)
      return () => {
        unsubscribe()
        document.removeEventListener('visibilitychange', visible)
      }
    },
    {dependencies: [container]},
  )
  return {shred, particles, landed}
}

interface TakeProps extends FilmProps {
  actions: ReactNode
  container: HTMLElement | null
  running: (on: boolean) => void
  onReplay: () => void
}

function Take({container, db, plan, cleanup, elapsed, actions, running, onReplay}: TakeProps) {
  const [feed] = useState(() => logFeed(db))
  const {path} = textIn(db.loaded.platform)
  const {shred, particles, landed} = useFilm(container, plan, feed, running, path)
  const all = useStaged(db)
  const waiting = cleanup.waiting && !cleanup.started
  return (
    <>
      <section className="absolute inset-x-0 top-[34%] flex flex-col items-center gap-4 text-center">
        <div data-film="total" className="text-[96px] leading-none font-bold tracking-tighter tabular-nums">
          {formatBytes(plan.approved)}
        </div>
        <div data-film="caption" className="flex flex-col gap-1">
          <p className="text-2xl font-semibold tracking-tight">approved for deletion</p>
          <p className="text-sm text-muted-foreground">
            {plural(plan.items.size, 'item', 'items')} in {plural(plan.sections.length, 'section', 'sections')}
          </p>
        </div>
        <p data-film="waiting" className="text-sm opacity-0">
          <span className={waiting ? 't-pulse' : undefined}>{WAITING}</span>
        </p>
      </section>
      <Stage plan={plan} all={all} startFree={cleanup.started?.free ?? cleanup.done?.free_before ?? 0} shred={shred} path={path} />
      {(cleanup.done || cleanup.abandoned) && <Finale plan={plan} cleanup={cleanup} all={all} db={db} elapsed={elapsed} particles={particles} actions={actions} onLanded={landed} onReplay={onReplay} />}
    </>
  )
}

function Film({take, actions, onReplay, ...props}: FilmProps & {take: number; actions: ReactNode; onReplay: () => void}) {
  const [running, setRunning] = useState(true)
  const [container, setContainer] = useState<HTMLDivElement | null>(null)
  const replay = () => {
    setRunning(true)
    onReplay()
  }
  return (
    <div ref={setContainer} className="fixed inset-0 isolate overflow-hidden text-foreground">
      <div data-film="backdrop" className="absolute inset-0 -z-10 bg-background opacity-0">
        <div data-film="film" className="absolute inset-0">
          <BurningFilm running={running} className="absolute inset-0" />
        </div>
      </div>
      <Take key={take} container={container} {...props} actions={actions} running={setRunning} onReplay={replay} />
    </div>
  )
}

interface CleanupFilmProps extends FilmProps {
  actions?: ReactNode
  open: boolean
  take: number
  onReplay: () => void
  onClose: () => void
  returnFocus?: RefObject<HTMLButtonElement | null>
}

function StillFinale({db, plan, cleanup, elapsed, actions}: FilmProps & {actions: ReactNode}) {
  const latest = useLatest(db)
  const all = useStaged(db)
  const totals = useMemo(() => finaleOf(latest, cleanup.done, elapsed), [latest, cleanup.done, elapsed])
  const {path, bin} = textIn(db.loaded.platform)
  const heading = cleanup.done || cleanup.abandoned ? bin(headingOf(cleanup, totals, all)) : 'Cleaning up'
  return (
    <div className="fixed inset-0 overflow-y-auto bg-background text-foreground">
      <div className="mx-auto flex max-w-3xl flex-col items-center gap-6 px-6 py-10 text-center">
        <h2 className="text-2xl font-semibold tracking-tight">{heading}</h2>
        <div className="text-5xl font-bold tabular-nums">{figureOf(cleanup, totals, all, totals.reclaimed)}</div>
        <TrashNote cleanup={cleanup} totals={totals} actions={actions} bin={bin} />
        <Tiles totals={totals} path={path} bin={bin} />
        <ol aria-label="Everything removed" className="flex w-full flex-col gap-4 text-left">
          <CreditList plan={plan} totals={totals} path={path} />
        </ol>
      </div>
    </div>
  )
}

export function CleanupFilm({actions, open, take, onReplay, onClose, returnFocus, ...props}: CleanupFilmProps) {
  const close = useRef<HTMLButtonElement>(null)
  const reduced = useReducedMotion()
  const replay = () => {
    onReplay()
    close.current?.focus()
  }
  return (
    <DialogPrimitive.Root open={open} onOpenChange={next => next || onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Popup aria-label="Cleanup movie" initialFocus={close} finalFocus={returnFocus} className="fixed inset-0 z-50 outline-none">
          {reduced ? <StillFinale {...props} actions={actions} /> : <Film {...props} take={take} actions={actions} onReplay={replay} />}
          <DialogPrimitive.Close render={<Button ref={close} variant="secondary" size="sm" className="absolute top-4 right-4 z-10" />}>
            <X /> Close
          </DialogPrimitive.Close>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
