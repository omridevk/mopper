import type {RouterHistory} from '@tanstack/react-router'
import {vi} from 'vitest'
import {foldersOf} from '@/lib/folders'
import {parseSearch, stringifySearch} from '@/lib/search'
import type {ScanEvent} from '@/lib/scan-feed'
import {fixture} from './fixture'

const REPLAYED = () => new MessageEvent('replayed', {data: JSON.stringify({elapsed_ms: 0})})

export function fakeEventSource({caughtUp = true} = {}) {
  const target = new EventTarget()
  let unheard: Event[] | null = []
  const connect = () => {
    if (unheard === null) return
    const replay = unheard
    unheard = null
    for (const event of replay) EventTarget.prototype.dispatchEvent.call(target, event)
    if (caughtUp) EventTarget.prototype.dispatchEvent.call(target, REPLAYED())
  }
  const source = Object.assign(target, {
    readyState: 1,
    close: () => {
      source.readyState = 2
    },
    addEventListener: (...args: Parameters<EventTarget['addEventListener']>) => {
      EventTarget.prototype.addEventListener.apply(target, args)
      queueMicrotask(connect)
    },
    dispatchEvent: (event: Event) => (unheard ? unheard.push(event) > 0 : EventTarget.prototype.dispatchEvent.call(target, event)),
  })
  const send = (event: ScanEvent) => source.dispatchEvent(new MessageEvent(event.type, {data: JSON.stringify(event.data)}))
  const catchUp = () => source.dispatchEvent(REPLAYED())
  return {source, send, catchUp}
}

export function ringPoints(chart: Element) {
  const sectors = [...chart.querySelectorAll('.storage-base path')].map(p => p.getBoundingClientRect())
  const right = Math.max(...sectors.map(r => r.right))
  const top = Math.min(...sectors.map(r => r.top))
  const bottom = Math.max(...sectors.map(r => r.bottom))
  const radius = (bottom - top) / 2
  const box = chart.getBoundingClientRect()
  return (turn: number, ring: number) => {
    const distance = radius * (0.28 + 0.36 * (ring + 0.5))
    const x = right - radius + distance * Math.sin(turn * 2 * Math.PI)
    const y = (top + bottom) / 2 - distance * Math.cos(turn * 2 * Math.PI)
    return {client: {x, y}, local: {x: x - box.left, y: y - box.top}}
  }
}

export function sendRaw(source: EventTarget, type: string, data: object) {
  source.dispatchEvent(new MessageEvent(type, {data: JSON.stringify(data)}))
}

export function sendAll(source: EventTarget, events: readonly {type: string; data: object}[]) {
  for (const event of events) sendRaw(source, event.type, event.data)
  return new Promise(requestAnimationFrame)
}

const GB = 1024 ** 3

export const PLAN = {
  paths: ['app-a', 'app-b', 'app-c', 'app-d'].map((name, i) => ({
    path: `/Users/you/Library/Caches/${name}`,
    bytes: [2, 1, 0.5, 0.25][i]! * GB,
    trashed: false,
  })),
  paths_bytes: 3.75 * GB,
  final: ['git -C /Users/you/code worktree remove /Users/you/code/wt', 'git -C /Users/you/code worktree prune', 'docker system prune -f'],
  final_bytes: 6 * GB,
  final_count: 2,
  rejected: [{reason: 'already gone', path: '/Users/you/old'}],
  count: 6,
  bytes: 9.75 * GB,
}

export function mockServer(plan: object = PLAN, failing: ReadonlySet<string> = new Set()) {
  return vi.spyOn(window, 'fetch').mockImplementation(async input => {
    const url = String(input)
    if (failing.has(url)) return new Response('server said no', {status: 500})
    return new Response(url === '/preview' ? JSON.stringify(plan) : '{}', {status: url === '/preview' || url === '/decide' ? 200 : 202})
  })
}

export const query = (history: RouterHistory): Record<string, unknown> => parseSearch(history.location.search)

export const address = (path: string, search: Record<string, unknown> = {}) => `${path}${stringifySearch(search)}`

export function zoomed(path: string) {
  const folder = foldersOf(fixture.data.tree).find(known => known.path === path)
  if (!folder) throw new Error(`the fixture has no folder ${path}`)
  return `/storage/${folder.token}`
}
