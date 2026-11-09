import {useHotkeys} from '@tanstack/react-hotkeys'
import {getRouteApi, Link, linkOptions, Outlet, useLinkProps, useMatch, useNavigate, useParams} from '@tanstack/react-router'
import {HardDrive} from 'lucide-react'
import {useRef, useState, useSyncExternalStore, type ReactNode, type RefObject} from 'react'
import {TAB_LINK, TabLinks} from '@/components/ui/tabs'
import {bindingsOf, everyCommand, HOTKEY_OPTIONS} from '@/lib/commands'
import {plural} from '@/lib/data'
import {useDb, type Action, type Db, type Link as StreamLink} from '@/lib/db'
import {useReducedMotion, useShownOnMount} from '@/lib/motion'
import {firstSectionNow, useDecisions, useProgress, useScan, useSelection, type Ending, type Selection} from '@/lib/page-data'
import {usePlatform} from '@/lib/platform'
import {heroBytes, type CleanupProgress, type Phase} from '@/lib/progress'
import {CLEANUP_DEFAULTS} from '@/lib/search'
import {useDisk, usePending, useScanState, useSession} from '@/lib/views'
import {ActionBar, deleteState, EndSession, TableDelete, useOpenConfirm} from './action-bar'
import {ListingContext, useListChange, useListing} from './cleanup'
import {BarText, CleanupCounter, CleanupStatus, CleanupTracker, DetailsButton, ProgressTrack, RoundResult, TrashActions, trashOffer} from './cleanup-progress'
import {CommandMenu} from './command-menu'
import {commandsFor} from './commands'
import {RequestError} from './request-error'
import {ScanCounter, useScanHero} from './scan-hero'
import {RescanButton, ScanStatus} from './scan-status'
import {BUSY, useTrashActions, useTrashRuns} from './trash-view'
import {Summary} from './summary'

function Finished({title, body}: Ending) {
  const lines = useShownOnMount()
  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-2 p-6 text-center">
      <div ref={lines} className="t-stagger flex flex-col gap-2">
        <h1 className="t-stagger-line t-stagger-line--1 text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="t-stagger-line t-stagger-line--2 text-sm text-muted-foreground">{body}</p>
      </div>
    </div>
  )
}

function ScanProblem({error}: {error: string}) {
  if (!error) return null
  return (
    <div role="alert" className="pointer-events-none absolute inset-x-0 bottom-4 z-20 flex justify-center px-7">
      <p className="pointer-events-auto max-w-2xl rounded-lg border border-destructive/40 bg-card px-4 py-2 text-xs text-destructive shadow-md">
        The scan failed: {error}. Nothing can be approved.
      </p>
    </div>
  )
}

const SCAN_LINK: Record<StreamLink, string> = {
  live: '',
  reconnecting: 'Reconnecting to disk-clean…',
  lost: 'Lost contact with disk-clean: reload to reconnect',
}

function Status({items, progress, phase, link}: {items: number; progress: CleanupProgress | null; phase: Phase; link: StreamLink}) {
  if (progress) {
    return (
      <p className="truncate text-sm leading-5 font-medium text-foreground tabular-nums">
        <BarText progress={progress} phase={phase} />
      </p>
    )
  }
  if (link !== 'live') return <p className="truncate text-sm leading-5 font-medium text-red-300">{SCAN_LINK[link]}</p>
  return <p className="truncate text-sm leading-5 text-muted-foreground">Session open · {plural(items, 'item', 'items')} found · nothing is deleted until you approve</p>
}

const TABS = [
  {id: '/_tabs/cleanup', label: 'Cleanup', link: linkOptions({to: '/cleanup'})},
  {id: '/_tabs/storage', label: 'Storage', link: linkOptions({to: '/storage'})},
  {id: '/_tabs/insights', label: 'Insights', link: linkOptions({to: '/insights'})},
  {id: '/_tabs/trash', label: 'Trash', link: linkOptions({to: '/trash'})},
] as const

const root = getRouteApi('__root__')

function TabLink({tab}: {tab: (typeof TABS)[number]}) {
  const tabs = root.useRouteContext({select: context => context.tabs})
  const last = useSyncExternalStore(tabs.subscribe, () => tabs.placeOf(tab.id)) ?? tab.link
  const active = 'data-status' in useLinkProps({...tab.link, activeOptions: {includeSearch: false}})
  const {bin} = usePlatform()
  return (
    <Link {...last} role="tab" aria-selected={active} className={TAB_LINK}>
      {bin(tab.label)}
    </Link>
  )
}

function Tabs() {
  return (
    <TabLinks label="Views">
      {TABS.map(tab => (
        <TabLink key={tab.id} tab={tab} />
      ))}
    </TabLinks>
  )
}

function Header({
  items,
  progress,
  phase,
  link,
  onDetails,
  detailsRef,
  onEnd,
  ending,
}: {
  items: number
  progress: CleanupProgress | null
  phase: Phase
  link: StreamLink
  onDetails: () => void
  detailsRef: RefObject<HTMLButtonElement | null>
  onEnd: () => void; ending: boolean
}) {
  return (
    <header className="relative flex items-center gap-4 border-b px-7 py-4">
      <div className="flex size-8 items-center justify-center rounded-lg bg-foreground text-background">
        <HardDrive className="size-4" />
      </div>
      <div className="flex min-w-0 grow flex-col">
        <h1 className="text-[15px] font-semibold">Disk Clean</h1>
        <Status items={items} progress={progress} phase={phase} link={link} />
      </div>
      {progress && <DetailsButton ref={detailsRef} onClick={onDetails} />}
      <EndSession onEnd={onEnd} disabled={ending} />
      <Tabs />
      {progress && <ProgressTrack progress={progress} phase={phase} />}
    </header>
  )
}

function StatusSlot({scan, progress, phase}: {scan: ReturnType<typeof useScan>; progress: CleanupProgress | null; phase: Phase}) {
  if (progress) return <span className="w-56 shrink-0"><CleanupStatus progress={progress} phase={phase} /></span>
  return scan.tracking && <span className="w-56 shrink-0"><ScanStatus scan={scan.scan} /></span>
}

function ScanSummary({db, scan, selection, progress, phase, active}: {db: Db; scan: ReturnType<typeof useScan>; selection: Selection; progress: CleanupProgress | null; phase: Phase; active: boolean}) {
  const hero = useScanHero(phase === 'scanning' && scan.live, scan.scan, selection.exactBytes)
  const disk = useDisk(db)
  return (
    <Summary
      disk={disk}
      selection={selection}
      bytes={progress ? heroBytes(phase, progress) : hero.bytes}
      overlay={hero.overlay}
      counter={scan.tracking && (progress ? <CleanupCounter progress={progress} phase={phase} /> : <ScanCounter scan={scan.scan} />)}
      status={
        <>
          <StatusSlot scan={scan} progress={progress} phase={phase} />
          <RescanButton scan={scan.scan} active={active} onRescan={scan.rescan} />
          <RequestError db={db} action="rescan" onRetry={scan.rescan} />
        </>
      }
      scanning={phase === 'scanning' && scan.live && !scan.settled}
      phase={phase}
      progress={progress}
    />
  )
}

const TRASH_ACTIONS: readonly Action[] = ['undo', 'empty']

function useCleanupTrash(db: Db, progress: CleanupProgress | null, phase: Phase, trash: (action: 'undo' | 'empty', ids: readonly string[]) => void, sectionOf: (params: {section?: string}) => string) {
  const navigate = useNavigate()
  const busy = usePending(db, TRASH_ACTIONS)
  const offer = progress && trashOffer(progress, phase, busy)
  const ready = offer !== null && offer.offered && !offer.waiting
  const undo = () => trash('undo', progress?.inTrash.ids ?? [])
  const empty = () => navigate({to: '/cleanup/$section/empty', params: prev => ({section: sectionOf(prev)}), search: true})
  const actions = progress && (
    <TrashActions
      progress={progress}
      phase={phase}
      busy={busy}
      error={
        <>
          <RequestError db={db} action="undo" onRetry={undo} />
          <RequestError db={db} action="empty" onRetry={() => trash('empty', progress.inTrash.ids)} />
        </>
      }
      onUndo={undo}
      onEmpty={empty}
    />
  )
  return {ready, undo, empty, actions}
}

function Tracker({progress, ...props}: {db: Db; progress: CleanupProgress | null; phase: Phase; returnFocus: RefObject<HTMLButtonElement | null>; actions: ReactNode}) {
  return progress && <CleanupTracker progress={progress} {...props} />
}

function Failures({db, onApprove, onCancel}: {db: Db; onApprove: () => void; onCancel: () => void}) {
  return (
    <>
      <RequestError db={db} action="approve" onRetry={onApprove} />
      <RequestError db={db} action="cancel" onRetry={onCancel} />
    </>
  )
}

export function Shell() {
  const db = useDb()
  const scan = useScan()
  const selection = useSelection()
  const {progress, phase, idle, active} = useProgress()
  const decisions = useDecisions()
  const session = useSession(db)
  const navigate = useNavigate()
  const tabs = root.useRouteContext({select: context => context.tabs})
  const detailsRef = useRef<HTMLButtonElement>(null)
  const [about, setAbout] = useState(false)
  const [shortcuts, setShortcuts] = useState(false)
  const sectionOf = (params: {section?: string}) => params.section ?? firstSectionNow(db) ?? ''
  const cleanupTrash = useCleanupTrash(db, progress, phase, decisions.trash, sectionOf)
  const openConfirm = useOpenConfirm()
  const onDetails = () => navigate({to: '.', search: prev => ({...prev, overlay: 'progress'})})
  const list = useMatch({from: '/_tabs/cleanup', shouldThrow: false, select: match => match.search})
  const listing = useListing(db, list ?? CLEANUP_DEFAULTS, selection)
  const onList = useListChange()
  const section = useParams({strict: false, select: params => params.section})
  const shape = useMatch({from: '/_tabs/storage', shouldThrow: false, select: match => match.search.shape})
  const tree = useScanState(db).tree
  const trashSearch = useMatch({from: '/_tabs/trash', shouldThrow: false, select: match => match.search})
  const runs = useTrashRuns()
  const trashBusy = usePending(db, BUSY)
  const trashActions = useTrashActions()
  const reduced = useReducedMotion()
  const {deleteNow, path} = usePlatform()
  const deleteReady = deleteState(selection, scan.scan).ready && !active
  const round = progress && (active || selection.selected.every(entry => progress.plan.items.has(entry.path))) ? progress : null
  const commands = commandsFor({
    tabs: TABS,
    selection,
    progress: active,
    round: progress !== null,
    scanning: !scan.scan.done && scan.scan.error === '',
    deleteReady,
    deleteNow,
    path,
    reduced,
    cleanupTrash: cleanupTrash.ready,
    cleanup: list ? {listing, section, onList} : null,
    storage: shape ? {shape, drawn: tree !== null} : null,
    trash: trashSearch ? {search: trashSearch, runs, busy: trashBusy, actions: trashActions} : null,
    on: {
      tab: id => {
        const tab = TABS.find(each => each.id === id)
        if (tab) void navigate(tabs.placeOf(id) ?? tab.link)
      },
      section: id => navigate({to: '/cleanup/$section', params: {section: id}, search: true}),
      confirm: openConfirm,
      rescan: scan.rescan,
      details: onDetails,
      movie: () => navigate({to: '.', search: prev => ({...prev, overlay: 'movie', take: 0})}),
      undoCleanup: cleanupTrash.undo,
      emptyCleanup: cleanupTrash.empty,
      reshape: next => navigate({to: '.', search: prev => ({...prev, shape: next})}),
      shortcuts: () => setShortcuts(true),
      about: () => setAbout(true),
    },
  })
  const leaves = everyCommand(commands)
  useHotkeys(bindingsOf(leaves.filter(command => !command.scoped)), HOTKEY_OPTIONS)

  if (decisions.done) return <Finished {...decisions.done} />

  return (
    <div className="flex h-svh flex-col">
      <Tracker db={db} progress={progress} phase={phase} returnFocus={detailsRef} actions={cleanupTrash.actions} />
      <Header items={selection.count} progress={progress} phase={phase} link={session.scanLink} onDetails={onDetails} detailsRef={detailsRef} onEnd={decisions.cancel} ending={active} />
      <ScanSummary db={db} scan={scan} selection={selection} progress={round} phase={round ? phase : idle} active={active} />
      <div className="relative flex min-h-0 flex-1 flex-col text-sm">
        <TableDelete value={leaves.find(command => command.scoped) ?? null}>
          <ListingContext value={listing}>
            <Outlet />
          </ListingContext>
        </TableDelete>
        <ScanProblem error={scan.scan.error} />
      </div>
      <ActionBar
        key={scan.scan.rescans}
        selection={selection}
        scan={scan.scan}
        progress={active ? progress : null}
        phase={phase}
        actions={cleanupTrash.actions}
        last={progress && !active ? <RoundResult progress={progress} phase={phase} /> : null}
        failure={<Failures db={db} onApprove={decisions.retry} onCancel={decisions.cancel} />}
        about={about}
        onAbout={setAbout}
        onDelete={openConfirm}
      />
      <CommandMenu commands={commands} shortcuts={shortcuts} onShortcuts={setShortcuts} />
    </div>
  )
}
