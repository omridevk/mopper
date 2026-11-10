import {useSyncExternalStore} from 'react'

const TICK_MS = 100

let now = 0

function ticking(notify: () => void) {
  const timer = setInterval(() => {
    now = performance.now()
    notify()
  }, TICK_MS)
  return () => clearInterval(timer)
}

function still() {
  return () => {}
}

function read() {
  return now
}

export function useClock(running: boolean) {
  return useSyncExternalStore(running ? ticking : still, read)
}
