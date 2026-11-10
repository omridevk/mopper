import {createFileRoute} from '@tanstack/react-router'
import {Shell} from '@/components/shell'
import {useConnection} from '@/lib/page-data'

export const Route = createFileRoute('/_tabs')({
  component: Tabs,
})

function Tabs() {
  useConnection()
  return <Shell />
}
