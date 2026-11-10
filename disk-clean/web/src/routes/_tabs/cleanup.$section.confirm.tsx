import {useLiveSuspenseQuery} from '@tanstack/react-db'
import {createFileRoute, redirect, stripSearchParams, useRouter, type ErrorComponentProps} from '@tanstack/react-router'
import {ConfirmDialog, ConfirmFailed} from '@/components/confirm-dialog'
import {useSelectionWarnings} from '@/components/selection-warnings'
import {messageOf} from '@/lib/api'
import {useDb} from '@/lib/db'
import {useBack, useDialogExit} from '@/lib/navigation'
import {canConfirm, cleanupReady, loadPreview, previewAt, scanReady, useDecisions, useHome, useSelection} from '@/lib/page-data'
import {useScanState} from '@/lib/views'
import {CONFIRM_DEFAULTS, confirmSearch} from '@/lib/search'

export const Route = createFileRoute('/_tabs/cleanup/$section/confirm')({
  validateSearch: confirmSearch,
  search: {middlewares: [stripSearchParams(CONFIRM_DEFAULTS)]},
  loaderDeps: ({search}) => ({add: search.add, drop: search.drop}),
  loader: async ({context, deps, params}) => {
    await Promise.all([scanReady(context.db), cleanupReady(context.db)])
    if (!canConfirm(context.db, deps)) throw redirect({to: '/cleanup/$section', params: {section: params.section}, search: true, replace: true})
    return loadPreview(context.db, deps)
  },
  pendingMs: 150,
  pendingComponent: Checking,
  errorComponent: Failed,
  component: Confirm,
})

function useExit() {
  const exit = useDialogExit()
  const back = useBack()
  const {section} = Route.useParams()
  const leave = () => back({to: '/cleanup/$section', params: {section}, search: prev => ({...prev, now: false})})
  return {dialog: {open: exit.open, onClose: () => exit.leave(leave), onClosed: () => exit.after?.()}, leave: exit.leave}
}

function useScanning() {
  return !useScanState(useDb()).done
}

function useMode() {
  return Route.useSearch({select: search => (search.now ? 'now' : 'trash')})
}

function Checking() {
  const db = useDb()
  const home = useHome()
  const scanning = useScanning()
  const mode = useMode()
  const {dialog} = useExit()
  return <ConfirmDialog plan={null} mode={mode} home={home} platform={db.loaded.platform} scanning={scanning} {...dialog} onConfirm={dialog.onClose} />
}

function Failed({error}: ErrorComponentProps) {
  const router = useRouter()
  const {dialog} = useExit()
  return <ConfirmFailed message={messageOf(error)} {...dialog} onRetry={() => router.invalidate()} />
}

function Confirm() {
  const db = useDb()
  const preview = previewAt(db, Route.useLoaderData())
  const {data} = useLiveSuspenseQuery(preview.collection)
  const scanning = useScanning()
  const {approve} = useDecisions()
  const navigate = Route.useNavigate()
  const home = useHome()
  const {dialog, leave} = useExit()
  const warnings = useSelectionWarnings(useSelection())
  const mode = useMode()
  const confirm = () => {
    approve(preview, mode)
    leave(() => navigate({to: '/cleanup/$section', params: true, search: prev => ({...prev, now: false}), replace: true}))
  }
  return <ConfirmDialog plan={data[0] ?? null} mode={mode} home={home} platform={db.loaded.platform} selected={preview.items.length} scanning={scanning} warnings={warnings} {...dialog} onConfirm={confirm} />
}
