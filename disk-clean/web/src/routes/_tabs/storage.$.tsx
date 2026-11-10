import {createFileRoute, redirect} from '@tanstack/react-router'

export const Route = createFileRoute('/_tabs/storage/$')({
  beforeLoad: () => {
    throw redirect({to: '/storage', search: true, replace: true})
  },
})
