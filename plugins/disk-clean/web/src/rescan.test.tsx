import {afterEach, describe, expect, test, vi} from 'vitest'
import {CLEANABLE, clickRescan, finishedBigScan, firstEventsOfRescan, pinDrawnFolder, selectAndDeselect} from './test/big-scan'
import './index.css'

describe('Rescan and Select for delete on a 2,129-folder map', () => {
  afterEach(() => vi.restoreAllMocks())

  test.each(['/cleanup', '/storage'])('on %s Rescanning shows within a frame of the click and the new scan streams in', async url => {
    const scan = await finishedBigScan(url)
    await clickRescan(scan)
    expect(scan.screen.getByText('Rescanning').query()).not.toBeNull()
    expect(scan.rescan.element()).toBeDisabled()
    await firstEventsOfRescan(scan)
    await expect.element(scan.screen.getByText('Rescanning')).toBeVisible()
    await expect.element(scan.screen.getByText('11,000 files · 11.0 GB')).toBeVisible()
  })

  test('on /storage after the walk, Select for delete outlines the folder blue and the same button takes it back', async () => {
    const scan = await finishedBigScan('/storage')
    const pin = await pinDrawnFolder(scan)
    expect(pin.strokeAt()).toBe(CLEANABLE)
    await selectAndDeselect(pin)
    await expect.element(pin.pinned.getByText('~/d0', {exact: true})).toBeVisible()
  })
})
