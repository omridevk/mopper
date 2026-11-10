import {createFileRoute, redirect} from '@tanstack/react-router'
import {firstSectionNow, scanReady} from '@/lib/page-data'
import {OpenSection} from './-open-section'

export const Route = createFileRoute('/_tabs/cleanup/')({
  loader: async ({context}) => {
    await scanReady(context.db)
    const section = firstSectionNow(context.db)
    if (section) throw redirect({to: '/cleanup/$section', params: {section}, search: true, replace: true})
  },
  pendingMs: 0,
  pendingMinMs: 0,
  pendingComponent: Scanning,
  component: Scanning,
})

function Scanning() {
  return <OpenSection section="" />
}
