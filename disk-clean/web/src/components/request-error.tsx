import {RotateCw} from 'lucide-react'
import {Button} from '@/components/ui/button'
import type {Action, Db} from '@/lib/db'
import {useRequest} from '@/lib/views'

const LABEL: Record<Action, string> = {
  approve: 'Delete did not go through, nothing was deleted',
  cancel: 'End session did not go through',
  undo: 'Undo did not go through',
  empty: 'Empty did not go through',
  rescan: 'Rescan did not start',
}

export function RequestError({db, action, onRetry}: {db: Db; action: Action; onRetry: () => void}) {
  const request = useRequest(db, action)
  if (request?.status !== 'failed') return null
  return (
    <span role="alert" className="flex items-center gap-2 text-xs text-red-300">
      <span>{`${LABEL[action]}: ${request.message}`}</span>
      {request.retry && (
        <Button size="xs" variant="outline" onClick={onRetry}>
          <RotateCw /> Retry
        </Button>
      )}
    </span>
  )
}
