import {createFileRoute, redirect} from '@tanstack/react-router'

export const Route = createFileRoute('/')({
  beforeLoad: () => {
    throw redirect({to: '/cleanup', search: true, replace: true})
  },
})
