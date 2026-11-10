# disk-clean: no effects

Decided 2026-10-04 (user's standing rule: `useEffect` is forbidden). `useLayoutEffect` counts too.
The page had 30 effect calls when this was written; the target is zero in our code.

## Where each kind of effect goes instead

| today | instead |
| --- | --- |
| opening EventSource streams (`lib/live.ts`, `lib/cleanup.ts`) | the TanStack DB collection sync owns the stream lifecycle (db.md); React reads live queries |
| fetching the confirm plan when the dialog opens (`shell.tsx`) | the `/cleanup/confirm` route `loader` (router.md, "Routes own their UI") |
| redirects and "open when the route matches" | `beforeLoad` / `redirect` / `notFound` in the route |
| syncing a value into state when a prop changes (`summary.tsx`, `numbers.tsx`, `cleanup.tsx` search draft, `motion.ts` text swap) | derive during render, `key` to reset, or keep the previous value in state and compare during render (React's "storing information from previous renders") |
| ticking clocks and countdowns (`scan-status.tsx`, `action-bar.tsx`) | CSS animations / `animationend`, or a `useSyncExternalStore` clock store |
| GSAP timelines (`cleanup-film.tsx`, `motion.ts`) | `useGSAP` from `@gsap/react` (the library's hook, already installed), or ref callbacks |
| canvas / WebGL / particle loops (`canvas-loop.ts`, `react-bits/*`) | ref callbacks that start the loop and return a cleanup (React 19), plus `useSyncExternalStore` for visibility and reduced-motion |
| window/document listeners (keyboard shortcuts, resize, visibility) | ref callbacks, `useSyncExternalStore`, or the owning library's API |

Ref callbacks are only for attaching to a DOM node's lifetime: subscriptions, observers, imperative
libraries, canvas loops, whose dependencies are configuration. A ref callback whose dependencies
are data and whose job is "when this value changes, do that" (timers, replays, re-measures) is an
effect in disguise and is not allowed. Use instead:
- `key` remount plus a CSS animation for replays;
- render-time derivation plus `onAnimationEnd`/`onTransitionEnd` to advance a state machine;
- `useGSAP` with dependencies (including GSAP Flip) for measured layout animation;
- the event handler that caused the change.

Library hooks that use effects internally (`useGSAP`, TanStack hooks, Base UI) are fine; our code
does not call `useEffect` / `useLayoutEffect`.

## Done when

`git grep -n "useEffect\|useLayoutEffect" -- 'disk-clean/web/src' ':!*.test.*'` returns
nothing, an oxlint/eslint rule (`no-restricted-imports` / `no-restricted-syntax` for both hooks)
fails the build if one comes back, and every browser test passes with the same meaning.
