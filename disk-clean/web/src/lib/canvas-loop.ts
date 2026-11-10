import {useCallback, useRef, useState} from 'react'
import {useReducedMotion} from './motion'

export interface Renderer {
  resize: (width: number, height: number, dpr: number) => void
  frame: (now: number) => void
  still: () => void
  dispose: () => void
}

export type CreateRenderer = (canvas: HTMLCanvasElement) => Renderer | null

const MAX_DPR = 1.5

function densityOf(scale: number) {
  return Math.min(window.devicePixelRatio || 1, MAX_DPR) * scale
}

function fit(canvas: HTMLCanvasElement, renderer: Renderer, scale: number) {
  renderer.resize(canvas.clientWidth, canvas.clientHeight, densityOf(scale))
}

function fitted(canvas: HTMLCanvasElement, scale: number) {
  const dpr = densityOf(scale)
  return canvas.width === Math.max(1, Math.round(canvas.clientWidth * dpr)) && canvas.height === Math.max(1, Math.round(canvas.clientHeight * dpr))
}

function drawStill(canvas: HTMLCanvasElement, renderer: Renderer, scale: number) {
  const draw = () => {
    if (fitted(canvas, scale)) return
    fit(canvas, renderer, scale)
    renderer.still()
  }
  const size = new ResizeObserver(draw)
  draw()
  size.observe(canvas)
  return () => size.disconnect()
}

function runLoop(canvas: HTMLCanvasElement, renderer: Renderer, scale: number) {
  let frame = 0
  let onScreen = true
  const tick = (now: number) => {
    renderer.frame(now)
    frame = requestAnimationFrame(tick)
  }
  const sync = () => {
    cancelAnimationFrame(frame)
    frame = onScreen && !document.hidden ? requestAnimationFrame(tick) : 0
  }
  const sight = new IntersectionObserver(entries => {
    onScreen = entries.at(-1)?.isIntersecting ?? true
    sync()
  })
  const size = new ResizeObserver(() => fit(canvas, renderer, scale))
  sight.observe(canvas)
  size.observe(canvas)
  document.addEventListener('visibilitychange', sync)
  fit(canvas, renderer, scale)
  sync()
  return () => {
    cancelAnimationFrame(frame)
    sight.disconnect()
    size.disconnect()
    document.removeEventListener('visibilitychange', sync)
  }
}

interface Mounted {
  canvas: HTMLCanvasElement
  renderer: Renderer
}

export function useCanvasRenderer(create: CreateRenderer, scale = 1, running = true) {
  const reduced = useReducedMotion()
  const mounted = useRef<Mounted | null>(null)
  const [failed, setFailed] = useState(false)
  const canvas = useCallback(
    (el: HTMLCanvasElement | null) => {
      if (!el) return
      const renderer = create(el)
      if (!renderer) return setFailed(true)
      fit(el, renderer, scale)
      renderer.still()
      mounted.current = {canvas: el, renderer}
      return () => {
        mounted.current = null
        renderer.dispose()
      }
    },
    [create],
  )
  const host = useCallback(
    (el: HTMLDivElement | null) => {
      const current = mounted.current
      if (!el || !current) return
      return reduced || !running ? drawStill(current.canvas, current.renderer, scale) : runLoop(current.canvas, current.renderer, scale)
    },
    [create, reduced, running, scale],
  )
  return {host, canvas, failed}
}
