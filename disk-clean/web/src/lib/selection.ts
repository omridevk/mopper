import type {RowSelectionState} from '@tanstack/react-table'
import {isExact, isPickable, type Item, type Risk} from './data'

export interface Group<T extends Item = Item> {
  id: string
  risk: Risk
  items: readonly T[]
}

export interface Picks {
  add: string
  drop: string
}

export const NO_PICKS: Picks = {add: '', drop: ''}

const SECTION = '_'
const SEPARATOR = '.'
const SHORT = 8
const FULL = 11
const TOKEN = /^(_[\w-]+|[0-9a-z]{8}|[0-9a-z]{11})$/

const pickable = isPickable

function cyrb53(text: string) {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ code, 2654435761)
    h2 = Math.imul(h2 ^ code, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return 4294967296 * (2097151 & h2) + (h1 >>> 0)
}

export function fingerprint(paths: readonly string[]) {
  return cyrb53(paths.toSorted().join('\n')).toString(36)
}

const hashes = new Map<string, string>()

export function fullToken(path: string) {
  const known = hashes.get(path)
  if (known) return known
  const hash = cyrb53(path).toString(36).padStart(FULL, '0')
  hashes.set(path, hash)
  return hash
}

const sectionToken = (category: {id: string}) => `${SECTION}${category.id}`

export function cleanTokens(value: string) {
  return value
    .split(SEPARATOR)
    .filter(token => TOKEN.test(token))
    .join(SEPARATOR)
}

function tokenSet(value: string) {
  return new Set(value ? value.split(SEPARATOR) : [])
}

export const shortOf = (path: string) => fullToken(path).slice(0, SHORT)

export function tokenFor(path: string, sharing: (short: string) => number | undefined) {
  const short = shortOf(path)
  return sharing(short) === 1 ? short : fullToken(path)
}

interface Notes {
  marks: string[]
  add: Set<string>
  drop: Set<string>
}

export interface Fragment<T extends Item = Item> {
  items: readonly T[]
  key: string
  risk: Risk
  selected: T[]
  exactBytes: number
  apparentBytes: number
}

export interface Decoded<T extends Item = Item> {
  on: RowSelectionState
  parts: readonly Fragment<T>[]
}

export function createSelector<T extends Item = Item>() {
  const counts = new Map<string, number>()
  const counted = new Map<string, Set<string>>()
  const seen = new Map<string, readonly T[]>()
  const owners = new Map<string, string>()
  const paths = new Map<string, string>()
  const fragments = new Map<string, Fragment<T>>()
  const last: {categories: readonly Group<T>[] | null; add: string; drop: string; decoded: Decoded<T>} = {categories: null, add: '', drop: '', decoded: {on: {}, parts: []}}

  const tokenOf = (path: string) => tokenFor(path, short => counts.get(short))

  const enter = (path: string, section: string) => {
    const short = shortOf(path)
    counts.set(short, (counts.get(short) ?? 0) + 1)
    owners.set(short, section)
    owners.set(fullToken(path), section)
    paths.set(short, path)
    paths.set(fullToken(path), path)
  }

  const leave = (path: string) => {
    const short = shortOf(path)
    counts.set(short, (counts.get(short) ?? 1) - 1)
  }

  const recount = (section: string, items: readonly T[]) => {
    const before = counted.get(section) ?? new Set<string>()
    const after = new Set<string>()
    for (const item of items) {
      if (!pickable(item)) continue
      after.add(item.path)
      if (!before.has(item.path)) enter(item.path, section)
    }
    for (const path of before) if (!after.has(path)) leave(path)
    counted.set(section, after)
    seen.set(section, items)
  }

  const sync = (categories: readonly Group<T>[]) => {
    const live = new Set(categories.map(c => c.id))
    for (const [section, before] of counted) {
      if (live.has(section)) continue
      for (const path of before) leave(path)
      counted.delete(section)
      seen.delete(section)
      fragments.delete(section)
    }
    for (const category of categories) if (seen.get(category.id) !== category.items) recount(category.id, category.items)
  }

  const pathOf = (token: string) => {
    const path = paths.get(token)
    return path !== undefined && tokenOf(path) === token ? path : undefined
  }

  const notesOf = (add: ReadonlySet<string>, drop: ReadonlySet<string>) => {
    const notes = new Map<string, Notes>()
    const note = (token: string, picked: boolean) => {
      const section = token.startsWith(SECTION) ? token.slice(SECTION.length) : owners.get(token)
      if (section === undefined) return
      const known = notes.get(section) ?? {marks: [], add: new Set<string>(), drop: new Set<string>()}
      notes.set(section, known)
      known.marks.push(`${picked ? '+' : '-'}${token}`)
      const path = token.startsWith(SECTION) ? undefined : pathOf(token)
      if (path !== undefined) (picked ? known.add : known.drop).add(path)
    }
    for (const token of add) note(token, true)
    for (const token of drop) note(token, false)
    return notes
  }

  const fragmentOf = (category: Group<T>, notes: Notes | undefined, add: ReadonlySet<string>, drop: ReadonlySet<string>): Fragment<T> => {
    const key = (notes?.marks ?? []).toSorted().join(SEPARATOR)
    const known = fragments.get(category.id)
    if (known && known.items === category.items && known.key === key) return known
    const fragment = buildFragment(category, key, notes, pickedIn(category, add, drop))
    fragments.set(category.id, fragment)
    return fragment
  }

  const decode = (categories: readonly Group<T>[], picks: Picks): Decoded<T> => {
    if (last.categories === categories && last.add === picks.add && last.drop === picks.drop) return last.decoded
    sync(categories)
    const add = tokenSet(picks.add)
    const drop = tokenSet(picks.drop)
    const notes = notesOf(add, drop)
    let changed = last.categories === null || last.categories.length !== categories.length
    const parts = categories.map(category => {
      const before = fragments.get(category.id)
      const fragment = fragmentOf(category, notes.get(category.id), add, drop)
      if (fragment !== before) changed = true
      return fragment
    })
    if (changed) {
      const on: RowSelectionState = {}
      for (const part of parts) for (const item of part.selected) on[item.path] = true
      last.decoded = {on, parts}
    }
    Object.assign(last, {categories, add: picks.add, drop: picks.drop})
    return last.decoded
  }

  const knows = (token: string) => (token.startsWith(SECTION) ? counted.has(token.slice(SECTION.length)) : pathOf(token) !== undefined)

  return {decode, tokenOf, sync, knows}
}

function isOn(item: Item, notes: Notes | undefined, whole: boolean | null) {
  if (!pickable(item)) return false
  if (notes?.add.has(item.path)) return true
  if (notes?.drop.has(item.path)) return false
  return whole ?? item.preselect
}

function buildFragment<T extends Item>(category: Group<T>, key: string, notes: Notes | undefined, whole: boolean | null): Fragment<T> {
  const fragment: Fragment<T> = {items: category.items, key, risk: category.risk, selected: [], exactBytes: 0, apparentBytes: 0}
  for (const item of category.items) {
    if (!isOn(item, notes, whole)) continue
    fragment.selected.push(item)
    if (isExact(item)) fragment.exactBytes += item.bytes
    else fragment.apparentBytes += item.bytes
  }
  return fragment
}

export type Selector<T extends Item = Item> = ReturnType<typeof createSelector<T>>

function pickedIn(category: {id: string}, add: ReadonlySet<string>, drop: ReadonlySet<string>) {
  const section = sectionToken(category)
  if (add.has(section)) return true
  return drop.has(section) ? false : null
}

export function rowSelectionOf(categories: readonly Group[], picks: Picks): RowSelectionState {
  return createSelector().decode(categories, picks).on
}

interface Delta {
  whole: '' | 'add' | 'drop'
  add: readonly Item[]
  drop: readonly Item[]
}

const sizeOf = (delta: Delta) => Number(delta.whole !== '') + delta.add.length + delta.drop.length

function deltaOf(items: readonly Item[], on: RowSelectionState): Delta {
  const isOn = (item: Item) => on[item.path] === true
  const options: Delta[] = [
    {whole: '', add: items.filter(i => isOn(i) && !i.preselect), drop: items.filter(i => !isOn(i) && i.preselect)},
    {whole: 'add', add: [], drop: items.filter(i => !isOn(i))},
    {whole: 'drop', add: items.filter(isOn), drop: []},
  ]
  return options.reduce((best, option) => (sizeOf(option) < sizeOf(best) ? option : best))
}

export function picksOf<T extends Item>(categories: readonly Group<T>[], on: RowSelectionState, selector: Selector<T> = createSelector<T>()): Picks {
  selector.sync(categories)
  const tokenOf = (item: Item) => selector.tokenOf(item.path)
  const add: string[] = []
  const drop: string[] = []
  for (const category of categories) {
    const delta = deltaOf(category.items.filter(pickable), on)
    if (delta.whole === 'add') add.push(sectionToken(category))
    if (delta.whole === 'drop') drop.push(sectionToken(category))
    add.push(...delta.add.map(tokenOf))
    drop.push(...delta.drop.map(tokenOf))
  }
  return {add: add.join(SEPARATOR), drop: drop.join(SEPARATOR)}
}
