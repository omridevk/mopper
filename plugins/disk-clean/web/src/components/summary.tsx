import {useState, type AnimationEvent, type ReactNode} from 'react'
import {formatBytes, plural} from '@/lib/data'
import {isPutBack, type CleanupProgress, type Job, type Phase} from '@/lib/progress'
import {HERO_LABEL} from './cleanup-progress'
import type {Disk} from '@/lib/scan-feed'
import {useReducedMotion} from '@/lib/motion'
import {usePlatform} from '@/lib/platform'
import type {Selection} from '@/lib/page-data'
import {DISK_COLORS, DiskDonut} from './disk-donut'
import {FlowField} from './radiant/flow-field'
import {SpinningBytes} from './numbers'

function Legend({color, label, outlined}: {color: string; label: string; outlined?: boolean}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className={`size-2 rounded-[2px] ${outlined ? 'border border-zinc-600' : ''}`} style={{background: color}} />
      {label}
    </div>
  )
}

function LoadingBackdrop({scanning}: {scanning: boolean}) {
  const reduced = useReducedMotion()
  const [present, setPresent] = useState(scanning)
  if (scanning !== present && (scanning || reduced)) setPresent(scanning)
  const leave = (event: AnimationEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) setPresent(false)
  }
  if (!present) return null
  return (
    <div className="t-backdrop pointer-events-none absolute inset-0 -z-10" data-state={scanning ? 'in' : 'out'} onAnimationEnd={leave}>
      <FlowField className="size-full" />
    </div>
  )
}

interface Figures {
  used: number
  pending: number
  before: number
  after: number
  free: number
}

function jobFreeOf(job: Job | null) {
  if (!job) return undefined
  if (job.done && 'free_before' in job.done) return job.done.free_before
  return job.free ?? undefined
}

function beforeOf(progress: CleanupProgress, fallback: number) {
  const {job, started, done} = progress.cleanup
  return [jobFreeOf(job), done?.free_before, started?.free].find(n => n !== undefined) ?? fallback
}

function pendingOf(phase: Phase, selection: Selection, progress: CleanupProgress | null) {
  if (!progress) return selection.exactBytes
  if (phase === 'trashing' || phase === 'deleting') return Math.max(0, progress.plan.approved - progress.freed)
  return progress.inTrash.bytes
}

function diskFigures(data: Disk, selection: Selection, progress: CleanupProgress | null, phase: Phase): Figures {
  const pending = pendingOf(phase, selection, progress)
  if (!progress) return {used: data.used, pending, before: data.free, after: data.free + selection.exactBytes, free: data.free}
  const free = progress.free ?? data.free
  return {used: Math.max(0, data.total - free), pending, before: beforeOf(progress, data.free), after: free, free}
}

const KEEPS_SPACE = new Set<Phase>(['waiting', 'queued', 'trashing', 'trashed', 'undoing'])
const FREES_SPACE = new Set<Phase>(['deleting', 'emptying'])

function Bold({bytes}: {bytes: number}) {
  return <b className="font-medium text-foreground">{formatBytes(bytes)}</b>
}

function FreeSpace({phase, disk, total}: {phase: Phase; disk: Figures; total: number}) {
  const {bin} = usePlatform()
  if (phase === 'scanning' || phase === 'reviewing') {
    return (
      <>
        free space goes from <Bold bytes={disk.before} /> to <Bold bytes={disk.after} /> of {formatBytes(total)}
      </>
    )
  }
  const moved = disk.after !== disk.before
  if (KEEPS_SPACE.has(phase) && !moved) {
    return (
      <>
        free space <Bold bytes={disk.free} /> of {formatBytes(total)} · {bin('the Trash keeps the space until it is emptied')}
      </>
    )
  }
  if (!moved) {
    return (
      <>
        free space <Bold bytes={disk.free} /> of {formatBytes(total)}
        {FREES_SPACE.has(phase) && ' · updates as space comes back'}
      </>
    )
  }
  return (
    <>
      free space was <Bold bytes={disk.before} />, now <Bold bytes={disk.after} /> of {formatBytes(total)}
    </>
  )
}

function heroLabel(phase: Phase, progress: CleanupProgress | null) {
  if (progress && isPutBack(phase, progress)) return 'Put back'
  return HERO_LABEL[phase]
}

export function Summary({
  disk: data,
  selection,
  bytes,
  overlay,
  counter,
  status,
  scanning,
  phase,
  progress = null,
}: {
  disk: Disk
  selection: Selection
  bytes: number
  overlay: ReactNode
  counter: ReactNode
  status: ReactNode
  scanning: boolean
  phase: Phase
  progress?: CleanupProgress | null
}) {
  const disk = diskFigures(data, selection, progress, phase)
  const {bin} = usePlatform()
  return (
    <section className="relative isolate flex items-center gap-7 border-b px-7 py-5">
      <LoadingBackdrop scanning={scanning} />
      <DiskDonut used={disk.used} selected={disk.pending} free={disk.free} total={data.total} size={132} />
      <div className="flex grow flex-col gap-2">
        <div className="text-xs text-muted-foreground">{bin(heroLabel(phase, progress))}</div>
        <div className="relative h-12 text-5xl leading-none font-bold tracking-tighter tabular-nums">
          <div className={overlay ? 'invisible w-fit' : 'w-fit'}>
            <SpinningBytes bytes={bytes} />
          </div>
          {overlay}
        </div>
        {counter}
        <div className="text-[13px] text-muted-foreground">
          {plural(selection.selected.length, 'item', 'items')} in {plural(selection.sections, 'section', 'sections')} ·{' '}
          <FreeSpace phase={phase} disk={disk} total={data.total} />
        </div>
        <div className="flex h-5 items-center gap-3">{status}</div>
      </div>
      <div className="flex w-60 shrink-0 flex-col gap-2 self-start text-xs text-muted-foreground">
        <Legend color={DISK_COLORS.used} label="Used" />
        <Legend color={DISK_COLORS.selected} label="Selected" />
        <Legend color={DISK_COLORS.free} label="Free" outlined />
        <div className={`line-clamp-2 h-8 ${selection.apparentBytes > 0 ? '' : 'invisible'}`} aria-hidden={selection.apparentBytes === 0}>
          + ≈{formatBytes(selection.apparentBytes)} apparent (Docker VM, clones), not counted
        </div>
      </div>
    </section>
  )
}
