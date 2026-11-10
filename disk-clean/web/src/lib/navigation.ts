import {useRouter, type NavigateOptions} from '@tanstack/react-router'
import {useState} from 'react'

export function useBack() {
  const router = useRouter()
  return (fallback: NavigateOptions) => {
    if (router.history.canGoBack()) router.history.back()
    else router.navigate({...fallback, replace: true})
  }
}

export function useDialogExit() {
  const [after, setAfter] = useState<(() => void) | null>(null)
  return {
    open: after === null,
    leave: (next: () => void) => setAfter(() => next),
    after,
  }
}
