import {createOptimisticAction} from '@tanstack/db'
import {decide, messageOf, rescan as requestRescan, httpStatusOf, trashAction, type Mode, type Selected} from './api'
import {beginRound, openScan, receiveTrash, writeSession, type Action, type Db, type Planned, type Request} from './db'
import {RESTART, type Entry} from './scan-feed'

const plannedOf = ({path, label, bytes, section, exact}: Entry): Planned => ({path, label, bytes, section, exact})

function markPending(db: Db, action: Action) {
  const requests = db.requests.collection
  if (requests.has(action)) {
    requests.update(action, draft => {
      draft.status = 'pending'
      draft.message = ''
    })
    return
  }
  requests.insert({id: action, status: 'pending', message: '', retry: false})
}

const BUSY = 'Another cleanup, undo or empty is running; try again when it finishes'
const BUSY_ACTIONS = new Set<Action>(['undo', 'empty'])

function failureOf(action: Action, e: unknown): Request {
  if (BUSY_ACTIONS.has(action) && httpStatusOf(e) === 409) return {id: action, status: 'failed', message: BUSY, retry: false}
  return {id: action, status: 'failed', message: messageOf(e), retry: true}
}

function tracked(db: Db, action: Action, apply: () => void, send: () => Promise<void>) {
  const run = createOptimisticAction<null>({
    onMutate: () => {
      markPending(db, action)
      apply()
    },
    mutationFn: async () => {
      await send()
      db.requests.write(writes => writes.remove(action))
    },
  })
  return run(null)
    .when('settled')
    .then(
      () => undefined,
      (e: unknown) => db.requests.write(writes => writes.put(failureOf(action, e))),
    )
}

interface Approval {
  items: readonly Entry[]
  selected: Selected
  mode: Mode
}

const decisionIn = (answer: unknown) =>
  typeof answer === 'object' && answer !== null && 'decision' in answer && typeof answer.decision === 'number' ? answer.decision : null

export function approve(db: Db, {items, selected, mode}: Approval) {
  return tracked(
    db,
    'approve',
    () => {},
    async () => {
      const decision = decisionIn(await decide(db.loaded.token, 'approve', selected, mode))
      if (decision === null || decision !== db.cleanup.decision) beginRound(db, {decision: decision ?? 0, items: items.map(plannedOf), trash_run: ''})
    },
  )
}

export function cancel(db: Db) {
  return tracked(
    db,
    'cancel',
    () => {},
    async () => {
      await decide(db.loaded.token, 'cancel')
      writeSession(db, {cancelled: true})
    },
  )
}

export function askTrash(db: Db, action: 'undo' | 'empty', ids: readonly string[]) {
  return tracked(
    db,
    action,
    () => {},
    async () => {
      receiveTrash(db, await trashAction(db.loaded.token, action, ids))
    },
  )
}

function restarted(db: Db) {
  return new Promise<void>(resolve => db.scan.restarts.add(resolve))
}

function restartOptimistically(db: Db) {
  db.scan.scan.collection.update('scan', draft => {
    Object.assign(draft, {...RESTART, rescans: draft.rescans + 1})
  })
  db.scan.progress.collection.update('progress', draft => Object.assign(draft, {files: 0, bytes: 0, dir: ''}))
}

export function restartScan(db: Db) {
  return tracked(
    db,
    'rescan',
    () => restartOptimistically(db),
    async () => {
      await requestRescan(db.loaded.token)
      const confirmed = restarted(db)
      openScan(db)
      await confirmed
    },
  )
}
