import {gsap} from 'gsap'
import {afterEach, expect, test} from 'vitest'
import {render} from 'vitest-browser-react'
import {film, finishedEvents, Movie, movieDb} from './test/movie'
import './index.css'

afterEach(() => {
  gsap.globalTimeline.timeScale(1)
})

test('on a GPU too slow for the burning backdrop, the movie drops it and still plays to its finale', async () => {
  gsap.globalTimeline.timeScale(4)
  const screen = await render(<Movie db={movieDb(finishedEvents)} />)
  await expect.poll(() => document.querySelector('[data-settled]'), {timeout: 20_000}).not.toBeNull()
  await expect.element(screen.getByRole('heading', {name: 'You freed'})).toBeVisible()
  expect(film('film')?.querySelector('canvas')).toBeNull()
}, 30_000)
