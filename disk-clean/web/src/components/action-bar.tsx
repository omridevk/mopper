import {useHotkeys, type Hotkey} from '@tanstack/react-hotkeys'
import {useNavigate} from '@tanstack/react-router'
import {Eraser, Info, RotateCcw, Trash2} from 'lucide-react'
import {createContext, use, useState, type ReactNode, type RefObject} from 'react'
import {Button} from '@/components/ui/button'
import {Kbd} from '@/components/ui/kbd'
import {Popover, PopoverContent, PopoverTitle, PopoverTrigger} from '@/components/ui/popover'
import {Tooltip, TooltipContent, TooltipTrigger} from '@/components/ui/tooltip'
import {bindingsOf, HOTKEY_OPTIONS, type Command} from '@/lib/commands'
import type {CleanupProgress, Phase} from '@/lib/progress'
import {formatBytes, plural, sizeOf} from '@/lib/data'
import {useDb} from '@/lib/db'
import {firstSectionNow, type Selection} from '@/lib/page-data'
import {usePlatform} from '@/lib/platform'
import type {ScanState} from '@/lib/scan-feed'
import {ProgressFooter} from './cleanup-progress'
import {PopBytes} from './numbers'
import {useSelectionWarnings, WarningChip} from './selection-warnings'

function hint(scan: ScanState) {
  return !scan.done && scan.error === '' ? 'You can delete what is listed while the scan runs.' : 'Delete as many times as you like; End session (top right) closes this page for deleting.'
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

export function EndSession({onEnd, disabled}: {onEnd: () => void; disabled: boolean}) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger disabled={disabled} render={<Button variant="ghost" size="sm" className="shrink-0" />}>End session…</PopoverTrigger>
      <PopoverContent side="bottom" align="end" className="flex w-72 flex-col gap-3 text-xs">
        <PopoverTitle className="text-sm">End this session?</PopoverTitle>
        <p className="text-muted-foreground">Nothing more can be deleted from this page. What is already in the Trash keeps its Undo in the Trash tab.</p>
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => setOpen(false)}>
            Keep going
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => {
              setOpen(false)
              onEnd()
            }}
          >
            End session
          </Button>
        </div>
      </PopoverContent>
    </Popover>
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

function SelectionButton({label, short, icon, hotkey, reason, onClick}: {label: string; short: string; icon: ReactNode; hotkey: Hotkey; reason: string; onClick: () => void}) {
  const keys = usePlatform()
  const described = reason ? `${label}: ${reason}` : label
  return (
    <Tooltip>
      <TooltipTrigger delay={80} render={<span className="inline-flex" />}>
        <Button variant="ghost" size="xs" disabled={reason !== ''} aria-label={described} onClick={onClick}>
          {icon}
          {short}
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
          <SelectionButton label="Clear selection" short="Clear" icon={<Eraser className="max-xl:hidden" />} hotkey="D" reason={count === 0 ? 'nothing is selected' : ''} onClick={selection.clear} />
          <SelectionButton label="Reset to recommended" short="Reset" icon={<RotateCcw className="max-xl:hidden" />} hotkey="R" reason={selection.recommended ? 'already the recommended selection' : ''} onClick={selection.reset} />
          <div className="flex min-w-0 grow pl-2">
            <WarningChip warnings={warnings} />
          </div>
        </div>
        {last ?? <HelpLine scan={scan} about={about} onAbout={onAbout} />}
        {failure}
      </div>
      {last && actions}
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
