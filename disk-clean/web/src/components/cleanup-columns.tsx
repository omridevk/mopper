import {createColumnHelper, metaHelper, rowSelectionFeature, tableFeatures, type Row} from '@tanstack/react-table'
import {Loader2} from 'lucide-react'
import {Checkbox} from '@/components/ui/checkbox'
import {formatBytes, isExact, isPickable} from '@/lib/data'
import {usePlatform} from '@/lib/platform'
import type {CleanupProgress, Outcome} from '@/lib/progress'
import type {Entry} from '@/lib/scan-feed'

interface CleanupMeta {
  progress: CleanupProgress | null
}

export const features = tableFeatures({
  rowSelectionFeature,
  tableMeta: metaHelper<CleanupMeta>(),
})

export type {Entry}

export type EntryRow = Row<typeof features, Entry>

const OUTCOME_TEXT: Record<Outcome['kind'], [string, string]> = {
  removed: ['removed', 'text-muted-foreground'],
  ran: ['ran', 'text-muted-foreground'],
  kept: ['kept', 'text-amber-300'],
  failed: ['not removed', 'text-red-300'],
  trashed: ['in the Trash · undo available', 'text-sky-300'],
  emptied: ['emptied from the Trash', 'text-muted-foreground'],
  restored: ['put back', 'text-foreground'],
}

function pendingText(progress: CleanupProgress) {
  if (progress.cleanup.done || progress.cleanup.abandoned) return 'not run'
  return progress.cleanup.started ? 'in progress' : 'queued'
}

function ItemStatus({path, progress}: {path: string; progress: CleanupProgress}) {
  const outcome = progress.byKey.get(path)
  const {bin} = usePlatform()
  if (!outcome) return <span className="text-xs text-muted-foreground">{pendingText(progress)}</span>
  const [said, tone] = OUTCOME_TEXT[outcome.kind]
  const text = bin(said)
  return <span className={`text-xs ${tone}`}>{outcome.reason ? `${text}: ${outcome.reason}` : text}</span>
}

function shifted(event: Event | undefined) {
  return event instanceof MouseEvent || event instanceof KeyboardEvent ? event.shiftKey : false
}

export function toggleRow(row: EntryRow, checked: boolean, event?: Event) {
  row.getToggleSelectedHandler()({target: {checked}, shiftKey: shifted(event)})
}

function RowCheckbox({row, locked}: {row: EntryRow; locked: boolean}) {
  const {path} = usePlatform()
  if (row.original.checking) return <Loader2 aria-hidden className="size-4 animate-spin text-muted-foreground motion-reduce:animate-none" />
  return (
    <Checkbox
      aria-label={path(row.original.label)}
      checked={row.getIsSelected()}
      disabled={locked || !row.getCanSelect()}
      onCheckedChange={(checked, details) => toggleRow(row, checked, details.event)}
    />
  )
}

function PathCell({row, progress}: {row: EntryRow; progress: CleanupProgress | null}) {
  const item = row.original
  const {path} = usePlatform()
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <span data-label className="truncate font-mono text-[12.5px]">
        {path(item.label)}
      </span>
      {item.checking && (
        <span className="flex min-w-0 gap-1.5 text-xs">
          <span className="shrink-0 text-amber-300">checking…</span>
          <span className="truncate text-muted-foreground">it can be ticked once its check answers</span>
        </span>
      )}
      {item.note && !item.checking && <span className="truncate text-xs text-muted-foreground">{item.note}</span>}
      {progress?.plan.items.has(item.path) && <ItemStatus path={item.path} progress={progress} />}
    </span>
  )
}

function idleText(age: number | undefined) {
  if (age === undefined) return ''
  return age === 0 ? 'today' : `${age}d`
}

const helper = createColumnHelper<typeof features, Entry>()

export const columns = helper.columns([
  helper.display({
    id: 'select',
    header: () => <span className="sr-only">Selected</span>,
    cell: ({row, table}) => <RowCheckbox row={row} locked={table.options.meta?.progress != null} />,
  }),
  helper.accessor('label', {
    header: 'Path',
    cell: ({row, table}) => <PathCell row={row} progress={table.options.meta?.progress ?? null} />,
  }),
  helper.accessor(row => row.age ?? undefined, {
    id: 'age',
    header: () => <span className="block text-right">Idle</span>,
    cell: ({getValue}) => {
      const age = getValue()
      return <span className={`block text-right text-xs tabular-nums ${age !== undefined && age >= 90 ? 'text-amber-300' : 'text-muted-foreground'}`}>{idleText(age)}</span>
    },
  }),
  helper.accessor('bytes', {
    header: () => <span className="block text-right">Size</span>,
    cell: ({row}) => (
      <span className="block text-right text-[13px] font-medium tabular-nums">
        {isExact(row.original) ? '' : '≈'}
        {formatBytes(row.original.bytes)}
      </span>
    ),
  }),
])

export const enableRowSelection = (row: EntryRow) => isPickable(row.original)
