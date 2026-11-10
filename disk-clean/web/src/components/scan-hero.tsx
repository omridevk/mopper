import {formatBytes, plural} from '@/lib/data'
import {useDb} from '@/lib/db'
import type {ScanState as Scan} from '@/lib/scan-feed'
import {useScanProgress} from '@/lib/views'

const DIR_CHARS = 64
const SCANNING = 'Scanning your disk…'

function shorten(dir: string) {
  return dir.length > DIR_CHARS ? `…${dir.slice(-(DIR_CHARS - 1))}` : dir
}

function ScanOverlay() {
  return (
    <span className="absolute top-0 left-0 whitespace-nowrap">
      <span aria-hidden className="t-shimmer" data-text={SCANNING}>
        {SCANNING}
      </span>
      <span className="sr-only">{SCANNING}</span>
    </span>
  )
}

export function useScanHero(live: boolean, scan: Scan, selected: number) {
  const scanning = live && !scan.walked && scan.error === '' && scan.rescans === 0
  return {bytes: selected, overlay: scanning ? <ScanOverlay /> : null}
}

export function ScanCounter({scan}: {scan: Scan}) {
  const {files, bytes, dir} = useScanProgress(useDb())
  return (
    <div className="flex h-5 min-w-0 items-baseline gap-3 text-[13px] text-muted-foreground tabular-nums">
      <span className="w-64 shrink-0">
        {plural(files, 'file', 'files')} · {formatBytes(bytes)}
        {scan.walked ? ' scanned' : ''}
      </span>
      <span className="truncate font-mono text-xs text-muted-foreground/70" title={dir}>
        {scan.walked ? '' : shorten(dir)}
      </span>
    </div>
  )
}
