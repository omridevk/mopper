import {gsap} from 'gsap'
import {afterEach, beforeEach, describe, expect, test} from 'vitest'
import {page, userEvent} from 'vitest/browser'
import {render} from 'vitest-browser-react'
import {App} from './App'
import type {CleanupEvent} from './lib/cleanup-feed'
import {formatBytes} from './lib/data'
import {approvedEvent, at, cleanupEvents, fixture} from './test/fixture'
import {film, finishedEvents, GB, Movie, movieDb, particleCanvas, selected, visibility} from './test/movie'
import './index.css'

async function renderFinished(scale = 4) {
  gsap.globalTimeline.timeScale(scale)
  return render(<Movie db={movieDb(finishedEvents)} />)
}

function settledIn(screen: Awaited<ReturnType<typeof render>>) {
  return expect.poll(() => document.querySelector('[data-settled]'), {timeout: 20_000}).not.toBeNull()
}

describe('the cleanup movie', () => {
  beforeEach(() => {
    document.documentElement.classList.add('dark')
  })
  afterEach(() => {
    document.documentElement.classList.remove('dark')
    gsap.globalTimeline.timeScale(1)
  })

  test('Replay starts the film over at normal speed and plays it to the same finale', async () => {
    const screen = await renderFinished()
    await settledIn(screen)
    const shader = document.querySelector('[data-film="film"] canvas')
    for (const take of [1, 2]) {
      await screen.getByRole('button', {name: 'Replay'}).click()
      expect(visibility('finale'), `take ${take} hides the finale`).toBe('hidden')
      expect(film('counter')?.textContent).toBe('0 B')
      await expect.poll(() => visibility('stage')).toBe('visible')
      await settledIn(screen)
      await expect.element(screen.getByRole('heading', {name: 'You freed'})).toBeVisible()
      expect(film('counter')?.textContent).toBe(formatBytes(3.5 * GB))
      expect(particleCanvas()).toBeNull()
      expect(document.querySelector('[data-film="film"] canvas'), 'the backdrop keeps its WebGL canvas').toBe(shader)
    }
  }, 60_000)

  test('the credits can be scrolled during the roll and after it', async () => {
    const screen = await renderFinished()
    const credits = () => film('credits') ?? document.body
    await expect.poll(() => credits().scrollTop, {timeout: 20_000}).toBeGreaterThan(10)
    await userEvent.wheel(page.elementLocator(credits()), {delta: {y: 40}})
    await expect.poll(() => document.querySelector('[data-settled]')).not.toBeNull()
    expect(gsap.isTweening(credits()), 'the wheel stops the roll').toBe(false)
    await userEvent.wheel(page.elementLocator(credits()), {delta: {y: -400}})
    await expect.poll(() => credits().scrollTop).toBe(0)
  }, 30_000)

  test('after the roll the credits list is a normal scroll list', async () => {
    const screen = await renderFinished()
    await settledIn(screen)
    const credits = film('credits') ?? document.body
    const end = credits.scrollTop
    expect(end).toBe(credits.scrollHeight - credits.clientHeight)
    await userEvent.wheel(page.elementLocator(credits), {delta: {y: -100}})
    await expect.poll(() => credits.scrollTop).toBeLessThan(end)
    credits.focus()
    expect(document.activeElement).toBe(credits)
    await userEvent.keyboard('{Home}')
    await expect.poll(() => credits.scrollTop).toBe(0)
  }, 30_000)

  test('the disk gauge stays on screen and says what it measures', async () => {
    const screen = await renderFinished(1)
    await expect.poll(() => visibility('stage'), {timeout: 10_000}).toBe('visible')
    const stage = film('gauge-used')?.closest('[data-film="build"]')
    if (!(stage instanceof HTMLElement)) throw new Error('no stage gauge')
    const box = stage.getBoundingClientRect()
    expect(box.left).toBeGreaterThanOrEqual(0)
    expect(box.right).toBeLessThanOrEqual(innerWidth)
    expect(box.bottom).toBeLessThanOrEqual(innerHeight)
    expect(stage.textContent).toContain(`Free space${formatBytes(50 * GB)} → `)
    gsap.globalTimeline.timeScale(4)
    await settledIn(screen)
    const end = film('bars')
    expect(end?.textContent).toContain(`${formatBytes(3.5 * GB)} removed`)
    expect(end?.textContent).toContain(`free space ${formatBytes(50 * GB)} → ${formatBytes(53.4 * GB)}`)
    expect(end?.textContent).toContain('too small to see at true scale')
    const shown = film('gauge-after')
    expect(Number(shown?.dataset.from) - Number(shown?.dataset.to)).toBeGreaterThan(0.01)
  }, 40_000)

  test('only stat tiles with details open, in a popover, and the grid never grows', async () => {
    const screen = await renderFinished()
    await settledIn(screen)
    const grid = document.querySelector('[data-film="tile"]')?.parentElement
    if (!grid) throw new Error('no tiles')
    const size = () => `${grid.getBoundingClientRect().width}x${grid.getBoundingClientRect().height}`
    const before = size()
    await screen.getByText('removed for good').click()
    expect(document.querySelector('[data-slot="popover-content"]')).toBeNull()
    expect(size()).toBe(before)
    await screen.getByRole('button', {name: /not removed/}).click()
    const popover = page.getByRole('dialog', {name: 'not removed'})
    await expect.element(popover).toBeVisible()
    await expect.element(popover).toHaveTextContent('~/Library/Caches/app-dstill present after removal: permission denied')
    expect(size()).toBe(before)
  }, 30_000)

  test('the movie traps focus and gives it back to Details when it closes', async () => {
    const source = Object.assign(new EventTarget(), {readyState: 1, close: () => {}})
    const screen = await render(<App loaded={{...fixture, openEvents: () => source}} history={at()} />)
    for (const event of cleanupEvents) source.dispatchEvent(new MessageEvent(event.type, {data: JSON.stringify(event.data)}))
    const details = screen.getByRole('button', {name: 'Details'})
    await details.click()
    await page.getByRole('button', {name: 'Watch the movie'}).click()
    const movie = page.getByRole('dialog', {name: 'Cleanup movie'})
    await expect.element(movie).toBeInTheDocument()
    for (let i = 0; i < 4; i++) {
      await userEvent.keyboard('{Tab}')
      await expect.poll(() => document.activeElement?.closest('[aria-label="Cleanup movie"]')).not.toBeNull()
    }
    await userEvent.keyboard('{Escape}')
    await expect.element(movie).not.toBeInTheDocument()
    await expect.element(details).toHaveFocus()
  }, 30_000)

  test('a cleanup that removed nothing ends on what happened, not on a celebration', async () => {
    gsap.globalTimeline.timeScale(4)
    const failed = movieDb([
      {type: 'started', data: {run: 'run-1', free: 50 * GB, paths: 2, worktrees: 0, commands: 1, bytes: 2 * GB, elapsed_ms: 0}},
      {type: 'failed', data: {path: '/Users/you/Library/Caches/app-a', bytes: 2 * GB, reason: 'Operation not permitted', elapsed_ms: 10}},
      {type: 'command', data: {id: 'brew', label: 'brew cleanup', status: 'failed', elapsed_ms: 20}},
      {type: 'done', data: {free_before: 50 * GB, free_after: 50 * GB, elapsed_ms: 30}},
    ])
    const screen = await render(<Movie db={failed} />)
    await settledIn(screen)
    await expect.element(screen.getByRole('heading', {name: 'Nothing could be removed'})).toBeVisible()
    expect(film('freed')?.textContent).toBe('2 not removed')
    expect(document.body.textContent).not.toContain('brew cleanup failed')
  }, 30_000)

  test('a done that arrives without a start still ends the film', async () => {
    gsap.globalTimeline.timeScale(4)
    const orphan = movieDb([{type: 'done', data: {free_before: 50 * GB, free_after: 50 * GB, elapsed_ms: 5}}])
    const screen = await render(<Movie db={orphan} />)
    await settledIn(screen)
    await expect.element(screen.getByRole('heading', {name: 'Nothing was removed'})).toBeVisible()
  }, 30_000)

  test('a cleanup that never started ends on why, not on a celebration', async () => {
    gsap.globalTimeline.timeScale(4)
    const never = movieDb([
      cleanupEvents[0],
      {type: 'abandoned', data: {reason: 'clean was never run after the approval'}},
    ])
    const screen = await render(<Movie db={never} />)
    await settledIn(screen)
    await expect.element(screen.getByRole('heading', {name: 'The cleanup did not start'})).toBeVisible()
    expect(film('freed')?.textContent).toBe('clean was never run after the approval')
    expect(visibility('finale')).toBe('visible')
    expect(getComputedStyle(film('waiting') ?? document.body).opacity).toBe('0')
    expect(particleCanvas()).toBeNull()
  }, 30_000)

  test('a cleanup that stopped halfway ends on what it freed and what it kept', async () => {
    gsap.globalTimeline.timeScale(4)
    const stopped = movieDb([
      cleanupEvents[1],
      cleanupEvents[2],
      {type: 'kept', data: {path: '/Users/you/Library/Caches/app-b', bytes: GB, reason: 'it changed after the approval', elapsed_ms: 1200}},
      {type: 'abandoned', data: {reason: 'the cleanup process exited before it finished'}},
    ])
    const screen = await render(<Movie db={stopped} />)
    await settledIn(screen)
    await expect.element(screen.getByRole('heading', {name: 'The cleanup stopped before it finished'})).toBeVisible()
    expect(film('freed')?.textContent).toBe(`the cleanup process exited before it finished · freed ${formatBytes(2 * GB)}`)
    expect(particleCanvas()).toBeNull()
    await screen.getByRole('button', {name: /kept/}).click()
    await expect.element(screen.getByRole('dialog', {name: 'kept'}).getByText('it changed after the approval')).toBeVisible()
  }, 30_000)

  test('the shredder never cuts through the caption, and cards stay in their column at narrow widths', async () => {
    const size = [innerWidth, innerHeight] as const
    await page.viewport(1024, 760)
    gsap.globalTimeline.timeScale(2)
    let caption = -1
    const watch = new MutationObserver(() => {
      if (caption < 0 && document.querySelector('[data-film="slot"] canvas')) caption = Number(getComputedStyle(film('caption') ?? document.body).opacity)
    })
    watch.observe(document.body, {subtree: true, childList: true})
    await render(<Movie db={movieDb(finishedEvents)} />)
    await expect.poll(() => caption, {timeout: 15_000}).toBeGreaterThanOrEqual(0)
    watch.disconnect()
    expect(caption).toBe(0)
    const list = film('stage')?.querySelector('ol')?.getBoundingClientRect()
    const slot = film('slot')?.getBoundingClientRect()
    expect(slot && list && slot.left >= list.right).toBe(true)
    await page.viewport(...size)
  }, 30_000)

  test('waiting for Claude only animates compositor properties', async () => {
    const source = Object.assign(new EventTarget(), {readyState: 1, close: () => {}})
    const screen = await render(<App loaded={{...fixture, openEvents: () => source}} history={at()} />)
    const approved = approvedEvent(selected.map(i => i.path))
    source.dispatchEvent(new MessageEvent(approved.type, {data: JSON.stringify(approved.data)}))
    await expect.element(screen.getByText('waiting for Claude to run it', {exact: false}).first()).toBeInTheDocument()
    const looping = document.getAnimations().filter(a => a.effect?.getTiming().iterations === Infinity)
    const animated = looping.flatMap(a => (a.effect instanceof KeyframeEffect ? a.effect.getKeyframes().flatMap(Object.keys) : []))
    const painted = animated.filter(p => !['offset', 'computedOffset', 'easing', 'composite', 'opacity', 'transform'].includes(p))
    expect(animated).toContain('opacity')
    expect(painted).toEqual([])
  })
})
