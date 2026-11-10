import {formatForDisplay, type FormatDisplayOptions, type Hotkey} from '@tanstack/react-hotkeys'
import {tilde, type Loaded, type Platform} from './data'
import {useDb} from './db'

interface PlatformText {
  trash: string
  restoreByHand: string
  putBack: string
  deleteNow: readonly [Hotkey, Hotkey]
  otherHint: string
  reserved: string
  reservedHint: string
  sharedBlocks: string
  path: (path: string) => string
  bin: (text: string) => string
  separator: string
  removeForGood: (path: string, home: string) => string
  typed: (text: string) => string
}

const WINDOWS_PATH = /^(?:~|[A-Z]:)(?:\/|$)/

const asIs = (path: string) => path

const windowsPath = (path: string) => (WINDOWS_PATH.test(path) ? path.replaceAll('/', '\\') : path)

const recycleBin = (text: string) => text.replace(/\b(to|from) Trash\b/g, '$1 the Recycle Bin').replace(/\bTrash\b/g, 'Recycle Bin')

const rmRf = (path: string, home: string) => `rm -rf -- ${tilde(path, home)}`

const removeItem = (path: string) => `Remove-Item -LiteralPath '${windowsPath(path).replaceAll("'", "''")}' -Recurse -Force`

const DRIVE_ROOT = /^[A-Z]:\/$/

export const isDiskRoot = (path: string) => path === '/' || DRIVE_ROOT.test(path)

const TEXT: Record<Platform, PlatformText> = {
  macos: {
    trash: 'the macOS Trash',
    restoreByHand: "Finder's Put Back",
    putBack: 'Put back in Finder',
    deleteNow: ['Mod+Alt+Backspace', 'Shift+Backspace'],
    otherHint: '/Applications, other users, /usr/local, system-wide caches',
    reserved: 'macOS system volume and APFS reserve',
    reservedHint: 'sealed system, Preboot, Recovery, swap and snapshots; not user-deletable',
    sharedBlocks: 'APFS clones and snapshots share blocks.',
    path: asIs,
    bin: asIs,
    separator: '/',
    removeForGood: rmRf,
    typed: asIs,
  },
  linux: {
    trash: 'the Trash',
    restoreByHand: "your file manager's Restore",
    putBack: 'Restored in the file manager',
    deleteNow: ['Shift+Backspace', 'Shift+Delete'],
    otherHint: '/usr, /var, other users, system-wide caches',
    reserved: 'System and reserved space',
    reservedHint: 'blocks the filesystem keeps for itself and for root; not user-deletable',
    sharedBlocks: 'hard links and reflinked copies share blocks.',
    path: asIs,
    bin: asIs,
    separator: '/',
    removeForGood: rmRf,
    typed: asIs,
  },
  windows: {
    trash: 'the Recycle Bin',
    restoreByHand: 'Restore in the Recycle Bin',
    putBack: 'Restored from the Recycle Bin',
    deleteNow: ['Shift+Delete', 'Shift+Backspace'],
    otherHint: 'Program Files, Windows, other users, system-wide caches',
    reserved: 'Windows and reserved space',
    reservedHint: 'system files, page file, hibernation file and restore points; need administrator',
    sharedBlocks: 'hard links share blocks.',
    path: windowsPath,
    bin: recycleBin,
    separator: '\\',
    removeForGood: removeItem,
    typed: text => text.replaceAll('\\', '/'),
  },
}

const KEYS = {
  macos: {platform: 'mac', separatorToken: ''},
  linux: {platform: 'linux'},
  windows: {platform: 'windows'},
} as const satisfies Record<Platform, FormatDisplayOptions>

const platformIn = (loaded: Loaded) => loaded.platform ?? 'macos'

export const textIn = (platform: Platform | undefined) => TEXT[platform ?? 'macos']

export const hotkeyPlatform = (loaded: Loaded) => KEYS[platformIn(loaded)].platform

export function usePlatform() {
  const platform = platformIn(useDb().loaded)
  return {...TEXT[platform], label: (hotkey: Hotkey) => formatForDisplay(hotkey, KEYS[platform])}
}
