import {gsap} from 'gsap'
import {CustomEase} from 'gsap/CustomEase'
import {DrawSVGPlugin} from 'gsap/DrawSVGPlugin'
import {SplitText} from 'gsap/SplitText'
import {useGSAP} from '@gsap/react'
import type {CleanupEvent} from './cleanup-feed'
import {isOutcome, type Cleanup, type FilmPlan, type LogRow, type Outcome} from './progress'
import {formatBytes} from './data'
import {cssMs, cssValue} from './motion'

gsap.registerPlugin(useGSAP, SplitText, DrawSVGPlugin, CustomEase)

const POOL = 8
const STACK = 6
const FLOOD = 12
const HOLD = 0.3
const TRAVEL = 0.45
const TICK = 0.6
const SHRED = 1.4
const WAIT_HOLD = 1.5
const CREDITS_SPEED = 60
const WRITE_EVERY_MS = 50
const RECAP_BEATS = 7
const MIN_FREED = 0.02

export interface Tokens {
  fast: number
  medium: number
  slow: number
  verySlow: number
  stagger: number
  gather: number
  filmFade: number
}

const seconds = (name: string, fallback: number) => cssMs(name, fallback) / 1000

function readTokens(): Tokens {
  return {
    fast: seconds('--duration-fast', 250),
    medium: seconds('--duration-medium', 350),
    slow: seconds('--duration-slow', 400),
    verySlow: seconds('--duration-very-slow', 500),
    stagger: seconds('--stagger-stagger', 40),
    gather: seconds('--gather-dur', 1600),
    filmFade: seconds('--film-fade-dur', 1000),
  }
}

function bezier(name: string, fallback: string) {
  return /cubic-bezier\(([^)]+)\)/.exec(cssValue(name))?.[1] ?? fallback
}

function registerEases() {
  CustomEase.create('smooth-out', bezier('--ease-smooth-out', '0.22, 1, 0.36, 1'))
  CustomEase.create('pop', bezier('--ease-bounce', '0.34, 1.36, 0.64, 1'))
}

export type ParticlePhase = 'off' | 'gather' | 'landing'

export interface Setters {
  shred: (outcome: Outcome | null) => void
  particles: (phase: ParticlePhase) => void
  running: (on: boolean) => void
  path: (path: string) => string
}

interface Point {
  x: number
  y: number
}

interface Gauges {
  reclaimed: number
  cleared: number
  gone: Map<string, number>
  accounted: Map<string, number>
  failed: Set<string>
  free: number | null
  shownFree: number | null
  startFree: number
}

export interface Film {
  tl: gsap.core.Timeline
  root: HTMLElement
  plan: FilmPlan
  tokens: Tokens
  set: Setters
  gauges: Gauges
  rings: Map<string, Point>
  slot: Point
  pool: number
  processed: number
  backlog: number
  ready: boolean
  flood: boolean
  started: boolean
  counting: boolean
  trays: boolean
  finished: boolean
  onTail: () => void
  onReady: () => void
}

function one(film: Film, selector: string) {
  return film.root.querySelector<HTMLElement>(selector)
}

function all(film: Film, selector: string) {
  return [...film.root.querySelectorAll<HTMLElement>(selector)]
}

function part(film: Film, name: string) {
  return one(film, `[data-film="${name}"]`)
}

function centre(el: Element): Point {
  const r = el.getBoundingClientRect()
  return {x: r.left + r.width / 2, y: r.top + r.height / 2}
}

function offset(el: Element | null, from: Point): Point {
  if (!el) return {x: 0, y: 0}
  const c = centre(el)
  return {x: c.x - from.x, y: c.y - from.y}
}

function throttledText(el: HTMLElement, text: () => string) {
  let last = -Infinity
  const write = () => {
    const next = text()
    if (el.textContent !== next) el.textContent = next
  }
  const onUpdate = () => {
    const now = performance.now()
    if (now - last < WRITE_EVERY_MS) return
    last = now
    write()
  }
  return {onUpdate, onComplete: write}
}

function ticker(film: Film, el: HTMLElement | null, from: number, to: number, at: number, duration = TICK) {
  if (!el || from === to) return
  const value = {v: from}
  film.tl.fromTo(value, {v: from}, {v: to, duration, ease: 'power3.out', ...throttledText(el, () => formatBytes(value.v))}, at)
}

function draw(film: Film, el: Element | null | undefined, from: string, to: string, at: number) {
  if (el) film.tl.fromTo(el, {drawSVG: from}, {drawSVG: to, duration: 0.35, ease: 'power3.inOut'}, at)
}

function nextCard(film: Film) {
  const cards = all(film, '[data-film="card"]')
  film.pool = (film.pool + 1) % POOL
  return cards[film.pool]
}

function fill(card: HTMLElement, outcome: Outcome, path: (path: string) => string) {
  card.dataset.kind = outcome.kind
  const text = {label: path(outcome.label), size: formatBytes(outcome.bytes), reason: outcome.reason}
  for (const [name, value] of Object.entries(text)) {
    const slot = card.querySelector(`[data-part="${name}"]`)
    if (slot) slot.textContent = value
  }
}

function settle(film: Film) {
  film.root.dataset.settled = 'true'
}

function unsettle(film: Film) {
  delete film.root.dataset.settled
}

function sectionPct(film: Film, id: string, gone: number, accounted: number) {
  const section = film.plan.sections.find(s => s.id === id)
  if (!section) return 0
  return section.bytes > 0 ? (gone / section.bytes) * 100 : (accounted / section.count) * 100
}

const CLEARED = new Set<Outcome['kind']>(['removed', 'trashed'])
const bytesOf = (touched: Outcome[], kinds: ReadonlySet<Outcome['kind']>) => touched.filter(o => kinds.has(o.kind)).reduce((sum, o) => sum + o.bytes, 0)
const REMOVED = new Set<Outcome['kind']>(['removed'])

function account(film: Film, id: string, touched: Outcome[]) {
  const {gauges} = film
  const removed = bytesOf(touched, CLEARED)
  const before = gauges.gone.get(id) ?? 0
  const counted = (gauges.accounted.get(id) ?? 0) + touched.length
  gauges.gone.set(id, before + removed)
  gauges.accounted.set(id, counted)
  if (touched.some(o => !CLEARED.has(o.kind))) gauges.failed.add(id)
  const from = sectionPct(film, id, before, counted - touched.length)
  const to = Math.min(100, sectionPct(film, id, before + removed, counted))
  return {before, removed, counted, from, to}
}

function completeBeat(film: Film, id: string, row: HTMLElement, at: number) {
  if (!film.gauges.failed.has(id)) draw(film, row.querySelector('[data-part="check"]'), '0%', '100%', at)
  film.tl.fromTo(row, {opacity: 1}, {opacity: 0.6, duration: film.tokens.fast, ease: 'smooth-out'}, at)
}

function sectionBeat(film: Film, id: string, touched: Outcome[], at: number) {
  const section = film.plan.sections.find(s => s.id === id)
  const row = one(film, `[data-section="${CSS.escape(id)}"]`)
  if (!section || !row) return
  const {before, removed, counted, from, to} = account(film, id, touched)
  if (to !== from) draw(film, row.querySelector('[data-part="arc"]'), `0% ${from}%`, `0% ${to}%`, at)
  ticker(film, row.querySelector('[data-part="left"]'), section.bytes - before, Math.max(0, section.bytes - before - removed), at)
  film.tl.fromTo(row.querySelector('[data-part="ring"]'), {scale: 1}, {scale: 1.06, duration: 0.15, yoyo: true, repeat: 1, ease: 'power1.inOut'}, at + 0.35)
  if (counted >= section.count) completeBeat(film, id, row, at + 0.35)
}

export function gaugeOf(total: number, before: number, now: number, planned = now - before) {
  const used = total > 0 ? Math.max(0, total - before) / total : 0
  const freed = total > 0 ? Math.max(0, now - before) / total : 0
  const floor = planned > 0 ? MIN_FREED * Math.min(1, Math.max(0, now - before) / planned) : 0
  const shown = Math.min(used, Math.max(freed, floor))
  return {used, rest: used - shown, enlarged: shown > freed}
}

function restScale(film: Film, free: number) {
  return gaugeOf(film.plan.total, film.gauges.startFree, free, film.plan.approved).rest
}

function freeBeat(film: Film, at: number) {
  const {gauges} = film
  if (gauges.free === null || gauges.free === gauges.shownFree) return
  const from = gauges.shownFree ?? gauges.startFree
  gauges.shownFree = gauges.free
  ticker(film, part(film, 'free'), from, gauges.free, at, film.tokens.verySlow)
}

function countingBeat(film: Film, at: number) {
  const {fast, medium, verySlow} = film.tokens
  const hero = part(film, 'total')
  const slot = part(film, 'of-total')
  film.counting = true
  film.tl.fromTo(part(film, 'caption'), {opacity: 1, y: 0}, {opacity: 0, y: -8, duration: medium, ease: 'smooth-out'}, at)
  if (hero && slot) {
    const travel = offset(slot, centre(hero))
    const scale = slot.getBoundingClientRect().height / hero.getBoundingClientRect().height
    film.tl.fromTo(hero, {x: 0, y: 0, scale: 1, opacity: 1}, {x: travel.x, y: travel.y, scale, duration: verySlow, ease: 'power3.inOut'}, at)
    film.tl.to(hero, {opacity: 0, duration: 0.15}, at + verySlow - 0.15)
    film.tl.fromTo(slot, {opacity: 0}, {opacity: 1, duration: 0.15}, at + verySlow - 0.15)
  }
  film.tl.fromTo(part(film, 'counter-box'), {opacity: 0, y: 8}, {opacity: 1, y: 0, duration: verySlow, ease: 'smooth-out'}, at + fast)
}

function gauges(film: Film, touched: Outcome[], at: number) {
  const cleared = bytesOf(touched, CLEARED)
  const bytes = bytesOf(touched, REMOVED)
  if (cleared > 0 && !film.counting) countingBeat(film, at)
  ticker(film, part(film, 'counter'), film.gauges.cleared, film.gauges.cleared + cleared, at)
  film.gauges.cleared += cleared
  if (bytes > 0) {
    const start = film.gauges.startFree
    film.tl.fromTo(
      part(film, 'gauge-used'),
      {scaleX: restScale(film, start + film.gauges.reclaimed)},
      {scaleX: restScale(film, start + film.gauges.reclaimed + bytes), duration: TICK, ease: 'power3.out'},
      at,
    )
  }
  film.gauges.reclaimed += bytes
  const sections = [...new Set(touched.map(o => o.section).filter(Boolean))]
  sections.forEach((id, i) =>
    sectionBeat(
      film,
      id,
      touched.filter(o => o.section === id),
      at + i * film.tokens.stagger,
    ),
  )
  freeBeat(film, at)
}

function cardIn(film: Film, card: HTMLElement, outcome: Outcome, at: number, y = 0) {
  film.tl.call(fill, [card, outcome, film.set.path], at)
  film.tl.fromTo(card, {opacity: 0, scale: 0.96, x: 0, y}, {opacity: 1, scale: 1, duration: film.tokens.fast, ease: 'smooth-out'}, at)
}

function cardToRing(film: Film, card: HTMLElement, outcome: Outcome, at: number, y = 0) {
  const ring = film.rings.get(outcome.section) ?? {x: 0, y: 0}
  film.tl.fromTo(
    card,
    {x: 0, y, scale: 1, opacity: 1},
    {x: ring.x, y: ring.y, scale: 0.3, opacity: 0, duration: TRAVEL, ease: 'power3.inOut'},
    at,
  )
}

function singleBeat(film: Film, outcome: Outcome) {
  const at = film.tl.duration()
  if (film.plan.headline.has(outcome.key)) {
    film.tl.call(film.set.shred, [outcome], at)
    film.tl.call(film.set.shred, [null], at + SHRED)
    gauges(film, [outcome], at + SHRED - TICK)
    return
  }
  const card = nextCard(film)
  if (!card) return
  cardIn(film, card, outcome, at)
  cardToRing(film, card, outcome, at + film.tokens.fast + HOLD)
  gauges(film, [outcome], at + film.tokens.fast + HOLD - 0.15)
}

function chip(film: Film, text: string, at: number, hold: number) {
  const el = part(film, 'chip')
  if (!el) return
  film.tl.call(() => void (el.textContent = text), [], at)
  film.tl.fromTo(el, {opacity: 0, scale: 0.96}, {opacity: 1, scale: 1, duration: film.tokens.fast, ease: 'pop'}, at)
  film.tl.to(el, {opacity: 0, duration: 0.15, ease: 'smooth-out'}, at + hold)
}

function stackBeat(film: Film, outcomes: Outcome[]) {
  const at = film.tl.duration()
  const shown = outcomes.slice(0, STACK)
  const {fast, stagger} = film.tokens
  shown.forEach((outcome, i) => {
    const card = nextCard(film)
    if (!card) return
    cardIn(film, card, outcome, at + i * stagger, -i * 6)
    cardToRing(film, card, outcome, at + fast + HOLD + i * 0.03, -i * 6)
  })
  if (outcomes.length > STACK) chip(film, `+${outcomes.length - STACK} more`, at, fast + HOLD)
  gauges(film, outcomes, at + fast + HOLD - 0.15)
}

function floodBeat(film: Film, outcomes: Outcome[]) {
  const at = film.tl.duration()
  chip(film, `×${outcomes.length} done`, at, TICK - 0.15)
  gauges(film, outcomes, at)
}

function removalBeat(film: Film, outcomes: Outcome[], flood: boolean) {
  if (!film.counting) {
    countingBeat(film, film.tl.duration())
    film.tl.to({}, {duration: film.tokens.medium})
  }
  if (flood || outcomes.length > FLOOD) floodBeat(film, outcomes)
  else if (outcomes.length === 1 && outcomes[0]) singleBeat(film, outcomes[0])
  else stackBeat(film, outcomes)
}

function trayRow(film: Film, key: string) {
  return one(film, `[data-film="tray-row"][data-key="${CSS.escape(key)}"]`)
}

function showTrays(film: Film, at: number) {
  if (film.trays) return
  film.trays = true
  film.tl.fromTo(part(film, 'trays'), {opacity: 0, x: 16}, {opacity: 1, x: 0, duration: film.tokens.slow, ease: 'smooth-out'}, at)
}

function problemBeat(film: Film, problems: Outcome[]) {
  const at = film.tl.duration()
  const {fast, slow, stagger} = film.tokens
  showTrays(film, at + fast)
  problems.forEach((outcome, i) => {
    const card = nextCard(film)
    const start = at + i * stagger
    const row = trayRow(film, outcome.key)
    if (!card) return
    cardIn(film, card, outcome, start, i * 8)
    if (outcome.kind === 'failed') film.tl.to(card, {keyframes: {x: [-6, 6, -3, 0]}, duration: 0.3, ease: 'none'}, start + fast)
    else draw(film, card.querySelector('[data-part="lock"] path'), '0%', '100%', start + fast)
    const tray = offset(row, film.slot)
    film.tl.fromTo(card, {x: 0, y: i * 8, scale: 1, opacity: 1}, {x: tray.x, y: tray.y, scale: 0.5, opacity: 0, duration: slow, ease: 'smooth-out'}, start + fast + 0.35)
    if (row) film.tl.fromTo(row, {opacity: 0, x: 16}, {opacity: 1, x: 0, duration: slow, ease: 'smooth-out'}, start + fast + 0.35)
  })
  gauges(film, problems, at + fast)
}

function commandBeat(film: Film, outcome: Outcome) {
  const line = one(film, `[data-film="command"][data-key="${CSS.escape(outcome.key)}"]`)
  const label = line?.querySelector<HTMLElement>('[data-part="label"]')
  if (!line || !label) return
  const at = film.tl.duration()
  const split = SplitText.create(label, {type: 'chars'})
  film.tl.fromTo(line, {opacity: 0}, {opacity: 1, duration: 0.01}, at)
  film.tl.fromTo(split.chars, {opacity: 0}, {opacity: 1, duration: 0.01, ease: 'none', stagger: Math.min(0.02, 0.4 / Math.max(1, split.chars.length))}, at)
  draw(film, line.querySelector('[data-part="status"] path'), '0%', '100%', at + 0.4)
  const row = outcome.kind === 'failed' ? trayRow(film, outcome.key) : null
  if (row) showTrays(film, at + 0.4)
  if (row) film.tl.fromTo(row, {opacity: 0, x: 16}, {opacity: 1, x: 0, duration: film.tokens.slow, ease: 'smooth-out'}, at + 0.4)
  gauges(film, [outcome], at + 0.15)
}

function waitingBeat(film: Film) {
  film.tl.addLabel('waiting')
  film.tl.fromTo(part(film, 'waiting'), {opacity: 0, y: 6}, {opacity: 1, y: 0, duration: film.tokens.fast, ease: 'smooth-out'})
  film.tl.to({}, {duration: WAIT_HOLD - film.tokens.fast})
}

function measure(film: Film) {
  const slot = part(film, 'slot')
  if (!slot) return
  film.slot = centre(slot)
  for (const row of all(film, '[data-section]')) {
    const ring = row.querySelector('[data-part="ring"]')
    if (ring && row.dataset.section) film.rings.set(row.dataset.section, offset(ring, film.slot))
  }
}

function startedBeat(film: Film, free: number) {
  const at = film.tl.duration()
  const {medium, verySlow, stagger} = film.tokens
  film.started = true
  film.gauges.startFree = free
  film.gauges.shownFree = free
  film.tl.fromTo(part(film, 'waiting'), {opacity: 1, y: 0}, {opacity: 0, y: -8, duration: medium, ease: 'smooth-out'}, at)
  film.tl.fromTo(part(film, 'stage'), {autoAlpha: 0}, {autoAlpha: 1, duration: 0.01}, at)
  measure(film)
  const rows = all(film, '[data-film="build"]')
  film.tl.fromTo(rows, {opacity: 0, y: 12}, {opacity: 1, y: 0, duration: verySlow, ease: 'smooth-out', stagger: Math.min(stagger, 0.4 / Math.max(1, rows.length))}, at)
  film.tl.set(all(film, '[data-part="arc"], [data-part="check"]'), {drawSVG: '0% 0%'}, at)
  const {used} = gaugeOf(film.plan.total, free, free)
  film.tl.set([part(film, 'gauge-used'), part(film, 'gauge-freed')], {scaleX: used}, at)
}

function creditsBeat(film: Film, at: number) {
  const view = part(film, 'credits')
  if (!view) return at
  const distance = Math.max(0, view.scrollHeight - view.clientHeight)
  const duration = gsap.utils.clamp(8, 45, distance / CREDITS_SPEED)
  const types = ['wheel', 'pointerdown', 'touchstart', 'keydown']
  const release = () => {
    for (const type of types) view.removeEventListener(type, stop)
  }
  const stop = () => {
    release()
    roll.kill()
    settle(film)
  }
  const roll = gsap.fromTo(view, {scrollTop: 0}, {scrollTop: distance, duration, ease: 'none', onComplete: release})
  film.tl.add(roll, at)
  for (const type of types) view.addEventListener(type, stop, {passive: true})
  return at + duration
}

function particleBeat(film: Film, gather: number, quiet: boolean) {
  const {tl, tokens} = film
  if (quiet || film.gauges.reclaimed === 0) {
    tl.fromTo(part(film, 'freed'), {opacity: 0}, {opacity: 1, duration: tokens.verySlow, ease: 'smooth-out'}, gather)
    return gather
  }
  tl.call(film.set.particles, ['gather'], gather)
  const swapped = gather + tokens.gather
  tl.addPause(swapped, film.set.particles, ['landing'])
  tl.fromTo(part(film, 'freed'), {opacity: 0}, {opacity: 1, duration: tokens.verySlow, ease: 'smooth-out'}, swapped)
  const covered = swapped + tokens.verySlow
  tl.fromTo(part(film, 'particles'), {opacity: 1}, {opacity: 0, duration: tokens.fast, ease: 'smooth-out'}, covered)
  tl.call(film.set.particles, ['off'], covered + tokens.fast)
  return swapped
}

function finaleBeat(film: Film, quiet: boolean) {
  const {tl, tokens} = film
  film.finished = true
  const exit = tl.duration()
  const leaving = all(film, '[data-film="leave"], [data-film="trays"]')
  const opening = film.started ? [] : [part(film, 'waiting')]
  if (!film.counting) tl.to([part(film, 'total'), part(film, 'caption'), ...opening], {autoAlpha: 0, duration: tokens.medium, ease: 'smooth-out'}, exit)
  tl.fromTo(leaving, {opacity: 1, y: 0, filter: 'blur(0px)'}, {opacity: 0, y: -8, filter: 'blur(2px)', duration: tokens.medium, ease: 'smooth-out', stagger: 0.03}, exit)
  tl.fromTo(part(film, 'film'), {opacity: 1}, {opacity: 0.45 / 0.8, duration: tokens.filmFade, ease: 'power1.out'}, exit)
  tl.call(film.set.running, [false], exit + tokens.filmFade)
  const heading = part(film, 'freed-heading')
  const words = heading ? SplitText.create(heading, {type: 'words'}).words : []
  const shown = exit + tokens.fast
  tl.fromTo(part(film, 'stage'), {autoAlpha: 1}, {autoAlpha: 0, duration: 0.01}, exit + tokens.medium)
  tl.fromTo(part(film, 'finale'), {autoAlpha: 0}, {autoAlpha: 1, duration: 0.01}, shown)
  tl.fromTo(words, {opacity: 0, y: 12, filter: 'blur(3px)'}, {opacity: 1, y: 0, filter: 'blur(0px)', duration: tokens.verySlow, ease: 'smooth-out', stagger: tokens.stagger}, shown)
  const gather = shown + tokens.stagger
  const swapped = particleBeat(film, gather, quiet)
  const barsAt = gather + 0.4
  const gauge = part(film, 'gauge-after')
  const tiles = all(film, '[data-film="tile"]')
  const bars = all(film, '[data-film="bars"]')
  tl.set([...bars, ...tiles], {opacity: 0}, shown)
  if (gauge) tl.set(gauge, {scaleX: Number(gauge.dataset.from)}, shown)
  tl.fromTo(bars, {opacity: 0, y: 12}, {opacity: 1, y: 0, duration: tokens.verySlow, ease: 'smooth-out'}, barsAt)
  if (gauge) tl.fromTo(gauge, {scaleX: Number(gauge.dataset.from)}, {scaleX: Number(gauge.dataset.to), duration: 0.9, ease: 'power3.inOut'}, barsAt + 0.2)
  const stats = swapped + tokens.fast
  tl.fromTo(tiles, {opacity: 0, y: 12}, {opacity: 1, y: 0, duration: tokens.verySlow, ease: 'smooth-out', stagger: tokens.stagger}, stats)
  for (const value of all(film, '[data-ticker]')) {
    const to = Number(value.dataset.ticker)
    const count = {v: 0}
    tl.fromTo(count, {v: 0}, {v: to, duration: 0.8, ease: 'power3.out', ...throttledText(value, () => String(Math.round(count.v)))}, stats)
  }
  const statsEnd = stats + tokens.verySlow + tokens.stagger * tiles.length
  tl.fromTo(part(film, 'replay'), {autoAlpha: 0}, {autoAlpha: 1, duration: tokens.fast, ease: 'smooth-out'}, statsEnd)
  tl.fromTo(part(film, 'credits'), {opacity: 0}, {opacity: 1, duration: tokens.fast, ease: 'smooth-out'}, statsEnd)
  const end = creditsBeat(film, statsEnd + 0.3)
  tl.call(settle, [film], Math.max(end, swapped + tokens.verySlow + tokens.fast))
}

function outcomesOf(pending: readonly LogRow[]) {
  return pending.filter(isOutcome)
}

function startFree(cleanup: Cleanup, types: ReadonlySet<string>) {
  if (cleanup.started) return cleanup.started.free
  return types.has('done') ? cleanup.done?.free_before : undefined
}

function openingBeats(film: Film, cleanup: Cleanup, types: ReadonlySet<string>) {
  const free = startFree(cleanup, types)
  if (types.has('approved') && free === undefined && !cleanup.done) waitingBeat(film)
  if (!film.started && free !== undefined) startedBeat(film, free)
}

function workBeats(film: Film, found: Outcome[], flood: boolean) {
  const commands = found.filter(o => o.key.startsWith('cmd:'))
  const files = found.filter(o => !o.key.startsWith('cmd:'))
  const removed = files.filter(o => CLEARED.has(o.kind))
  const problems = files.filter(o => !CLEARED.has(o.kind))
  if (removed.length > 0) removalBeat(film, removed, flood)
  if (problems.length > 0) problemBeat(film, problems)
  for (const command of commands) commandBeat(film, command)
  if (found.length === 0) freeBeat(film, film.tl.duration())
}

function payoffBeat(film: Film, bytes: number) {
  const {tl, tokens} = film
  const at = tl.duration()
  tl.call(unsettle, [film], at)
  const heading = part(film, 'freed-heading')
  const words = heading ? SplitText.create(heading, {type: 'words'}).words : []
  tl.fromTo(words, {opacity: 0, y: 12, filter: 'blur(3px)'}, {opacity: 1, y: 0, filter: 'blur(0px)', duration: tokens.verySlow, ease: 'smooth-out', stagger: tokens.stagger}, at)
  tl.fromTo(all(film, '[data-film="trash-actions"]'), {autoAlpha: 1}, {autoAlpha: 0, duration: tokens.fast, ease: 'smooth-out'}, at)
  film.gauges.reclaimed = bytes
  const swapped = particleBeat(film, at + tokens.stagger, false)
  tl.call(settle, [film], swapped + tokens.verySlow + tokens.fast)
}

function afterFinale(film: Film, pending: readonly LogRow[]) {
  const emptied = pending.findLast(e => e.type === 'empty_done')?.event
  if (emptied?.type === 'empty_done' && emptied.data.emptied_bytes > 0) payoffBeat(film, emptied.data.emptied_bytes)
}

function sampleFree(film: Film, pending: readonly LogRow[]) {
  const sample = pending.findLast(e => e.type === 'free')?.event
  if (sample?.type === 'free') film.gauges.free = sample.data.free
}

const isTrashing = (cleanup: Cleanup) => (cleanup.done?.trashed ?? 0) > 0

function build(film: Film, cleanup: Cleanup, pending: readonly LogRow[]) {
  const types = new Set(pending.map(e => e.type))
  const abandoned = types.has('abandoned')
  const ending = abandoned || types.has('done')
  openingBeats(film, cleanup, types)
  if (!film.started) {
    if (ending) finaleBeat(film, true)
    return
  }
  sampleFree(film, pending)
  workBeats(film, outcomesOf(pending), film.flood || ending)
  if (ending) finaleBeat(film, abandoned || isTrashing(cleanup))
  film.flood = false
}

const OUTCOMES: ReadonlySet<CleanupEvent['type']> = new Set(['removed', 'trashed', 'failed', 'kept', 'worktree', 'command'])
const ENDINGS: ReadonlySet<CleanupEvent['type']> = new Set(['done', 'abandoned'])

function recapSize(film: Film, log: readonly LogRow[]) {
  const count = log.slice(0, film.backlog).filter(e => OUTCOMES.has(e.type)).length
  const beats = gsap.utils.clamp(RECAP_BEATS, 2 * RECAP_BEATS, Math.ceil(count / FLOOD))
  return Math.max(1, Math.ceil(count / beats))
}

function nextBatch(film: Film, log: readonly LogRow[]) {
  if (film.flood || film.processed >= film.backlog) return log.slice(film.processed)
  const rest = log.slice(film.processed, film.backlog)
  const done = rest.findIndex((e, i) => i > 0 && ENDINGS.has(e.type))
  const window = done > 0 ? rest.slice(0, done) : rest
  const marks = window.flatMap((e, i) => (OUTCOMES.has(e.type) ? [i] : []))
  return window.slice(0, marks[recapSize(film, log)] ?? window.length)
}

export function pump(film: Film | null, cleanup: Cleanup, log: readonly LogRow[], fromTail = false) {
  if (!film?.ready || document.hidden) return
  if (film.tl.isActive() && !fromTail) return
  const before = film.tl.duration()
  while (film.processed < log.length && film.tl.duration() <= before) {
    const pending = nextBatch(film, log)
    film.processed += pending.length
    if (film.finished) afterFinale(film, pending)
    else build(film, cleanup, pending)
  }
  if (film.tl.duration() <= before) return
  film.tl.call(() => film.onTail(), [], film.tl.duration())
  film.tl.play()
}

function openingAct(film: Film) {
  const {tokens} = film
  const act = gsap.timeline({onComplete: () => film.onReady()})
  act.fromTo(part(film, 'backdrop'), {opacity: 0}, {opacity: 1, duration: tokens.filmFade, ease: 'power1.out'}, 0)
  act.fromTo(part(film, 'total'), {opacity: 0, scale: 0.96}, {opacity: 1, scale: 1, duration: tokens.verySlow, ease: 'smooth-out'}, 0)
  const caption = part(film, 'caption')
  if (caption) {
    const lines = SplitText.create(caption, {type: 'lines'}).lines
    act.fromTo(lines, {opacity: 0, y: 12}, {opacity: 1, y: 0, duration: tokens.verySlow, ease: 'smooth-out', stagger: tokens.stagger}, tokens.fast)
  }
}

export function createFilm(root: HTMLElement, plan: FilmPlan, set: Setters, onTail: () => void, onReady: () => void): Film {
  registerEases()
  delete root.dataset.settled
  const tl = gsap.timeline({paused: true, defaults: {immediateRender: false}})
  const film: Film = {
    tl,
    root,
    plan,
    tokens: readTokens(),
    set,
    gauges: {reclaimed: 0, cleared: 0, gone: new Map(), accounted: new Map(), failed: new Set(), free: null, shownFree: null, startFree: 0},
    rings: new Map(),
    slot: {x: 0, y: 0},
    pool: -1,
    processed: 0,
    backlog: 0,
    ready: false,
    flood: false,
    started: false,
    counting: false,
    trays: false,
    finished: false,
    onTail,
    onReady,
  }
  openingAct(film)
  return film
}
