import {useState} from 'react'
import {CleanupFilm} from '@/components/cleanup-film'
import type {CleanupEvent} from '@/lib/cleanup-feed'
import {createDb, receiveCleanupEvents, type Db} from '@/lib/db'
import {useMovie} from '@/lib/progress'
import {approvedEvent, cleanupEvents, fixture} from './fixture'

export const GB = 1024 ** 3
export const selected = fixture.data.categories.flatMap(c => c.items.filter(i => i.preselect))
export const finishedEvents = cleanupEvents as readonly CleanupEvent[]

export function movieDb(events: readonly CleanupEvent[] = []) {
  const db = createDb(fixture)
  const approved = events[0]?.type === 'approved' ? [] : [approvedEvent(selected.map(i => i.path)) as CleanupEvent]
  receiveCleanupEvents(db, [...approved, ...events])
  return db
}

export function Movie({db}: {db: Db}) {
  const [take, setTake] = useState(0)
  const movie = useMovie(db)
  return <CleanupFilm {...movie} open take={take} onReplay={() => setTake(take + 1)} onClose={() => {}} />
}

export function particleCanvas() {
  return document.querySelector<HTMLCanvasElement>('[data-film="particles"] canvas')
}

export function film(name: string) {
  return document.querySelector<HTMLElement>(`[data-film="${name}"]`)
}

export function visibility(name: string) {
  const el = film(name)
  return el ? getComputedStyle(el).visibility : 'none'
}
