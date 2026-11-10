import {createFileRoute, Outlet, stripSearchParams} from '@tanstack/react-router'
import {STORAGE_DEFAULTS, storageSearch} from '@/lib/search'

export const Route = createFileRoute('/_tabs/storage')({
  validateSearch: storageSearch,
  search: {middlewares: [stripSearchParams(STORAGE_DEFAULTS)]},
  component: StorageTab,
})

function StorageTab() {
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <Outlet />
    </div>
  )
}
