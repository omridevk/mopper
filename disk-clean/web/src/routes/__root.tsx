import {createRootRouteWithContext, retainSearchParams, stripSearchParams, useRouter, type ErrorComponentProps} from '@tanstack/react-router'
import {NotFound} from '@/components/not-found'
import {Button} from '@/components/ui/button'
import {messageOf} from '@/lib/api'
import type {Db} from '@/lib/db'
import type {TabMemory} from '@/lib/tab-memory'
import {ROOT_DEFAULTS, rootSearch} from '@/lib/search'

export const Route = createRootRouteWithContext<{db: Db; tabs: TabMemory}>()({
  validateSearch: rootSearch,
  search: {middlewares: [stripSearchParams(ROOT_DEFAULTS), retainSearchParams(['add', 'drop'])]},
  notFoundComponent: NotFound,
  errorComponent: Broken,
})

function Broken({error}: ErrorComponentProps) {
  const router = useRouter()
  return (
    <div role="alert" className="flex min-h-svh flex-col items-center justify-center gap-3 p-10 text-center text-sm">
      <h1 className="text-lg font-semibold">This page hit a problem</h1>
      <p className="max-w-lg text-muted-foreground">Nothing was deleted. {messageOf(error)}</p>
      <Button variant="outline" onClick={() => router.invalidate()}>
        Try again
      </Button>
    </div>
  )
}
