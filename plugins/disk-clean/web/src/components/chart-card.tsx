import {portal} from '@tanstack/charts/tooltip/portal'
import {tooltip} from '@tanstack/charts/tooltip'
import {Link, type LinkOptions} from '@tanstack/react-router'
import {useState, type ReactNode} from 'react'
import {Button, buttonVariants} from '@/components/ui/button'
import {pick} from '@/lib/api'
import {formatBytes} from '@/lib/data'
import {useDb} from '@/lib/db'
import {useSelection} from '@/lib/page-data'
import {useListed} from '@/lib/views'
import {usePlatform} from '@/lib/platform'

export const CARD_TOOLTIP = {
  use: tooltip,
  portal,
  anchor: 'point',
  placement: ['right', 'left', 'bottom', 'top'],
  offset: 14,
  className: 'chart-card',
} as const

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 31_536_000],
  ['month', 2_592_000],
  ['week', 604_800],
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60],
]

export function changedAgo(mtime: number, now = Date.now() / 1000) {
  const seconds = Math.max(0, now - mtime)
  const [unit, size] = UNITS.find(([, s]) => seconds >= s) ?? ['minute', 60]
  return new Intl.RelativeTimeFormat('en', {numeric: 'auto'}).format(-Math.floor(seconds / size), unit)
}

export const shareOf = (part: number, whole: number) => (whole > 0 ? part / whole : 0)

function percent(share: number) {
  if (share > 0 && share < 0.001) return '<0.1%'
  return `${(share * 100).toFixed(1)}%`
}

function middle(text: string, max = 46) {
  if (text.length <= max) return text
  const head = Math.ceil((max - 1) / 2)
  return `${text.slice(0, head)}…${text.slice(text.length - (max - 1 - head))}`
}

interface CardProps {
  title: string
  subtitle?: string
  hint?: string
  pinned?: boolean
  actions?: ReactNode
  children: ReactNode
}

export function ChartCard({title, subtitle, hint = 'Click to pin', pinned = false, actions, children}: CardProps) {
  return (
    <div className="flex w-72 flex-col gap-3 text-xs text-popover-foreground">
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="truncate text-sm font-semibold">{title}</div>
        {subtitle && (
          <div className="truncate font-mono text-[11px] text-muted-foreground" title={subtitle}>
            {middle(subtitle)}
          </div>
        )}
      </div>
      {children}
      {pinned && actions && <div className="flex flex-wrap gap-2 border-t pt-2.5">{actions}</div>}
      {!pinned && hint && <div className="border-t pt-2 text-[11px] text-muted-foreground">{hint}</div>}
    </div>
  )
}

export function Meter({label, value, share, color = 'var(--color-blue-400)'}: {label: ReactNode; value?: ReactNode; share: number; color?: string}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 truncate text-muted-foreground">{label}</span>
        <span className="shrink-0 font-medium tabular-nums">{value ?? percent(share)}</span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full" style={{width: `${Math.min(100, Math.max(0, share * 100))}%`, background: color}} />
      </div>
    </div>
  )
}

export function Fact({label, value}: {label: ReactNode; value: ReactNode}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium tabular-nums">{value}</span>
    </div>
  )
}

export function BigBytes({bytes}: {bytes: number}) {
  return <div className="text-2xl leading-none font-bold tracking-tight tabular-nums">{formatBytes(bytes)}</div>
}

export function CopyPath({path}: {path: string}) {
  const [said, setSaid] = useState('Copy path')
  const shown = usePlatform().path
  const copy = () =>
    navigator.clipboard.writeText(shown(path)).then(
      () => setSaid('Copied'),
      () => setSaid("Couldn't copy"),
    )
  return (
    <Button size="xs" variant="outline" onClick={copy}>
      {said}
    </Button>
  )
}

const reasonOf = (e: unknown) => (e instanceof Error && 'text' in e && typeof e.text === 'string' && e.text ? e.text : String(e))

export function SelectForDelete({path}: {path: string}) {
  const db = useDb()
  const {rowSelection, setRowSelection} = useSelection()
  const listed = useListed(db, path)
  const [note, setNote] = useState<{path: string; text: string} | null>(null)
  const on = listed && rowSelection[path] === true
  const said = note?.path === path && !(listed && note.text === 'Adding…') ? note.text : ''
  const toggle = () => {
    if (listed)
      return setRowSelection(prev => {
        const {[path]: _was, ...rest} = prev
        return on ? rest : {...rest, [path]: true}
      })
    setNote({path, text: 'Adding…'})
    pick(db.loaded.token, path).then(
      () => undefined,
      (e: unknown) => setNote({path, text: `Not added: ${reasonOf(e)}`}),
    )
  }
  return (
    <Button size="xs" variant={on ? 'default' : 'outline'} aria-pressed={on} onClick={toggle} disabled={said === 'Adding…'}>
      {said || (on ? 'Selected · remove' : 'Select for delete')}
    </Button>
  )
}

export function CardLink({to, onClick, children}: {to: LinkOptions; onClick: () => void; children: ReactNode}) {
  return (
    <Link {...to} onClick={onClick} className={buttonVariants({size: 'xs', variant: 'outline'})}>
      {children}
    </Link>
  )
}
