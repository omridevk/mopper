import {parseSearchWith, stringifySearchWith, type SearchSchemaInput} from '@tanstack/react-router'
import type {Risk} from './data'
import {cleanTokens} from './selection'

export type View = 'list' | 'cards'
export type Sort = 'size-desc' | 'size-asc' | 'name-asc' | 'age-desc' | 'age-asc'
export type LogFilter = 'all' | 'removed' | 'problems' | 'commands'
export type Overlay = 'progress' | 'movie'
export type Shape = 'sunburst' | 'treemap'

export const RISKS: Risk[] = ['safe', 'review', 'report']
export const SORTS: Sort[] = ['size-desc', 'size-asc', 'name-asc', 'age-desc', 'age-asc']
export const MIN_SIZES = [0, 100 << 20, 1 << 30, 5 * (1 << 30)]
export const MIN_AGES = [-1, 30, 90, 365]
export const LOG_FILTERS: LogFilter[] = ['all', 'removed', 'problems', 'commands']
const VIEWS: View[] = ['list', 'cards']
const OVERLAYS: Overlay[] = ['progress', 'movie']
export const SHAPES: Shape[] = ['sunburst', 'treemap']

export interface RootSearch {
  overlay?: Overlay
  log: LogFilter
  take: number
  add: string
  drop: string
}

export interface CleanupSearch {
  view: View
  q: string
  risk: Risk[]
  minSize: number
  minAge: number
  sort: Sort
  only: boolean
}

export interface StorageSearch {
  shape: Shape
}

export interface ConfirmSearch {
  now: boolean
}

export interface TrashSearch {
  run: string
  pick: string
}

export interface EmptySearch {
  target: string
}

export const ROOT_DEFAULTS = {log: 'all', take: 0, add: '', drop: ''} satisfies Omit<RootSearch, 'overlay'>
export const NO_FILTERS = {q: '', risk: [], minSize: 0, minAge: -1, only: false} satisfies Partial<CleanupSearch>
export const CLEANUP_DEFAULTS: CleanupSearch = {...NO_FILTERS, view: 'list', sort: 'size-desc'}
export const STORAGE_DEFAULTS: StorageSearch = {shape: 'sunburst'}
export const CONFIRM_DEFAULTS: ConfirmSearch = {now: false}
export const TRASH_DEFAULTS: TrashSearch = {run: '', pick: ''}
export const EMPTY_DEFAULTS: EmptySearch = {target: ''}

type Raw<T> = {[K in keyof T]?: T[K]} & SearchSchemaInput

function oneOf<T>(options: readonly T[], value: unknown, fallback: T): T {
  return options.find(option => option === value) ?? fallback
}

function textOf(value: unknown) {
  if (typeof value === 'string') return value
  return typeof value === 'number' ? String(value) : ''
}

function countOf(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0
}

export function rootSearch(raw: Raw<RootSearch>): RootSearch {
  const overlay = OVERLAYS.find(o => o === raw.overlay)
  return {
    ...(overlay && {overlay}),
    log: oneOf(LOG_FILTERS, raw.log, ROOT_DEFAULTS.log),
    take: countOf(raw.take),
    add: cleanTokens(textOf(raw.add)),
    drop: cleanTokens(textOf(raw.drop)),
  }
}

export function cleanupSearch(raw: Raw<CleanupSearch>): CleanupSearch {
  const risk: unknown = raw.risk
  return {
    view: oneOf(VIEWS, raw.view, CLEANUP_DEFAULTS.view),
    q: textOf(raw.q).trim() === '' ? '' : textOf(raw.q),
    risk: Array.isArray(risk) ? RISKS.filter(r => risk.includes(r)) : [],
    minSize: oneOf(MIN_SIZES, raw.minSize, CLEANUP_DEFAULTS.minSize),
    minAge: oneOf(MIN_AGES, raw.minAge, CLEANUP_DEFAULTS.minAge),
    sort: oneOf(SORTS, raw.sort, CLEANUP_DEFAULTS.sort),
    only: raw.only === true,
  }
}

export function storageSearch(raw: Raw<StorageSearch>): StorageSearch {
  return {shape: oneOf(SHAPES, raw.shape, STORAGE_DEFAULTS.shape)}
}

export function confirmSearch(raw: Raw<ConfirmSearch>): ConfirmSearch {
  return {now: raw.now === true}
}

const ID = /^[0-9a-f]{16}$/
const RUN = /^[A-Za-z0-9._-]{1,120}$/

const cleanIds = (text: string) => [...new Set(text.split('.').filter(id => ID.test(id)))].join('.')

export function trashSearch(raw: Raw<TrashSearch>): TrashSearch {
  const run = textOf(raw.run)
  return {run: RUN.test(run) ? run : '', pick: cleanIds(textOf(raw.pick))}
}

export function emptySearch(raw: Raw<EmptySearch>): EmptySearch {
  const target = textOf(raw.target)
  const [kind, value = ''] = target.split(':')
  const valid = (kind === 'run' && RUN.test(value)) || (kind === 'item' && ID.test(value))
  return {target: valid ? target : ''}
}

const utf8 = new TextEncoder()
const strictUtf8 = new TextDecoder('utf-8', {fatal: true})

export function obscureSearchValue(value: unknown) {
  const binary = Array.from(utf8.encode(JSON.stringify(value)), byte => String.fromCharCode(byte)).join('')
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

export function revealSearchValue(text: string): unknown {
  const binary = atob(text.replaceAll('-', '+').replaceAll('_', '/'))
  return JSON.parse(strictUtf8.decode(Uint8Array.from(binary, char => char.charCodeAt(0))))
}

const everyStringIsEncoded = (text: string) => text

export const parseSearch = parseSearchWith(revealSearchValue)
export const stringifySearch = stringifySearchWith(obscureSearchValue, everyStringIsEncoded)
