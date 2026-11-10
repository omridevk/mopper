import {describe, expect, test} from 'vitest'
import vectors from '../../cli/tests/fixtures/selection-vectors.json'
import type {Item} from './lib/data'
import {createSelector, fingerprint, fullToken, type Group} from './lib/selection'

const itemOf = (path: string, preselect: boolean, report: boolean): Item => ({path, label: path, bytes: 1, action: 'rm', cmd_id: '-', note: '', age: 1, accuracy: 'exact', preselect, report})

function groups(): Group[] {
  const sections = new Map<string, Item[]>()
  for (const {path, section, preselect, report} of vectors.items) sections.set(section, [...(sections.get(section) ?? []), itemOf(path, preselect, report)])
  return [...sections].map(([id, items]) => ({id, risk: items.some(i => i.report) ? 'report' : 'safe', items}))
}

describe('the selection tokens the server decodes (shared vectors with the Rust decoder)', () => {
  test('tokens are the same hash', () => {
    for (const {path, short, full} of vectors.tokens) {
      const selector = createSelector()
      selector.sync([{id: 'x', risk: 'safe', items: [itemOf(path, true, false)]}])
      expect(fullToken(path)).toBe(full)
      expect(selector.tokenOf(path)).toBe(short)
    }
  })

  test('fingerprints are the same', () => {
    for (const {paths, fingerprint: expected} of vectors.fingerprints) expect(fingerprint(paths)).toBe(expected)
  })

  test('URL selections decode to the same paths', () => {
    for (const {add, drop, selected, fingerprint: expected} of vectors.decodes) {
      const on = createSelector().decode(groups(), {add, drop}).on
      const paths = Object.keys(on).toSorted()
      expect(paths).toEqual(selected)
      expect(fingerprint(paths)).toBe(expected)
    }
  })
})
