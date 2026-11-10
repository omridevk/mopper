import {createFileRoute, Link, notFound, Outlet, type NotFoundRouteProps} from '@tanstack/react-router'
import {NotFound} from '@/components/not-found'
import {hasSection, scanReady, scanSettled} from '@/lib/page-data'
import {OpenSection} from './-open-section'

const MISSING = 'missing-section'

export const Route = createFileRoute('/_tabs/cleanup/$section')({
  loader: async ({context, params}) => {
    await scanReady(context.db)
    if (!hasSection(context.db, params.section) && scanSettled(context.db)) throw notFound({data: MISSING})
  },
  pendingMs: 150,
  pendingComponent: Waiting,
  component: Section,
  notFoundComponent: Missing,
})

function Section() {
  const {section} = Route.useParams()
  return (
    <>
      <OpenSection section={section} />
      <Outlet />
    </>
  )
}

function Waiting() {
  return <div className="flex grow items-center justify-center p-10 text-sm text-muted-foreground">Loading the scan…</div>
}

function Missing({data}: NotFoundRouteProps) {
  const {section} = Route.useParams()
  if (data !== MISSING) return <NotFound />
  return (
    <div className="flex grow flex-col items-center justify-center gap-2 p-10 text-center text-sm text-muted-foreground">
      <p>There is no section called “{section}” in this scan.</p>
      <Link to="/cleanup" search className="text-foreground underline underline-offset-4">
        Show the first section
      </Link>
    </div>
  )
}
