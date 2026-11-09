import {RotateCw} from 'lucide-react'
import {useState} from 'react'
import {Button} from '@/components/ui/button'
import {useClock} from '@/lib/clock'
import {plural} from '@/lib/data'
import type {ScanState as Scan} from '@/lib/scan-feed'
import LatticeLoader from './react-bits/lattice-loader'

function statusOf(scan: Scan) {
  if (scan.error) return 'error'
  return scan.done || scan.stopped ? 'done' : 'working'
}

function phaseOf(scan: Scan) {
  if (!scan.walked) return scan.rescans > 0 ? 'Rescanning' : 'Walking disk'
  return `Checking ${plural(scan.worktrees, 'worktree', 'worktrees')}`
}

function useScanClock(elapsed: number, running: boolean) {
  const [last, setLast] = useState({elapsed, at: performance.now()})
  const now = useClock(running)
  if (last.elapsed !== elapsed) setLast({elapsed, at: performance.now()})
  return running ? elapsed + Math.max(0, now - last.at) : elapsed
}

export function ScanStatus({scan}: {scan: Scan}) {
  const status = statusOf(scan)
  const clock = useScanClock(scan.elapsed, status === 'working')
  const phase = phaseOf(scan)
  const phaseStart = scan.walked && status === 'working' ? scan.walkedAt : 0
  return (
    <LatticeLoader
      key={phase}
      label={phase}
      doneLabel={scan.stopped && !scan.done ? 'Scan stopped at approval' : 'Scan complete'}
      errorLabel="Scan failed"
      status={status}
      elapsed={(clock - phaseStart) / 1000}
      fontSize={13}
      cellSize={4}
      className="text-muted-foreground"
    />
  )
}

export function RescanButton({scan, active, onRescan}: {scan: Scan; active: boolean; onRescan: () => void}) {
  const busy = !scan.done && scan.error === ''
  if (active) return null
  return (
    <Button variant="ghost" size="xs" disabled={busy} onClick={onRescan}>
      <RotateCw />
      Rescan
    </Button>
  )
}
