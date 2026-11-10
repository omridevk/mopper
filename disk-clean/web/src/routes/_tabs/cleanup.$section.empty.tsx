import {createFileRoute, redirect} from '@tanstack/react-router'
import {EmptyDialog} from '@/components/empty-dialog'
import {useBack, useDialogExit} from '@/lib/navigation'
import {cleanupReady, isApproved, useDecisions, useProgress} from '@/lib/page-data'

export const Route = createFileRoute('/_tabs/cleanup/$section/empty')({
  beforeLoad: async ({context, params}) => {
    await cleanupReady(context.db)
    if (!isApproved(context.db)) throw redirect({to: '/cleanup/$section', params: {section: params.section}, search: true, replace: true})
  },
  component: Empty,
})

function Empty() {
  const {progress, phase} = useProgress()
  const {trash} = useDecisions()
  const navigate = Route.useNavigate()
  const back = useBack()
  const {section} = Route.useParams()
  const exit = useDialogExit()
  const toSection = () => navigate({to: '/cleanup/$section', params: true, search: true, replace: true})
  if (!progress) return null
  const {ids, count, bytes} = progress.inTrash
  const empty = () => {
    trash('empty', ids)
    exit.leave(toSection)
  }
  return (
    <EmptyDialog
      count={count}
      bytes={bytes}
      open={exit.open && phase === 'trashed'}
      onOpenChange={open => open || exit.leave(() => back({to: '/cleanup/$section', params: {section}, search: true}))}
      onClosed={() => (exit.after ?? toSection)()}
      onEmpty={empty}
    />
  )
}
