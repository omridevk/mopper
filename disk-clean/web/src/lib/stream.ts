import type {EventSourceLike, OpenEvents} from './data'

export const openEventSource: OpenEvents = url => new EventSource(url)

function messageData(message: Event): unknown {
  if (!(message instanceof MessageEvent) || typeof message.data !== 'string') return null
  return JSON.parse(message.data)
}

const PER_FRAME = 300

function perFrame<T>(apply: (events: T[]) => void) {
  let queue: T[] = []
  let frame = 0
  const flush = () => {
    frame = 0
    const taken = queue.slice(0, PER_FRAME)
    queue = queue.slice(PER_FRAME)
    if (queue.length > 0) frame = requestAnimationFrame(flush)
    if (taken.length > 0) apply(taken)
  }
  const take = (event: T) => {
    queue.push(event)
    if (frame === 0) frame = requestAnimationFrame(flush)
  }
  const stop = () => {
    cancelAnimationFrame(frame)
    frame = 0
    const taken = queue
    queue = []
    if (taken.length > 0) apply(taken)
  }
  return {take, stop}
}

export interface Listener<E> {
  types: readonly string[]
  toEvent: (type: string, data: object) => E | null
  isFinal: (event: E) => boolean
  onDrop: (readyState: number) => E | null
  onLive: () => void
}

export function stream<E>(open: () => EventSourceLike, listener: Listener<E>, apply: (events: E[]) => void) {
  const source = open()
  const batch = perFrame(apply)
  for (const type of listener.types) {
    source.addEventListener(type, message => {
      const data = messageData(message)
      if (typeof data !== 'object' || data === null) return
      const event = listener.toEvent(type, data)
      if (!event) return
      listener.onLive()
      batch.take(event)
      if (listener.isFinal(event)) source.close()
    })
  }
  source.addEventListener('open', listener.onLive)
  source.addEventListener('error', message => {
    if (message instanceof MessageEvent) return
    const dropped = listener.onDrop(source.readyState)
    if (dropped) batch.take(dropped)
  })
  return () => {
    source.close()
    batch.stop()
  }
}
