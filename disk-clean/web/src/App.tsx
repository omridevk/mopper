import {HotkeysProvider} from '@tanstack/react-hotkeys'
import {createRouter, RouterProvider, type RouterHistory} from '@tanstack/react-router'
import {useState} from 'react'
import type {Loaded} from './lib/data'
import {createDb, type Db} from './lib/db'
import {knownPicks} from './lib/page-data'
import {hotkeyPlatform} from './lib/platform'
import {parseSearch, stringifySearch} from './lib/search'
import {createTabMemory} from './lib/tab-memory'
import {routeTree} from './routeTree.gen'

function createAppRouter(loaded: Loaded, history: RouterHistory) {
  const tabs = createTabMemory()
  const db = createDb(loaded)
  const router = createRouter({routeTree, history, caseSensitive: true, search: {strict: true}, parseSearch, stringifySearch, context: {db, tabs}})
  db.scan.turns.add(() => void router.invalidate())
  const tried = {href: ''}
  router.subscribe('onResolved', () => {
    const {href} = router.state.location
    if (tried.href !== href && canonicalize(router, db)) {
      tried.href = href
      return
    }
    const {matches, location} = router.state
    const layout = matches.findIndex(match => match.routeId === '/_tabs')
    const tab = layout < 0 ? undefined : matches[layout + 1]
    const leaf = matches.at(-1)
    if (tab && leaf) tabs.remember(tab.routeId, {to: leaf.fullPath, params: leaf.params, search: location.search})
  })
  return router
}

type AppRouter = ReturnType<typeof createRouter<typeof routeTree>>

function canonicalize(router: AppRouter, db: Db) {
  const {location} = router.state
  const options = {
    to: location.pathname,
    hash: true,
    search: (prev: {add?: string; drop?: string}) => ({...prev, ...knownPicks(db, {add: prev.add ?? '', drop: prev.drop ?? ''})}),
  } as const
  if (router.buildLocation({...options, _includeValidateSearch: true}).href === location.href) return false
  void router.navigate({...options, replace: true})
  return true
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>
  }
}

export function App({loaded, history}: {loaded: Loaded; history: RouterHistory}) {
  const [router] = useState(() => createAppRouter(loaded, history))
  return (
    <HotkeysProvider defaultOptions={{hotkey: {platform: hotkeyPlatform(loaded)}}}>
      <RouterProvider router={router} />
    </HotkeysProvider>
  )
}
