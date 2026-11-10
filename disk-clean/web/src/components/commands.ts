import type {Hotkey} from '@tanstack/react-hotkeys'
import {page, type Command, type Commands} from '@/lib/commands'
import {formatBytes, plural, RISK_LABEL, sizeOf} from '@/lib/data'
import type {Selection} from '@/lib/page-data'
import {MIN_AGES, MIN_SIZES, NO_FILTERS, RISKS, SHAPES, SORTS, type Shape, type TrashSearch} from '@/lib/search'
import {isFiltering} from '@/lib/shaping'
import {DELETE} from './action-bar'
import {AGE_LABEL, QUICK_SELECT_MIN, SIZE_LABEL, SORT_LABEL, toggled, type ChangeList, type Group, type Listing} from './cleanup'
import {SHAPE_LABEL} from './storage'
import {pickedIn, whenOf, type Run, type TrashActions} from './trash-view'

export interface Page {
  tabs: readonly {id: string; label: string}[]
  selection: Selection
  progress: boolean
  round: boolean
  scanning: boolean
  deleteReady: boolean
  deleteNow: readonly Hotkey[]
  path: (path: string) => string
  reduced: boolean
  cleanupTrash: boolean
  cleanup: {listing: Listing; section: string | undefined; onList: ChangeList} | null
  storage: {shape: Shape; drawn: boolean} | null
  trash: {search: TrashSearch; runs: readonly Run[]; busy: boolean; actions: TrashActions} | null
  on: {
    tab: (id: string) => void
    section: (id: string) => void
    confirm: (now: boolean) => void
    rescan: () => void
    details: () => void
    movie: () => void
    undoCleanup: () => void
    emptyCleanup: () => void
    reshape: (shape: Shape) => void
    shortcuts: () => void
    about: () => void
  }
}

function inSection(group: Group, choose: Listing['choose']): Command {
  const {category, shown} = group
  const few = shown.selectable < QUICK_SELECT_MIN
  const aged = !few && shown.aged > 0
  const idle = (days: number) => () => choose(category.id, entry => (entry.age ?? -1) >= days)
  return page('in-section', 'In this section…', 'Select', [
    {id: 'section-all', name: 'Select all in this section', label: 'All', group: 'Select', enabled: !few, run: () => choose(category.id, () => true)},
    {id: 'section-idle-90', name: 'Select items idle 90+ days in this section', label: 'Idle 90+ days', group: 'Select', enabled: aged, run: idle(90)},
    {id: 'section-idle-365', name: 'Select items idle 1+ year in this section', label: 'Idle 1+ year', group: 'Select', enabled: aged, run: idle(365)},
    {id: 'section-none', name: 'Select none in this section', label: 'None', group: 'Select', enabled: !few, run: () => choose(category.id, () => false)},
  ])
}

function cleanupCommands({cleanup, selection, progress, deleteReady, path, on}: Page, ticked: boolean): {top: Command[]; selected: Command[]} {
  if (!cleanup) return {top: [], selected: []}
  const {listing, section, onList} = cleanup
  const {list, groups, choose, search} = listing
  const open = groups.find(group => group.category.id === section)
  const view = list.view === 'list' ? 'cards' : 'list'
  const clear: Command = {id: 'clear-selection', name: 'Clear selection', group: 'Select', hotkey: 'D', enabled: !progress, run: () => selection.setRowSelection({})}
  const count = selection.selected.length
  return {
    top: [
      page('sections', 'Go to section…', 'Go to', groups.map(({category}) => ({id: `section:${category.id}`, name: category.title, group: 'Go to', keywords: ['Go to section'], enabled: true, run: () => on.section(category.id)}))),
      {id: 'filter-paths', name: 'Filter paths', group: 'Filter and view', hotkey: '/', enabled: true, run: () => search.current?.focus()},
      page('filter', 'Filter…', 'Filter and view', [
        ...RISKS.map(risk => ({id: `risk:${risk}`, name: `Show ${RISK_LABEL[risk]}`, group: 'Filter and view' as const, checked: list.risk.includes(risk), enabled: true, run: () => onList({risk: toggled(list.risk, risk)})})),
        page('min-size', 'Minimum size…', 'Filter and view', MIN_SIZES.map(minSize => ({id: `min-size:${minSize}`, name: SIZE_LABEL(minSize), group: 'Filter and view', checked: list.minSize === minSize, enabled: true, run: () => onList({minSize})}))),
        page('min-age', 'Minimum idle…', 'Filter and view', MIN_AGES.map(minAge => ({id: `min-age:${minAge}`, name: AGE_LABEL(minAge), group: 'Filter and view', checked: list.minAge === minAge, enabled: true, run: () => onList({minAge})}))),
        {id: 'only-selected', name: 'Only selected', group: 'Filter and view', checked: list.only, enabled: true, run: () => onList({only: !list.only})},
        {id: 'clear-filters', name: 'Clear filters', group: 'Filter and view', enabled: isFiltering(list), run: () => onList(NO_FILTERS)},
      ]),
      page('sort', 'Sort by…', 'Filter and view', SORTS.map(sort => ({id: `sort:${sort}`, name: SORT_LABEL[sort], group: 'Filter and view', checked: list.sort === sort, enabled: true, run: () => onList({sort})}))),
      {id: 'switch-view', name: `Switch to ${view} view`, group: 'Filter and view', hotkey: 'V', enabled: true, run: () => onList({view})},
      page('select', 'Select…', 'Select', [
        {id: 'select-all', name: 'Select all shown', group: 'Select', hotkey: 'A', enabled: !progress, run: () => choose(null, () => true)},
        ...(ticked ? [] : [clear]),
        {id: 'reset-selection', name: 'Reset to recommended', group: 'Select', hotkey: 'R', enabled: !progress, run: () => selection.reset()},
        ...(open && !progress ? [inSection(open, choose)] : []),
      ]),
      ...(open ? [{id: 'delete-in-table', name: 'Delete… (in the item list)', group: 'Clean up' as const, hotkey: ['Backspace', 'Delete'] as const, enabled: deleteReady, scoped: true as const, run: () => on.confirm(false)}] : []),
    ],
    selected: ticked
      ? [
          {id: 'show-selected', name: 'Show only selected', group: 'Filter and view', checked: list.only, enabled: true, run: () => onList({only: !list.only})},
          clear,
          {id: 'copy-paths', name: `Copy ${plural(count, 'path', 'paths')}`, group: 'Select', enabled: true, run: () => void navigator.clipboard.writeText(selection.selected.map(entry => path(entry.path)).join('\n'))},
        ]
      : [],
  }
}

function trashCommands({trash}: Page) {
  if (!trash) return {top: [], selected: [], heading: ''}
  const {search, runs, busy, actions} = trash
  const {chosen} = pickedIn(runs, search)
  const ids = chosen.map(entry => entry.id)
  const items = plural(chosen.length, 'item', 'items')
  return {
    top: [
      page('runs', 'Show cleanup…', 'Trash', [
        {id: 'trash-all', name: 'All cleanups', group: 'Trash', enabled: search.run !== '', run: () => actions.onRun('')},
        ...runs.map(run => ({id: `trash-run:${run.id}`, name: whenOf(run.at), group: 'Trash' as const, keywords: ['Show cleanup of'], enabled: run.id !== search.run, run: () => actions.onRun(run.id)})),
      ]),
    ],
    selected:
      chosen.length > 0
        ? [
            {id: 'trash-undo', name: 'Undo selected', label: `Undo ${items}`, group: 'Trash' as const, enabled: !busy, run: () => actions.onUndo(ids)},
            {id: 'trash-empty', name: 'Empty selected…', label: `Empty ${items}…`, group: 'Trash' as const, enabled: !busy, run: () => actions.onEmpty('')},
          ]
        : [],
    heading: `Selected: ${items} · ${formatBytes(chosen.reduce((sum, entry) => sum + entry.bytes, 0))}`,
  }
}

export function commandsFor(state: Page): Commands {
  const {selection, progress, on} = state
  const count = selection.selected.length
  const ticked = state.cleanup !== null && count > 0
  const items = plural(count, 'item', 'items')
  const cleanup = cleanupCommands(state, ticked)
  const trash = trashCommands(state)
  const deletes: Command[] = [
    {id: 'delete', name: 'Delete…', label: ticked ? `Delete ${items}…` : undefined, group: 'Clean up', hotkey: DELETE, enabled: state.deleteReady, run: () => on.confirm(false)},
    {id: 'delete-now', name: 'Delete immediately…', label: ticked ? `Delete ${items} immediately…` : undefined, group: 'Clean up', keywords: ['skip the Trash'], hotkey: state.deleteNow, enabled: state.deleteReady, run: () => on.confirm(true)},
  ]
  const selected = ticked ? [...deletes, ...cleanup.selected] : trash.selected
  const heading = ticked ? `Selected: ${items} · ${sizeOf(selection.exactBytes, selection.apparentBytes)}` : trash.heading
  return {
    selected: selected.length > 0 ? {heading, commands: selected} : null,
    commands: [
      ...state.tabs.map(tab => ({id: tab.id, name: `Go to ${tab.label}`, group: 'Go to' as const, enabled: true, run: () => on.tab(tab.id)})),
      ...cleanup.top,
      ...(state.storage ? [page('chart', 'Chart…', 'Filter and view', SHAPES.map(shape => ({id: `shape:${shape}`, name: SHAPE_LABEL[shape], group: 'Filter and view', checked: state.storage?.shape === shape, enabled: state.storage?.drawn === true, run: () => on.reshape(shape)})))] : []),
      ...(ticked ? [] : deletes),
      {id: 'rescan', name: 'Rescan', group: 'Clean up', enabled: !progress && !state.scanning, run: on.rescan},
      page('cleanup', 'Cleanup…', 'Clean up', [
        {id: 'details', name: 'Show details', group: 'Clean up', enabled: state.round, run: on.details},
        {id: 'movie', name: 'Watch the movie', group: 'Clean up', enabled: state.round && !state.reduced, run: on.movie},
        {id: 'undo-cleanup', name: 'Undo this cleanup', group: 'Clean up', enabled: state.cleanupTrash, run: on.undoCleanup},
        {id: 'empty-cleanup', name: 'Empty these from Trash…', group: 'Clean up', enabled: state.cleanupTrash, run: on.emptyCleanup},
      ]),
      ...trash.top,
      {id: 'shortcuts', name: 'Keyboard shortcuts', group: 'Help', hotkey: '?', enabled: true, run: on.shortcuts},
      {id: 'how-delete-works', name: 'How Delete works', group: 'Help', enabled: !progress, run: on.about},
    ],
  }
}
