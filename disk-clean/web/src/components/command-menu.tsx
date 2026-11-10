import {useHotkeys} from '@tanstack/react-hotkeys'
import {useRef, useState} from 'react'
import {Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandShortcut} from '@/components/ui/command'
import {Dialog, DialogContent, DialogHeader, DialogTitle} from '@/components/ui/dialog'
import {Kbd} from '@/components/ui/kbd'
import {everyCommand, GROUPS, hotkeysOf, inOverlay, type Command as Action, type Commands} from '@/lib/commands'
import {usePlatform} from '@/lib/platform'

const PALETTE: Action = {id: 'palette', name: 'Command palette', group: 'Help', hotkey: 'Mod+K', enabled: true, run: () => {}}

const shown = (commands: readonly Action[]) => commands.filter(command => command.enabled && !command.scoped)

const crumb = (command: Action) => command.name.replace(/…$/, '')

interface Found {
  command: Action
  path: readonly string[]
}

function foundIn(commands: readonly Action[], path: readonly string[] = []): Found[] {
  return shown(commands).flatMap(command => [{command, path}, ...(command.children ? foundIn(command.children, [...path, crumb(command)]) : [])])
}

function pagesAt(commands: readonly Action[], path: readonly string[]): Action[] {
  const [id, ...rest] = path
  const opened = shown(commands).find(command => command.id === id)
  return opened?.children ? [opened, ...pagesAt(opened.children, rest)] : []
}

function PaletteItem({command, path = [], onRun}: {command: Action; path?: readonly string[]; onRun: (command: Action) => void}) {
  const {label, bin} = usePlatform()
  const [hotkey] = hotkeysOf(command)
  const text = bin([...path, command.label ?? command.name].join(' › '))
  return (
    <CommandItem value={command.id} keywords={[text, command.name, ...(command.keywords ?? [])]} data-checked={command.checked} onSelect={() => onRun(command)}>
      {text}
      {hotkey && <CommandShortcut>{label(hotkey)}</CommandShortcut>}
    </CommandItem>
  )
}

function TopPage({commands, onRun}: {commands: Commands; onRun: (command: Action) => void}) {
  const {bin} = usePlatform()
  const top = shown(commands.commands)
  const selected = shown(commands.selected?.commands ?? [])
  const item = (command: Action) => <PaletteItem key={command.id} command={command} onRun={onRun} />
  return (
    <>
      {commands.selected && selected.length > 0 && <CommandGroup heading={commands.selected.heading}>{selected.map(item)}</CommandGroup>}
      {GROUPS.map(group => {
        const inGroup = top.filter(command => command.group === group)
        return (
          inGroup.length > 0 && (
            <CommandGroup key={group} heading={bin(group)}>
              {inGroup.map(item)}
            </CommandGroup>
          )
        )
      })}
    </>
  )
}

function Palette({commands, path, onPath, onRun}: {commands: Commands; path: readonly string[]; onPath: (path: readonly string[]) => void; onRun: (command: Action) => void}) {
  const [search, setSearch] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const pages = pagesAt(commands.commands, path)
  const current = pages.at(-1)
  const opened = pages.map(page => page.id)
  const choose = (command: Action) => {
    if (!command.children) return onRun(command)
    setSearch('')
    onPath([...opened, command.id])
    input.current?.focus()
  }
  const found = () => [...foundIn(commands.selected?.commands ?? []), ...foundIn(commands.commands)].map(({command, path: within}) => <PaletteItem key={command.id} command={command} path={within} onRun={choose} />)
  return (
    <Command>
      {current && <p className="px-3 pt-2 text-xs text-muted-foreground">{pages.map(crumb).join(' › ')}</p>}
      <CommandInput
        ref={input}
        value={search}
        onValueChange={setSearch}
        onKeyDown={event => {
          if (event.key !== 'Backspace' || search !== '' || !current) return
          event.preventDefault()
          onPath(opened.slice(0, -1))
        }}
        placeholder="Type a command…"
        aria-label="Command"
      />
      <CommandList>
        <CommandEmpty>No matching command.</CommandEmpty>
        {current && shown(current.children ?? []).map(command => <PaletteItem key={command.id} command={command} onRun={choose} />)}
        {!current && (search ? found() : <TopPage commands={commands} onRun={choose} />)}
      </CommandList>
    </Command>
  )
}

function ShortcutList({commands}: {commands: Commands}) {
  const {label, bin} = usePlatform()
  const keyed = [PALETTE, ...everyCommand(commands)].filter(command => command.hotkey !== undefined)
  return (
    <div className="flex flex-col gap-4">
      {GROUPS.map(group => {
        const rows = keyed.filter(command => command.group === group)
        if (rows.length === 0) return null
        return (
          <section key={group} className="flex flex-col gap-1.5">
            <h3 className="text-[11px] font-medium tracking-wider text-muted-foreground/70 uppercase">{bin(group)}</h3>
            <ul className="flex flex-col gap-1">
              {rows.map(row => (
                <li key={row.id} className="flex items-center gap-2">
                  <span className="grow">{bin(row.name)}</span>
                  {hotkeysOf(row).map(hotkey => (
                    <Kbd key={hotkey}>{label(hotkey)}</Kbd>
                  ))}
                </li>
              ))}
            </ul>
          </section>
        )
      })}
    </div>
  )
}

export function CommandMenu({commands, shortcuts, onShortcuts}: {commands: Commands; shortcuts: boolean; onShortcuts: (open: boolean) => void}) {
  const [palette, setPalette] = useState(false)
  const [path, setPath] = useState<readonly string[]>([])
  const [next, setNext] = useState<Action | null>(null)
  useHotkeys(
    [
      {
        hotkey: 'Mod+K',
        callback: event => {
          if (!palette && inOverlay(event)) return
          event.preventDefault()
          setPath([])
          setPalette(!palette)
        },
      },
    ],
    {preventDefault: false, stopPropagation: false, ignoreInputs: false},
  )
  const ran = (open: boolean) => {
    if (open || !next) return
    setNext(null)
    next.run?.()
  }
  return (
    <>
      <CommandDialog
        title="Command palette"
        description="Search for an action to run"
        open={palette}
        onOpenChange={(open, details) => {
          if (open || details.reason !== 'escape-key' || path.length === 0) return setPalette(open)
          details.cancel()
          setPath(path.slice(0, -1))
        }}
        onOpenChangeComplete={ran}
      >
        <Palette
          commands={commands}
          path={path}
          onPath={setPath}
          onRun={command => {
            setNext(command)
            setPalette(false)
          }}
        />
      </CommandDialog>
      <Dialog open={shortcuts} onOpenChange={onShortcuts}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Keyboard shortcuts</DialogTitle>
          </DialogHeader>
          <ShortcutList commands={commands} />
        </DialogContent>
      </Dialog>
    </>
  )
}
