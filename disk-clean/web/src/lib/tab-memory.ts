import type {AnyRouter, ToOptions} from '@tanstack/react-router'

type Place = ToOptions<AnyRouter>

export function createTabMemory() {
  let last: Readonly<Record<string, Place>> = {}
  const listeners = new Set<() => void>()
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    placeOf: (tab: string): Place | undefined => last[tab],
    remember: (tab: string, place: Place) => {
      last = {...last, [tab]: place}
      for (const listener of listeners) listener()
    },
  }
}

export type TabMemory = ReturnType<typeof createTabMemory>
