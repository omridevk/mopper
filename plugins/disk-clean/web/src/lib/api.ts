import type {TrashEntry, TreeNode} from './data'

export type Mode = 'trash' | 'now'

export interface Plan {
  paths: {path: string; bytes: number; trashed: boolean}[]
  paths_bytes: number
  final: string[]
  final_bytes: number
  final_count: number
  rejected: {reason: string; path: string}[]
  count: number
  bytes: number
}

export const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e))

export const httpStatusOf = (e: unknown) => (e instanceof Error && 'status' in e && typeof e.status === 'number' ? e.status : 0)

export interface Selected {
  add: string
  drop: string
  listed: number | null
  fingerprint: string
}

interface RequestError extends Error {
  kind: 'server' | 'unreachable'
  url: string
  status: number
  text: string
}

function requestError(fields: Omit<RequestError, 'name' | 'message'>, message: string): RequestError {
  return Object.assign(new Error(message), {name: 'RequestError', ...fields})
}

async function send(url: string, payload: string) {
  try {
    return await fetch(url, {method: 'POST', headers: {'content-type': 'application/json'}, body: payload})
  } catch (cause) {
    throw requestError({kind: 'unreachable', url, status: 0, text: String(cause)}, `Can't reach disk-clean (${url}). Is it still running in the terminal?`)
  }
}

async function post(url: string, payload: string) {
  const response = await send(url, payload)
  if (!response.ok) {
    const text = (await response.text().catch(() => '')).trim()
    throw requestError({kind: 'server', url, status: response.status, text}, `disk-clean answered ${response.status} to ${url}${text ? `: ${text}` : ''}`)
  }
  return response.json()
}

export function preview(token: string, selected: Selected): Promise<Plan> {
  return post('/preview', JSON.stringify({token, ...selected}))
}

export function children(token: string, path: string): Promise<TreeNode> {
  return post('/children', JSON.stringify({token, path}))
}

export function pick(token: string, path: string) {
  return post('/pick', JSON.stringify({token, path}))
}

export function rescan(token: string) {
  return post('/rescan', JSON.stringify({token}))
}

export function decide(token: string, decision: 'approve' | 'cancel', selected?: Selected, mode?: Mode) {
  return post('/decide', JSON.stringify({token, decision, ...selected, mode}))
}

export async function trashAction(token: string, action: 'undo' | 'empty', ids: readonly string[]): Promise<TrashEntry[]> {
  const answer: {entries?: TrashEntry[]} = await post(`/${action}`, JSON.stringify({token, ids}))
  return answer.entries ?? []
}
