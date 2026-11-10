import {createFileRoute, Outlet, stripSearchParams} from '@tanstack/react-router'
import {Cleanup} from '@/components/cleanup'
import {CLEANUP_DEFAULTS, cleanupSearch} from '@/lib/search'

export const Route = createFileRoute('/_tabs/cleanup')({
  validateSearch: cleanupSearch,
  search: {middlewares: [stripSearchParams(CLEANUP_DEFAULTS)]},
  component: CleanupTab,
})

function CleanupTab() {
  return (
    <Cleanup>
      <Outlet />
    </Cleanup>
  )
}
