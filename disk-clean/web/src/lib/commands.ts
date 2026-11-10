import type {Hotkey, UseHotkeyDefinition} from '@tanstack/react-hotkeys'

export const GROUPS = ['Go to', 'Filter and view', 'Select', 'Clean up', 'Trash', 'Help'] as const

export type Group = (typeof GROUPS)[number]

interface Entry {
  id: string
  name: string
  label?: string
  group: Group
  keywords?: readonly string[]
  hotkey?: Hotkey | readonly Hotkey[]
  checked?: boolean
  enabled: boolean
  scoped?: true
}

export type Command = Entry & ({run: () => void; children?: never} | {children: readonly Command[]; run?: never})

export interface Commands {
  selected: {heading: string; commands: readonly Command[]} | null
  commands: readonly Command[]
}

export const page = (id: string, name: string, group: Group, children: readonly Command[]): Command => ({id, name, group, enabled: children.some(child => child.enabled), children})

export const leavesOf = (commands: readonly Command[]): Command[] => commands.flatMap(command => (command.children ? leavesOf(command.children) : [command]))

export const everyCommand = ({selected, commands}: Commands) => leavesOf([...(selected?.commands ?? []), ...commands])

const LAYER = '[role="dialog"], [role="alertdialog"], [role="listbox"], [role="menu"]'

const layerOpen = () => document.querySelector('[aria-expanded="true"]') !== null || [...document.querySelectorAll(LAYER)].some(layer => layer.checkVisibility())

export const inOverlay = (event: KeyboardEvent) => layerOpen() || (event.target instanceof Element && event.target.closest(LAYER) !== null)

export const hotkeysOf = (command: Command): readonly Hotkey[] => (command.hotkey === undefined ? [] : [command.hotkey].flat())

export const HOTKEY_OPTIONS = {preventDefault: false, stopPropagation: false, ignoreInputs: true}

export function bindingsOf(commands: readonly Command[]): UseHotkeyDefinition[] {
  return commands.flatMap(command =>
    hotkeysOf(command).map(hotkey => ({
      hotkey,
      callback: (event: KeyboardEvent) => {
        if (inOverlay(event)) return
        event.preventDefault()
        command.run?.()
      },
      options: {enabled: command.enabled},
    })),
  )
}
