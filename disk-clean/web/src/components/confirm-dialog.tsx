import {useVirtualizer} from '@tanstack/react-virtual'
import {Loader2} from 'lucide-react'
import {Fragment, useRef, type ReactNode, type RefObject} from 'react'
import {Button} from '@/components/ui/button'
import {Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle} from '@/components/ui/dialog'
import type {Mode, Plan} from '@/lib/api'
import {counted, formatBytes, plural, tilde, tildeWords, type Platform} from '@/lib/data'
import {textIn} from '@/lib/platform'
import {WarningLines, type SelectionWarnings} from './selection-warnings'

const ROW = 28

function Group({title, note, tone, children}: {title: string; note: string; tone: string; children: ReactNode}) {
  return (
    <section className="flex min-w-0 flex-col gap-1.5">
      <h3 className={`text-sm font-semibold ${tone}`}>
        {title} <span className="font-normal text-muted-foreground">· {note}</span>
      </h3>
      {children}
    </section>
  )
}

function TailPath({path}: {path: string}) {
  return (
    <span className="min-w-0 grow truncate text-left [direction:rtl]">
      <bdi dir="ltr">{path}</bdi>
    </span>
  )
}

function PathRows({rows, home, path, label}: {rows: Plan['paths']; home: string; path: (path: string) => string; label: string}) {
  const scroller = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({count: rows.length, getScrollElement: () => scroller.current, estimateSize: () => ROW, overscan: 12})
  return (
    <div ref={scroller} className="max-h-[30vh] overflow-y-auto rounded-lg border bg-background">
      <ul aria-label={label} className="relative" style={{height: virtualizer.getTotalSize()}}>
        {virtualizer.getVirtualItems().map(virtual => {
          const row = rows[virtual.index]
          return (
            row && (
              <li
                key={row.path}
                aria-setsize={rows.length}
                aria-posinset={virtual.index + 1}
                className="absolute top-0 left-0 flex w-full items-center gap-3 px-3 font-mono text-xs"
                style={{height: ROW, transform: `translateY(${virtual.start}px)`}}
              >
                <TailPath path={path(tilde(row.path, home))} />
                <span className="shrink-0 text-muted-foreground tabular-nums">{formatBytes(row.bytes)}</span>
              </li>
            )
          )
        })}
      </ul>
    </div>
  )
}

function Word({word}: {word: string}) {
  return word.split(/(?<=[/\\])/).map((part, i) => (
    <Fragment key={i}>
      {i > 0 && <wbr />}
      <span className="whitespace-nowrap">{part}</span>
    </Fragment>
  ))
}

function Breakable({text}: {text: string}) {
  return text.split(' ').map((word, i) => (
    <Fragment key={i}>
      {i > 0 && ' '}
      <Word word={word} />
    </Fragment>
  ))
}

function Lines({label, lines}: {label: string; lines: string[]}) {
  return (
    <ul aria-label={label} className="max-h-[22vh] divide-y overflow-y-auto rounded-lg border bg-background font-mono text-xs leading-relaxed">
      {lines.map((line, i) => (
        <li key={i} className="overflow-x-auto py-1.5 pr-3 pl-7 -indent-4">
          <Breakable text={line} />
        </li>
      ))}
    </ul>
  )
}

interface Split {
  trash: Plan['paths']
  gone: Plan['paths']
  trashBytes: number
  goneBytes: number
}

const bytesOf = (rows: Plan['paths']) => rows.reduce((sum, row) => sum + row.bytes, 0)

function splitOf(plan: Plan, mode: Mode): Split {
  const trash = mode === 'trash' ? plan.paths.filter(row => !row.trashed) : []
  const gone = mode === 'trash' ? plan.paths.filter(row => row.trashed) : plan.paths
  return {trash, gone, trashBytes: bytesOf(trash), goneBytes: bytesOf(gone)}
}

function confirmLabel(plan: Plan, mode: Mode, split: Split) {
  if (mode === 'now') return `Delete ${plural(plan.count, 'item', 'items')} immediately · ${formatBytes(plan.bytes)}`
  const final = plan.final_count + split.gone.length
  if (split.trash.length === 0) return `Delete ${plural(plan.count, 'item', 'items')}`
  const rest = final > 0 ? ` + ${final} that can't be undone` : ''
  return `Move ${plural(split.trash.length, 'item', 'items')} to the Trash${rest}`
}

function Totals({plan, mode, split, bin}: {plan: Plan; mode: Mode; split: Split; bin: (text: string) => string}) {
  const figures = [
    {n: formatBytes(plan.bytes), label: `${plural(plan.count, 'item', 'items')} in total`},
    mode === 'trash'
      ? {n: formatBytes(split.trashBytes), label: bin(`${counted(split.trash.length)} to the Trash`)}
      : {n: formatBytes(split.goneBytes), label: `${counted(split.gone.length)} deleted for good`},
    {n: counted(plan.final_count + (mode === 'trash' ? split.gone.length : 0)), label: mode === 'trash' ? "can't be undone" : 'worktrees and commands'},
    {n: counted(plan.rejected.length), label: 'rejected'},
  ]
  return (
    <div className="grid grid-cols-4 gap-2">
      {figures.map(f => (
        <div key={f.label} className="flex flex-col rounded-lg border px-3 py-2">
          <span className="text-lg font-semibold tabular-nums">{f.n}</span>
          <span className="text-xs text-muted-foreground">{f.label}</span>
        </div>
      ))}
    </div>
  )
}

function Difference({plan, selected}: {plan: Plan; selected: number}) {
  if (plan.rejected.length === 0 || selected === plan.count) return null
  return (
    <p className="text-sm text-muted-foreground">
      You selected {plural(selected, 'item', 'items')}; {counted(plan.rejected.length)} rejected by the safety checks, see below, so {plural(plan.count, 'item runs', 'items run')}.
    </p>
  )
}

function Body({plan, mode, home, platform, selected}: {plan: Plan; mode: Mode; home: string; platform: Platform | undefined; selected: number}) {
  const {path, bin, removeForGood} = textIn(platform)
  const split = splitOf(plan, mode)
  const gone = split.gone.map(row => removeForGood(row.path, home))
  const final = [...gone, ...plan.final.map(line => tildeWords(line, home, path))]
  return (
    <>
      <Totals plan={plan} mode={mode} split={split} bin={bin} />
      <Difference plan={plan} selected={selected} />
      {split.trash.length > 0 && (
        <Group title={bin('Moved to the Trash (undo available)')} note={bin('space comes back when the Trash is emptied')} tone="text-foreground">
          <PathRows rows={split.trash} home={home} path={path} label={bin('Moved to the Trash')} />
        </Group>
      )}
      {mode === 'now' && split.gone.length > 0 && (
        <Group title="Deleted immediately" note={bin("skips the Trash, can't be undone")} tone="text-destructive">
          <PathRows rows={split.gone} home={home} path={path} label="Deleted immediately" />
        </Group>
      )}
      {(mode === 'trash' ? final : plan.final).length > 0 && (
        <Group title="Can't be undone" note={mode === 'trash' ? bin('items already in a Trash, worktree removals and fixed commands run exactly as below') : 'worktree removals and fixed commands run exactly as below'} tone="text-amber-300">
          <Lines label="Can't be undone" lines={mode === 'trash' ? final : plan.final.map(line => tildeWords(line, home, path))} />
        </Group>
      )}
      {plan.rejected.length > 0 && (
        <Group title="Rejected by the safety checks" note="these stay where they are" tone="text-destructive">
          <Lines label="Rejected by the safety checks" lines={plan.rejected.map(r => `${path(tilde(r.path, home))}: ${r.reason}`)} />
        </Group>
      )}
    </>
  )
}

function Checking() {
  return (
    <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin motion-reduce:animate-none" /> Checking the selection…
    </p>
  )
}

function Decision({
  plan,
  mode,
  home,
  platform,
  selected,
  cancelRef,
  onCancel,
  onConfirm,
}: {
  plan: Plan | null
  mode: Mode
  home: string
  platform: Platform | undefined
  selected: number
  cancelRef: RefObject<HTMLButtonElement | null>
  onCancel: () => void
  onConfirm: () => void
}) {
  const {bin} = textIn(platform)
  return (
    <>
      {plan ? <Body plan={plan} mode={mode} home={home} platform={platform} selected={selected} /> : <Checking />}
      <DialogFooter className="items-center">
        <span className="grow text-xs text-muted-foreground">
          Same list in the terminal: <code className="font-mono text-zinc-300">disk-clean clean --dry-run</code>
        </span>
        <Button ref={cancelRef} variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="destructive" disabled={!plan || plan.count === 0} onClick={onConfirm}>
          {plan ? bin(confirmLabel(plan, mode, splitOf(plan, mode))) : mode === 'now' ? 'Delete immediately' : bin('Move to the Trash')}
        </Button>
      </DialogFooter>
    </>
  )
}

interface Exit {
  open: boolean
  onClose: () => void
  onClosed: () => void
}

const SCAN_RUNNING = 'The scan is still running; confirming stops it and uses what was found so far.'

const NO_WARNINGS: SelectionWarnings = {hidden: [], risky: 0}

const TITLE: Record<Mode, string> = {trash: 'Move to the Trash', now: "Delete immediately? This can't be undone"}

export function ConfirmDialog({
  plan,
  mode = 'trash',
  home,
  platform,
  selected = 0,
  scanning = false,
  warnings = NO_WARNINGS,
  open,
  onClose,
  onClosed,
  onConfirm,
}: Exit & {plan: Plan | null; mode?: Mode; home: string; platform?: Platform; selected?: number; scanning?: boolean; warnings?: SelectionWarnings; onConfirm: () => void}) {
  const warned = warnings.hidden.length > 0 || warnings.risky > 0
  const cancel = useRef<HTMLButtonElement>(null)
  const {bin} = textIn(platform)
  return (
    <Dialog open={open} onOpenChange={next => next || onClose()} onOpenChangeComplete={next => next || onClosed()}>
      <DialogContent className="sm:max-w-3xl" initialFocus={mode === 'now' ? cancel : undefined}>
        <DialogHeader>
          <DialogTitle>{bin(TITLE[mode])}</DialogTitle>
          <DialogDescription>
            {mode === 'now' && <b className="font-semibold text-destructive">{bin('These skip the Trash and are removed for good. ')}</b>}
            Nothing has run yet. Each path is resolved again right before it moves and is kept if a parent folder now points
            elsewhere; a symlink is moved itself, never followed. Worktrees are re-checked and git refuses any that changed.
          </DialogDescription>
        </DialogHeader>
        {scanning && <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">{SCAN_RUNNING}</p>}
        {warned && <WarningLines warnings={warnings} className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm" />}
        <Decision plan={plan} mode={mode} home={home} platform={platform} selected={selected} cancelRef={cancel} onCancel={onClose} onConfirm={onConfirm} />
      </DialogContent>
    </Dialog>
  )
}

export function ConfirmFailed({message, open, onClose, onClosed, onRetry}: Exit & {message: string; onRetry: () => void}) {
  return (
    <Dialog open={open} onOpenChange={next => next || onClose()} onOpenChangeComplete={next => next || onClosed()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Couldn't check the selection</DialogTitle>
          <DialogDescription>Nothing was deleted. {message}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={onRetry}>Retry</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
