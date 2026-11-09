export type Risk = 'safe' | 'review' | 'report'

export interface Item {
  path: string
  label: string
  bytes: number
  action: string
  cmd_id: string
  note: string
  age: number | null
  accuracy: string
  preselect: boolean
  report: boolean
  checking?: boolean
  line?: number
}

export interface Category {
  id: string
  title: string
  desc: string
  risk: Risk
  items: Item[]
  bytes: number
}

export interface TreeNode {
  name: string
  path: string
  bytes: number
  files: number
  mtime: number
  children: TreeNode[]
  rest?: boolean
  file?: boolean
}

export interface Insights {
  generated_at: number
  modified_by_day: {day: string; bytes: number; files: number}[]
  age_by_folder: {buckets: string[]; folders: {path: string; bytes: number[]}[]}
  by_kind: {kind: string; bytes: number; files: number}[]
  largest_files: {path: string; bytes: number; mtime: number}[]
}

export interface ScanData {
  categories: Category[]
  reclaimable: number
  free: number
  total: number
  used: number
  home: number
  snapshots: number
  tree: TreeNode | null
  insights?: Insights | null
}

export interface EventSourceLike extends EventTarget {
  readonly readyState: number
  close(): void
}

export type OpenEvents = (url: string) => EventSourceLike

export type Platform = 'macos' | 'linux' | 'windows'

export type TrashState = 'trashed' | 'restored' | 'put-back' | 'emptied' | 'failed'

export interface TrashEntry {
  id: string
  run: string
  original: string
  trashed: string
  bytes: number
  at: number
  dev: number
  ino: number
  state: TrashState
  reason: string
}

interface TrashRecord {
  trash?: TrashEntry[]
  run?: string
}

export interface Loaded {
  data: ScanData
  token: string
  home: string
  platform?: Platform
  live?: boolean
  trash?: TrashEntry[]
  run?: string
  openEvents?: OpenEvents
}

export const NO_DATA: ScanData = {categories: [], reclaimable: 0, free: 0, total: 0, used: 0, home: 0, snapshots: 0, tree: null, insights: null}

const platformOf = (name: string): Platform => (name === 'linux' || name === 'windows' ? name : 'macos')

async function loadDev(): Promise<Loaded> {
  const params = new URLSearchParams(location.search)
  const platform = platformOf(params.get('platform') ?? '')
  if (params.has('live')) return {data: NO_DATA, token: params.get('token') ?? '', home: '', platform, live: true}
  const response = await fetch('/dev/fixture.json')
  const loaded: Loaded = await response.json()
  return {...loaded, home: '', platform}
}

function metaOf(name: string) {
  return document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.content ?? ''
}

export async function load(): Promise<Loaded> {
  const text = document.getElementById('disk-clean-data')?.textContent ?? ''
  const token = metaOf('disk-clean-token')
  const home = metaOf('disk-clean-home')
  const platform = platformOf(metaOf('disk-clean-platform'))
  if (import.meta.env.DEV && text.trim() === '__DATA__') return loadDev()
  const parsed: (ScanData | {live: true}) & TrashRecord = JSON.parse(text)
  const record = {platform, trash: parsed.trash ?? [], run: parsed.run ?? ''}
  if ('live' in parsed) return {data: NO_DATA, token, home, live: true, ...record}
  return {data: parsed, token, home, ...record}
}

export function tilde(path: string, home: string) {
  return home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path
}

export function untilde(path: string, home: string) {
  return home && (path === '~' || path.startsWith('~/')) ? `${home}${path.slice(1)}` : path
}

export function tildeWords(line: string, home: string, path: (path: string) => string) {
  return line
    .split(' ')
    .map(word => {
      const quote = word.startsWith("'") ? "'" : ''
      return quote + path(tilde(word.slice(quote.length), home))
    })
    .join(' ')
}

const UNITS = ['KB', 'MB', 'GB', 'TB']

export function formatBytes(n: number): string {
  if (n < 1024) return `${Math.round(n)} B`
  let value = n
  let unit = -1
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit++
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${UNITS[unit]}`
}

export const counted = (n: number) => n.toLocaleString()

export function plural(n: number, one: string, many: string) {
  return `${counted(n)} ${n === 1 ? one : many}`
}

export function sizeOf(exact: number, apparent: number) {
  if (apparent === 0) return formatBytes(exact)
  return exact === 0 ? `≈${formatBytes(apparent)}` : `${formatBytes(exact)} + ≈${formatBytes(apparent)}`
}

export const isExact = (item: Item) => item.accuracy === 'exact'

export const isPickable = (item: Item) => !item.report && item.checking !== true

const RISK_ORDER: Risk[] = ['safe', 'review', 'report']

export function firstSection(categories: readonly Category[]) {
  return RISK_ORDER.flatMap(risk => categories.filter(c => c.risk === risk))[0]?.id
}

export const RISK_LABEL: Record<Risk, string> = {safe: 'safe', review: 'review', report: 'report only'}

export function ancestorsOf(path: string) {
  const found: string[] = []
  for (let slash = path.indexOf('/', 1); slash > 0; slash = path.indexOf('/', slash + 1)) found.push(path.slice(0, slash))
  return found
}

export function outermost<T extends {path: string}>(items: readonly T[]): T[] {
  const paths = new Set(items.map(i => i.path))
  return items.filter(i => !ancestorsOf(i.path).some(outer => paths.has(outer)))
}

export const sumBytes = (items: readonly {bytes: number}[]) => items.reduce((sum, i) => sum + i.bytes, 0)

