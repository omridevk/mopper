import {useHotkeys, type Hotkey} from '@tanstack/react-hotkeys'
import {useNavigate} from '@tanstack/react-router'
import {Eraser, Info, RotateCcw, Trash2, X} from 'lucide-react'
import {createContext, use, useState, type AnimationEvent, type ReactNode, type RefObject} from 'react'
import {Button} from '@/components/ui/button'
import {Kbd} from '@/components/ui/kbd'
import {Popover, PopoverContent, PopoverTitle, PopoverTrigger} from '@/components/ui/popover'
import {Tooltip, TooltipContent, TooltipTrigger} from '@/components/ui/tooltip'
import {bindingsOf, HOTKEY_OPTIONS, type Command} from '@/lib/commands'
import type {CleanupProgress, Phase} from '@/lib/progress'
import {formatBytes, plural, sizeOf} from '@/lib/data'
import {cssMs, useReducedMotion} from '@/lib/motion'
import {useDb} from '@/lib/db'
import {firstSectionNow, type Selection} from '@/lib/page-data'
import {usePlatform} from '@/lib/platform'
import type {ScanState} from '@/lib/scan-feed'
import {ProgressFooter} from './cleanup-progress'
import {PopBytes} from './numbers'
import FuseButton from './react-bits/fuse-button'
import {useSelectionWarnings, WarningChip} from './selection-warnings'

function UndoCountdown({ms}: {ms: number}) {
  const steps = Math.ceil(ms / 1000)
  const [left, setLeft] = useState(steps)
  const tick = (event: AnimationEvent<HTMLSpanElement>) => setLeft(Math.max(0, steps - Math.round(event.elapsedTime)))
  return (
    <span
      className="t-clock"
      style={{animationDuration: '1000ms', animationIterationCount: steps, animationDelay: `${ms - steps * 1000}ms`}}
      onAnimationIteration={tick}
      onAnimationEnd={() => setLeft(0)}
    >
      Undo ({left}s)
    </span>
  )
}

function undoLabel(reduced: boolean, armed: boolean, ms: number) {
  if (!reduced) return 'Undo'
  return armed ? <UndoCountdown ms={ms} /> : `Undo (${Math.ceil(ms / 1000)}s)`
}

interface FuseAction {
  label: string
  doneLabel: string
  icon: ReactNode
  background: string
  color: string
  onCommit: () => void
}

function FuseAction({label, doneLabel, icon, background, color, onCommit}: FuseAction) {
  const reduced = useReducedMotion()
  const undoWindow = cssMs('--fuse-window', 4000)
  const [armed, setArmed] = useState(false)
  return (
    <FuseButton
      label={label}
      undoLabel={undoLabel(reduced, armed, undoWindow)}
      doneLabel={doneLabel}
      icon={icon}
      size="sm"
      radius={8}
      className="shrink-0"
      background={background}
      color={color}
      fuseColor={reduced ? 'transparent' : '#ef4444'}
      fuseThickness={2}
      undoWindow={undoWindow}
      commitOn="fuseEnd"
      onCommit={onCommit}
      onPhaseChange={phase => setArmed(phase === 'armed')}
    />
  )
}

function hint(scan: ScanState) {
  return !scan.done && scan.error === '' ? 'You can delete what is listed while the scan runs.' : 'Cancel gives you a few seconds to undo.'
}

export const DELETE: Hotkey = 'Mod+Backspace'

function HelpLine({scan, about, onAbout}: {scan: ScanState; about: boolean; onAbout: (open: boolean) => void}) {
  const {trash, restoreByHand, deleteNow, label, bin} = usePlatform()
  return (
    <div className="flex h-5 items-center gap-1 text-xs whitespace-nowrap text-muted-foreground">
      {bin('Delete moves files to the Trash, so you can undo')}
      <Popover open={about} onOpenChange={onAbout}>
        <PopoverTrigger render={<Button variant="ghost" size="icon-xs" aria-label="About deleting" />}>
          <Info />
        </PopoverTrigger>
        <PopoverContent side="top" align="start" className="w-80 text-xs">
          <PopoverTitle className="text-sm">How Delete works</PopoverTitle>
          <p className="text-muted-foreground">
            Delete moves files to {trash}. Undo puts them back; {restoreByHand} works too. {bin('Space comes back when the Trash is emptied.')}
          </p>
          <p className="text-muted-foreground">{bin("Delete immediately skips the Trash and can't be undone. Worktrees and commands can't be undone either.")}</p>
          <p className="flex flex-wrap items-center gap-1 text-muted-foreground">
            Delete <Kbd>{label(DELETE)}</Kbd> · Delete immediately <Kbd>{label(deleteNow[0])}</Kbd> or <Kbd>{label(deleteNow[1])}</Kbd>
          </p>
          <p className="text-muted-foreground">{hint(scan)}</p>
        </PopoverContent>
      </Popover>
    </div>
  )
}

export function deleteState(selection: Selection, scan: ScanState) {
  const count = selection.selected.length
  if (scan.error !== '') return {label: 'The scan failed · nothing can be deleted', ready: false}
  if (count > 0) return {label: `Delete ${plural(count, 'item', 'items')} · ${sizeOf(selection.exactBytes, selection.apparentBytes)}`, ready: true}
  if (selection.selectable > 0) return {label: 'Select items to delete', ready: false}
  if (!scan.done) return {label: 'Scanning… nothing found yet', ready: false}
  return {label: 'Nothing found to delete', ready: false}
}

function SelectionButton({label, icon, hotkey, reason, onClick}: {label: string; icon: ReactNode; hotkey: Hotkey; reason: string; onClick: () => void}) {
  const keys = usePlatform()
  const described = reason ? `${label}: ${reason}` : label
  return (
    <Tooltip>
      <TooltipTrigger delay={80} render={<span className="inline-flex" />}>
        <Button variant="ghost" size="icon-xs" disabled={reason !== ''} aria-label={described} onClick={onClick}>
          {icon}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {described}
        <Kbd>{keys.label(hotkey)}</Kbd>
      </TooltipContent>
    </Tooltip>
  )
}

export function useOpenConfirm() {
  const db = useDb()
  const navigate = useNavigate()
  return (now: boolean) => navigate({to: '/cleanup/$section/confirm', params: prev => ({section: prev.section ?? firstSectionNow(db) ?? ''}), search: prev => ({...prev, now})})
}

export const TableDelete = createContext<Command | null>(null)

export function useTableDeleteKeys(table: RefObject<HTMLElement | null>) {
  const command = use(TableDelete)
  useHotkeys(bindingsOf(command ? [command] : []), {...HOTKEY_OPTIONS, target: table})
}

export function ActionBar({
  selection,
  scan,
  progress = null,
  phase,
  actions,
  last,
  failure,
  about,
  onAbout,
  onCancel,
  onDelete,
}: {
  selection: Selection
  scan: ScanState
  progress?: CleanupProgress | null
  phase: Phase
  actions?: ReactNode
  last?: ReactNode
  failure?: ReactNode
  about: boolean
  onAbout: (open: boolean) => void
  onCancel: () => void
  onDelete: (now: boolean) => void
}) {
  const warnings = useSelectionWarnings(selection)
  const action = deleteState(selection, scan)
  const {deleteNow, label, bin} = usePlatform()
  if (progress) return <ProgressFooter progress={progress} phase={phase} actions={actions} />
  const count = selection.selected.length

  return (
    <footer className="flex items-center gap-2.5 border-t bg-card px-7 py-3.5">
      <div className="flex min-w-0 grow flex-col gap-0.5">
        <div className="flex h-6 items-center gap-1">
          <div className="w-64 shrink-0 truncate text-sm font-semibold tabular-nums">
            {plural(count, 'item', 'items')} selected · {selection.exactBytes === 0 && selection.apparentBytes > 0 ? `≈${formatBytes(selection.apparentBytes)}` : <PopBytes bytes={selection.exactBytes} />}
          </div>
          <SelectionButton label="Clear selection" icon={<Eraser />} hotkey="D" reason={count === 0 ? 'nothing is selected' : ''} onClick={selection.clear} />
          <SelectionButton label="Reset to recommended" icon={<RotateCcw />} hotkey="R" reason={selection.recommended ? 'already the recommended selection' : ''} onClick={selection.reset} />
          <div className="flex min-w-0 grow pl-2">
            <WarningChip warnings={warnings} />
          </div>
        </div>
        {last ?? <HelpLine scan={scan} about={about} onAbout={onAbout} />}
        {failure}
      </div>
      {last && actions}
      <FuseAction label="Cancel" doneLabel="Cancelling" icon={<X />} background="transparent" color="var(--foreground)" onCommit={onCancel} />
      <Tooltip>
        <TooltipTrigger delay={80} render={<span className="inline-flex shrink-0" />}>
          <Button variant="outline" size="lg" disabled={!action.ready} aria-haspopup="dialog" onClick={() => onDelete(true)}>
            Delete immediately…
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {bin("Skips the Trash, can't be undone")}
          <Kbd>{label(deleteNow[0])}</Kbd>
        </TooltipContent>
      </Tooltip>
      <Button size="lg" className="w-80 shrink-0 justify-start" disabled={!action.ready} aria-haspopup="dialog" onClick={() => onDelete(false)}>
        <Trash2 /> {action.label}
      </Button>
    </footer>
  )
}
