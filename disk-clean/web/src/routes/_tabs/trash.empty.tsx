import {createFileRoute, stripSearchParams} from '@tanstack/react-router'
import {EmptyDialog} from '@/components/empty-dialog'
import {useTrashRuns, type Run} from '@/components/trash-view'
import {useBack, useDialogExit} from '@/lib/navigation'
import {useDecisions} from '@/lib/page-data'
import {EMPTY_DEFAULTS, emptySearch} from '@/lib/search'

export const Route = createFileRoute('/_tabs/trash/empty')({
  validateSearch: emptySearch,
  search: {middlewares: [stripSearchParams(EMPTY_DEFAULTS)]},
  component: EmptyChosen,
})

function chosenOf(runs: readonly Run[], target: string, pick: string) {
  const inTrash = runs.flatMap(run => run.inTrash)
  const [kind, value] = target.split(':')
  if (kind === 'run') return runs.find(run => run.id === value)?.inTrash ?? []
  if (kind === 'item') return inTrash.filter(entry => entry.id === value)
  const picked = new Set(pick.split('.'))
  return inTrash.filter(entry => picked.has(entry.id))
}

function EmptyChosen() {
  const {target, pick} = Route.useSearch()
  const navigate = Route.useNavigate()
  const back = useBack()
  const exit = useDialogExit()
  const {trash} = useDecisions()
  const chosen = chosenOf(useTrashRuns(), target, pick)
  const toTrash = () => navigate({to: '/trash', search: prev => ({...prev, target: ''}), replace: true})
  const empty = () => {
    trash(
      'empty',
      chosen.map(entry => entry.id),
    )
    exit.leave(toTrash)
  }
  return (
    <EmptyDialog
      count={chosen.length}
      bytes={chosen.reduce((sum, entry) => sum + entry.bytes, 0)}
      open={exit.open}
      onOpenChange={open => open || exit.leave(() => back({to: '/trash', search: prev => ({...prev, target: ''})}))}
      onClosed={() => (exit.after ?? toTrash)()}
      onEmpty={empty}
    />
  )
}
