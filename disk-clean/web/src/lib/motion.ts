import {useCallback, useRef, useState, useSyncExternalStore, type AnimationEvent} from 'react'

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)'

function prefersReducedMotion() {
  return window.matchMedia(REDUCED_MOTION).matches
}

function onReducedMotionChange(notify: () => void) {
  const query = window.matchMedia(REDUCED_MOTION)
  query.addEventListener('change', notify)
  return () => query.removeEventListener('change', notify)
}

export function useReducedMotion() {
  return useSyncExternalStore(onReducedMotionChange, prefersReducedMotion)
}

export function cssValue(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

export function cssNumber(name: string, fallback: number) {
  return parseFloat(cssValue(name)) || fallback
}

export function cssMs(name: string, fallback: number) {
  const value = cssValue(name)
  const number = parseFloat(value)
  if (Number.isNaN(number)) return fallback
  return value.endsWith('ms') ? number : number * 1000
}

function reflow(el: HTMLElement) {
  return el.offsetHeight
}

export function useReveal(key: string) {
  const [reveal, setReveal] = useState({key, replay: false})
  if (reveal.key !== key) setReveal({key, replay: true})
  return reveal.replay
}

function showOnMount(block: HTMLDivElement | null) {
  if (!block) return
  block.classList.remove('is-hiding', 'is-shown')
  reflow(block)
  block.classList.add('is-shown')
}

export function useShownOnMount() {
  return showOnMount
}

export function useTextSwap(text: string) {
  const reduced = useReducedMotion()
  const [swap, setSwap] = useState({shown: text, swaps: 0})
  if (reduced && text !== swap.shown) setSwap({shown: text, swaps: swap.swaps})
  const leaving = text !== swap.shown
  const onAnimationEnd = (event: AnimationEvent<HTMLElement>) => {
    if (leaving && event.target === event.currentTarget && event.animationName === 't-text-swap-exit') setSwap({shown: text, swaps: swap.swaps + 1})
  }
  const className = ['t-text-swap', leaving && 'is-exit', swap.swaps > 0 && 'is-swapped'].filter(Boolean).join(' ')
  return {shown: swap.shown, className, onAnimationEnd}
}

function placePill(pill: HTMLElement, tab: HTMLElement) {
  pill.style.transform = `translateX(${tab.offsetLeft}px)`
  pill.style.width = `${tab.offsetWidth}px`
}

function snapPill(pill: HTMLElement, tab: HTMLElement) {
  const previous = pill.style.transition
  pill.style.transition = 'none'
  placePill(pill, tab)
  reflow(pill)
  pill.style.transition = previous
}

function movePill(bar: HTMLElement, pill: HTMLElement | null, selector: string, animate: boolean) {
  const tab = bar.querySelector<HTMLElement>(selector)
  if (!pill || !tab) return
  if (animate) placePill(pill, tab)
  else snapPill(pill, tab)
}

export function useTabsPill<T extends HTMLElement>(selector: string) {
  const pill = useRef<HTMLSpanElement>(null)
  const bar = useCallback(
    (host: T | null) => {
      if (!host) return
      const move = (animate: boolean) => movePill(host, pill.current, selector, animate)
      move(false)
      const resize = new ResizeObserver(() => move(false))
      const select = new MutationObserver(() => move(true))
      resize.observe(host)
      select.observe(host, {subtree: true, attributeFilter: ['aria-selected', 'aria-pressed']})
      return () => {
        resize.disconnect()
        select.disconnect()
      }
    },
    [selector],
  )
  return {bar, pill}
}

export const STATE_MOTION = 'transition-[background-color,border-color] duration-(--duration-quick) ease-(--ease-smooth-out) motion-reduce:transition-none'
