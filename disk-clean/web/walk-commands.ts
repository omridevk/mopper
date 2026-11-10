import {spawn, type ChildProcess} from 'node:child_process'
import {existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import type {BrowserCommand} from 'vitest/node'

const CLI = fileURLToPath(new URL('../cli/target/', import.meta.url))
const FOLDERS = 400
const FILES = 500

interface Walk {
  child: ChildProcess
  sandbox: string
  walks: number
  stopped: boolean
}

const walks = new Map<string, Walk>()

function binary() {
  const found = ['release', 'debug'].map(kind => join(CLI, kind, 'disk-clean')).find(path => existsSync(path))
  if (!found) throw new Error('build the CLI first: cargo build --release in disk-clean/cli')
  return found
}

function fill(home: string) {
  for (let folder = 0; folder < FOLDERS; folder++) {
    const dir = join(home, 'code', `project-${folder}`, 'src')
    mkdirSync(dir, {recursive: true})
    for (let file = 0; file < FILES; file++) writeFileSync(join(dir, `f${file}.txt`), 'x')
  }
}

export const startWalk: BrowserCommand<[]> = ({sessionId}) => {
  const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'disk-clean-walk-')))
  const home = join(sandbox, 'home')
  const temp = join(sandbox, 'tmp')
  mkdirSync(temp, {recursive: true})
  fill(home)
  const env = {...process.env, HOME: home, TMPDIR: temp, DISK_CLEAN_SKIP_MAP: '1', GIT_CONFIG_GLOBAL: '/dev/null'}
  const scan = (walk: Walk) => {
    walk.walks += 1
    walk.child = spawn(binary(), ['scan', join(sandbox, `run-${walk.walks}`)], {env, stdio: 'ignore'})
    walk.child.on('exit', () => {
      if (!walk.stopped) scan(walk)
    })
  }
  const walk: Walk = {child: spawn('true'), sandbox, walks: 0, stopped: false}
  scan(walk)
  walks.set(sessionId, walk)
  return {files: FOLDERS * FILES}
}

export const stopWalk: BrowserCommand<[]> = ({sessionId}) => {
  const walk = walks.get(sessionId)
  walks.delete(sessionId)
  if (!walk) return {walks: 0}
  walk.stopped = true
  walk.child.kill()
  rmSync(walk.sandbox, {recursive: true, force: true})
  return {walks: walk.walks}
}
