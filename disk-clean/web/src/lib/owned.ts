import {BasicIndex, createCollection, type SyncConfig} from '@tanstack/db'

type SyncParams<T extends object> = Parameters<SyncConfig<T, string>['sync']>[0]

export interface Writes<T extends object> {
  put: (row: T) => void
  remove: (key: string) => void
  clear: () => void
}

function writesOf<T extends object>(params: SyncParams<T>, keyOf: (row: T) => string, synced: Map<string, T>): Writes<T> {
  return {
    put: row => {
      const key = keyOf(row)
      params.write({type: synced.has(key) ? 'update' : 'insert', value: row})
      synced.set(key, row)
    },
    remove: key => {
      if (!synced.delete(key)) return
      params.write({type: 'delete', key})
    },
    clear: () => {
      params.truncate()
      synced.clear()
    },
  }
}

export function ownedCollection<T extends object>(keyOf: (row: T) => string, seed: readonly T[], ready = true) {
  const synced = new Map<string, T>()
  const state = {version: 0, ready}
  let params: SyncParams<T> | null = null
  const collection = createCollection<T, string>({
    getKey: keyOf,
    gcTime: 0,
    startSync: true,
    autoIndex: 'eager',
    defaultIndexType: BasicIndex,
    sync: {
      rowUpdateMode: 'full',
      sync: started => {
        params = started
        started.begin()
        const writes = writesOf(started, keyOf, synced)
        for (const row of seed) writes.put(row)
        started.commit()
        if (state.ready) started.markReady()
      },
    },
  })
  const write = (body: (writes: Writes<T>) => void) => {
    if (!params) return
    params.begin({immediate: true})
    body(writesOf(params, keyOf, synced))
    params.commit()
    state.version += 1
  }
  const markReady = () => {
    if (state.ready) return
    state.ready = true
    params?.markReady()
  }
  return {collection, write, markReady, synced: synced as ReadonlyMap<string, T>, version: () => state.version}
}
