import {createFileRoute, Outlet, stripSearchParams} from '@tanstack/react-router'
import {TrashView, useTrashActions} from '@/components/trash-view'
import {TRASH_DEFAULTS, trashSearch} from '@/lib/search'

export const Route = createFileRoute('/_tabs/trash')({
  validateSearch: trashSearch,
  search: {middlewares: [stripSearchParams(TRASH_DEFAULTS)]},
  component: TrashTab,
})

function TrashTab() {
  const search = Route.useSearch()
  const actions = useTrashActions()
  return (
    <>
      <TrashView search={search} actions={actions} />
      <Outlet />
    </>
  )
}
