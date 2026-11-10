import {useRef, type RefObject} from 'react'
import {Button} from '@/components/ui/button'
import {Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle} from '@/components/ui/dialog'
import {formatBytes, plural} from '@/lib/data'
import {usePlatform} from '@/lib/platform'

export function EmptyDialog({
  count,
  bytes,
  open,
  onOpenChange,
  onClosed,
  onEmpty,
  returnFocus,
}: {
  count: number
  bytes: number
  open: boolean
  onOpenChange: (open: boolean) => void
  onClosed: () => void
  onEmpty: () => void
  returnFocus?: RefObject<HTMLButtonElement | null>
}) {
  const keep = useRef<HTMLButtonElement>(null)
  const {restoreByHand, bin} = usePlatform()
  return (
    <Dialog open={open} onOpenChange={onOpenChange} onOpenChangeComplete={next => next || onClosed()}>
      <DialogContent className="sm:max-w-md" initialFocus={keep} finalFocus={returnFocus}>
        <DialogHeader>
          <DialogTitle>{bin('Empty these from the Trash?')}</DialogTitle>
          <DialogDescription>
            This deletes the {plural(count, 'item', 'items')} ({formatBytes(bytes)}) disk-clean put in {bin('the Trash')}, for good. It can't be undone:
            Undo and {restoreByHand} stop working for them. {bin('Nothing else in your Trash is touched.')}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button ref={keep} variant="outline" onClick={() => onOpenChange(false)}>
            {bin('Keep them in the Trash')}
          </Button>
          <Button variant="destructive" disabled={count === 0} onClick={onEmpty}>
            Empty {plural(count, 'item', 'items')} · {formatBytes(bytes)} for good
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
