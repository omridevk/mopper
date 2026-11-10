import {createFileRoute} from '@tanstack/react-router'
import {StorageView} from './-storage-view'

export const Route = createFileRoute('/_tabs/storage/')({
  component: Unzoomed,
})

function Unzoomed() {
  return <StorageView zoom="" />
}
