import {execFileSync} from 'node:child_process'
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {chromium, type Browser, type Locator, type Page} from 'playwright'
import {createServer} from 'vite'

const GB = 1024 ** 3
const MB = 1024 ** 2
const HOME = '/Users/you'
const OUT = fileURLToPath(new URL('../../../.github/assets/', import.meta.url))
const DAY = 86_400
const NOW = 1_790_000_000

type Risk = 'safe' | 'review' | 'report'

function item(path: string, bytes: number, extra: Record<string, unknown> = {}) {
  return {path, label: path.replace(HOME, '~'), bytes, action: 'rm', cmd_id: '-', note: '', age: 30, accuracy: 'exact', preselect: true, report: false, ...extra}
}

function category(id: string, title: string, desc: string, risk: Risk, items: ReturnType<typeof item>[]) {
  return {id, title, desc, risk, items, bytes: items.reduce((sum, i) => sum + i.bytes, 0)}
}

const categories = [
  category('caches', 'Application caches', '~/Library/Caches — regenerated automatically by each app.', 'safe', [
    item(`${HOME}/Library/Caches/com.spotify.client`, 3.4 * GB, {age: 2}),
    item(`${HOME}/Library/Caches/Google`, 2.1 * GB, {age: 1}),
    item(`${HOME}/Library/Caches/com.microsoft.VSCode.ShipIt`, 0.9 * GB, {age: 64}),
    item(`${HOME}/Library/Caches/ms-playwright`, 1.6 * GB, {age: 41}),
    item(`${HOME}/Library/Caches/com.tinyspeck.slackmacgap`, 0.6 * GB, {age: 3}),
  ]),
  category('pkg-cache', 'Package manager caches', 'Download caches for npm, brew, pip, cargo, go and friends.', 'safe', [
    item(`${HOME}/.npm/_cacache`, 4.2 * GB, {age: 5}),
    item(`${HOME}/Library/Caches/Homebrew`, 2.7 * GB, {age: 12}),
    item(`${HOME}/.cargo/registry/cache`, 1.3 * GB, {age: 20}),
    item(`${HOME}/Library/Caches/pip`, 0.8 * GB, {age: 88}),
  ]),
  category('xcode', 'Xcode build data', 'Derived data, simulator caches and device support files.', 'safe', [
    item(`${HOME}/Library/Developer/Xcode/DerivedData/Storefront-bqhzlgxkfmnrue`, 6.8 * GB, {age: 9}),
    item(`${HOME}/Library/Developer/Xcode/DerivedData/Dashboard-cnwqvyeodxgtha`, 4.9 * GB, {age: 2}),
    item(`${HOME}/Library/Developer/Xcode/DerivedData/WeatherKitDemo-fjzmsvudqrkpli`, 3.2 * GB, {age: 77}),
    item(`${HOME}/Library/Developer/Xcode/DerivedData/Onboarding-dyhxqlbotrswme`, 2.4 * GB, {age: 160}),
    item(`${HOME}/Library/Developer/Xcode/DerivedData/ModuleCache.noindex`, 1.3 * GB, {age: 2}),
    item(`${HOME}/Library/Developer/Xcode/iOS DeviceSupport`, 7.9 * GB, {age: 140}),
    item(`${HOME}/Library/Developer/CoreSimulator/Caches`, 2.2 * GB, {age: 30}),
  ]),
  category('node-modules', 'node_modules', 'Every node_modules folder on this Mac, whatever its age. Each one is fully rebuildable from its lockfile.', 'safe', [
    item(`${HOME}/code/storefront/node_modules`, 1.9 * GB, {label: '~/code/storefront', age: 212, note: 'npm project, last installed 212 days ago. Restore with: npm install'}),
    item(`${HOME}/code/blog/node_modules`, 0.7 * GB, {label: '~/code/blog', age: 96, note: 'npm project, last installed 96 days ago. Restore with: npm install'}),
    item(`${HOME}/code/dashboard/node_modules`, 1.2 * GB, {label: '~/code/dashboard', age: 4, preselect: false, accuracy: 'estimate', note: 'pnpm project, last installed 4 days ago. Restore with: pnpm install'}),
  ]),
  category('worktrees', 'Git worktrees with no leftover work', 'Clean worktrees: no uncommitted, untracked or local-only ignored files, no process inside, nothing that exists only in the worktree. Only the folder goes; the branch and every commit stay. Every check is repeated right before removal.', 'safe', [
    item(`${HOME}/code/dashboard-wt/fix-login`, 2.3 * GB, {age: 38, preselect: false, note: 'Branch fix-login is kept, branch is pushed. Re-create with: git worktree add ~/code/dashboard-wt/fix-login fix-login'}),
    item(`${HOME}/code/dashboard-wt/charts-v2`, 1.8 * GB, {age: 3, preselect: false, note: 'Active 3.0 days ago. Branch charts-v2 is kept, 2 unpushed commits stay on the local branch. Re-create with: git worktree add ~/code/dashboard-wt/charts-v2 charts-v2'}),
  ]),
  category('docker', 'Docker', 'Dangling images, stopped containers and build cache.', 'review', [
    item('cmd:docker-prune', 9.4 * GB, {action: 'cmd', cmd_id: 'docker-prune', label: 'docker system prune -f', accuracy: 'vm', preselect: false, age: null}),
  ]),
  category('big-files', 'Large files (report only)', 'Single files over 1 GB. Listed so you can decide; never deleted from here.', 'report', [
    item(`${HOME}/Downloads/ubuntu-24.04-desktop-arm64.iso`, 5.8 * GB, {report: true, preselect: false, age: 300}),
    item(`${HOME}/Movies/conference-talk-raw.mov`, 3.1 * GB, {report: true, preselect: false, age: 180}),
  ]),
]

const reclaimable = categories.filter(c => c.risk !== 'report').reduce((sum, c) => sum + c.bytes, 0)

interface Folder {
  name: string
  path: string
  bytes: number
  files: number
  mtime: number
  children: Folder[]
}

function folder(path: string, bytes: number, children: Folder[] = [], files = Math.round(bytes / (2 * MB))): Folder {
  return {name: path === HOME ? '~' : path.split('/').at(-1) ?? path, path, bytes, files, mtime: NOW - 3 * DAY, children}
}

const tree = folder(HOME, 236 * GB, [
  folder(`${HOME}/Library`, 112 * GB, [
    folder(`${HOME}/Library/Developer`, 48 * GB, [
      folder(`${HOME}/Library/Developer/Xcode`, 31 * GB),
      folder(`${HOME}/Library/Developer/CoreSimulator`, 17 * GB),
    ]),
    folder(`${HOME}/Library/Caches`, 22 * GB),
    folder(`${HOME}/Library/Containers`, 19 * GB, [folder(`${HOME}/Library/Containers/com.docker.docker`, 14 * GB), folder(`${HOME}/Library/Containers/com.apple.mail`, 5 * GB)]),
    folder(`${HOME}/Library/Application Support`, 23 * GB, [folder(`${HOME}/Library/Application Support/Google`, 9 * GB), folder(`${HOME}/Library/Application Support/Slack`, 4 * GB), folder(`${HOME}/Library/Application Support/Code`, 3 * GB)]),
  ]),
  folder(`${HOME}/code`, 54 * GB, [
    folder(`${HOME}/code/dashboard`, 14 * GB),
    folder(`${HOME}/code/dashboard-wt`, 9 * GB),
    folder(`${HOME}/code/storefront`, 12 * GB),
    folder(`${HOME}/code/ml-experiments`, 11 * GB),
    folder(`${HOME}/code/blog`, 4 * GB),
  ]),
  folder(`${HOME}/Movies`, 26 * GB),
  folder(`${HOME}/Downloads`, 18 * GB),
  folder(`${HOME}/Pictures`, 14 * GB),
  folder(`${HOME}/.npm`, 5 * GB),
  folder(`${HOME}/.cargo`, 4 * GB),
  folder(`${HOME}/Documents`, 3 * GB),
])

const days = Array.from({length: 365}, (_, i) => {
  const day = new Date((NOW - (364 - i) * DAY) * 1000).toISOString().slice(0, 10)
  const weekday = new Date((NOW - (364 - i) * DAY) * 1000).getUTCDay()
  const wave = (weekday === 0 || weekday === 6 ? 0.2 : 0.6) + Math.abs(Math.sin(i / 11)) * 1.4 + ((i * 7919) % 17) / 12 + ((i * 31) % 23 === 0 ? 4 : 0)
  return {day, bytes: Math.round(wave * GB), files: Math.round(wave * 1800)}
})

const insights = {
  generated_at: NOW,
  modified_by_day: days,
  age_by_folder: {
    buckets: ['<1w', '<1m', '<6m', '<1y', 'older'],
    folders: [
      {path: '~/Library', bytes: [9, 14, 31, 22, 36].map(n => n * GB)},
      {path: '~/code', bytes: [6, 11, 17, 9, 11].map(n => n * GB)},
      {path: '~/Movies', bytes: [0, 1, 4, 6, 15].map(n => n * GB)},
      {path: '~/Downloads', bytes: [1, 2, 5, 4, 6].map(n => n * GB)},
      {path: '~/Pictures', bytes: [0.5, 1, 3, 4, 5.5].map(n => n * GB)},
    ],
  },
  by_kind: [
    {kind: 'video', bytes: 31 * GB, files: 214},
    {kind: 'code', bytes: 22 * GB, files: 412_000},
    {kind: 'archive', bytes: 17 * GB, files: 1_900},
    {kind: 'image', bytes: 14 * GB, files: 38_000},
    {kind: 'disk image', bytes: 12 * GB, files: 21},
    {kind: 'audio', bytes: 4 * GB, files: 2_600},
    {kind: 'document', bytes: 3 * GB, files: 5_400},
  ],
  largest_files: [
    {path: '~/Library/Containers/com.docker.docker/Data/vms/0/data/Docker.raw', bytes: 12.4 * GB, mtime: NOW - DAY},
    {path: '~/Downloads/ubuntu-24.04-desktop-arm64.iso', bytes: 5.8 * GB, mtime: NOW - 300 * DAY},
    {path: '~/Movies/conference-talk-raw.mov', bytes: 3.1 * GB, mtime: NOW - 180 * DAY},
    {path: '~/code/ml-experiments/checkpoints/model-final.safetensors', bytes: 2.6 * GB, mtime: NOW - 45 * DAY},
    {path: '~/Movies/trip-drone-4k.mp4', bytes: 1.9 * GB, mtime: NOW - 400 * DAY},
  ],
}

const RUN = 'run-20261004-161542-a2ad54a5'

const fixture = {
  data: {categories, reclaimable, free: 61 * GB, total: 994 * GB, used: 933 * GB, home: tree.bytes, snapshots: 0, tree, insights},
}

type Row = ReturnType<typeof item>

const sum = (rows: Row[]) => rows.reduce((total, row) => total + row.bytes, 0)
const recommended = categories.flatMap(c => c.items).filter(i => i.preselect && !i.report)
const nodeModules = categories.find(c => c.id === 'node-modules')?.items ?? []
const demoChosen = [...recommended, ...nodeModules.filter(i => !i.preselect)]

function planFor(chosen: Row[]) {
  return {paths: chosen.map(i => ({path: i.path, bytes: i.bytes, trashed: false})), paths_bytes: sum(chosen), final: [], final_bytes: 0, final_count: 0, rejected: [], count: chosen.length, bytes: sum(chosen)}
}

function cleanupEvents(chosen: Row[]) {
  const free = fixture.data.free
  const entries = chosen.map((file, i) => {
    const id = String(i + 1).padStart(16, '0')
    return {id, run: RUN, original: file.path, trashed: `${HOME}/.Trash/${file.path.split('/').at(-1)}`, bytes: file.bytes, at: NOW + i, dev: 1, ino: 100 + i, state: 'trashed', reason: ''}
  })
  const end = entries.length * 150
  return [
    {type: 'started', data: {run: RUN, free, paths: entries.length, trash: entries.length, worktrees: 0, commands: 0, bytes: sum(chosen), elapsed_ms: 0}},
    ...entries.map((e, i) => ({type: 'trashed', data: {path: e.original, bytes: e.bytes, id: e.id, trashed_path: e.trashed, elapsed_ms: (i + 1) * 150}})),
    {type: 'trash', data: {entries, elapsed_ms: end + 1}},
    {type: 'done', data: {removed: 0, removed_bytes: 0, trashed: entries.length, trashed_bytes: sum(chosen), free_before: free, free_after: free, elapsed_ms: end + 400}},
  ]
}

function scanEvents() {
  const {total, used, free, snapshots, home, tree, insights, reclaimable} = fixture.data
  const dirs = [`${HOME}/Library/Caches`, `${HOME}/Library/Developer/Xcode/DerivedData`, `${HOME}/code/storefront`, `${HOME}/code/dashboard`, `${HOME}/Movies`, `${HOME}/Library/Application Support`, `${HOME}/.npm`, `${HOME}/Downloads`]
  const listed = categories.flatMap(c => c.items.map(item => ({category: {id: c.id, title: c.title, desc: c.desc, risk: c.risk}, item})))
  return [
    {type: 'disk', data: {total, used, free, snapshots, elapsed_ms: 0}},
    {type: 'replayed', data: {elapsed_ms: 10}},
    ...Array.from({length: 24}, (_, i) => ({type: 'progress', data: {files: (i + 1) * 61_237, bytes: (i + 1) * 9.6 * GB, dir: dirs[i % dirs.length], elapsed_ms: 100 + i * 140}})),
    ...listed.map((row, i) => ({type: 'item', data: {...row, elapsed_ms: 400 + i * 120}})),
    {type: 'walked', data: {home, tree, insights, worktrees: 0, elapsed_ms: 3500}},
    {type: 'done', data: {reclaimable, elapsed_ms: 3700}},
  ]
}

type Stream = {type: string; data: {elapsed_ms: number}}[]

function openForever(streams: Stream[]) {
  let opened = 0
  window.EventSource = function fakeEventSource() {
    const events = streams[Math.min(opened++, streams.length - 1)] ?? []
    const source = Object.assign(new EventTarget(), {readyState: 1, close: () => (source.readyState = 2)})
    setTimeout(() => source.dispatchEvent(new Event('open')))
    for (const event of events) setTimeout(() => source.dispatchEvent(new MessageEvent(event.type, {data: JSON.stringify(event.data)})), 50 + event.data.elapsed_ms)
    return source
  } as unknown as typeof EventSource
}

async function mockServer(page: Page, chosen: Row[], streams: Stream[], embedded: object) {
  await page.addInitScript(openForever, streams)
  await page.route(
    url => url.pathname === '/' || url.pathname.startsWith('/cleanup') || url.pathname.startsWith('/storage') || url.pathname.startsWith('/insights'),
    async route => {
      const response = await route.fetch()
      const html = (await response.text())
        .replace('__TOKEN__', 'synthetic')
        .replace('__PLATFORM__', 'macos')
        .replace('__HOME__', HOME)
        .replace('__DATA__', JSON.stringify({...embedded, run: RUN, trash: []}))
      await route.fulfill({response, body: html})
    },
  )
  await page.route('**/preview', route => route.fulfill({json: planFor(chosen)}))
  await page.route('**/decide', route => route.fulfill({json: {}}))
}

async function shot(page: Page, name: string, around?: Locator) {
  await page.waitForTimeout(1500)
  const box = await around?.boundingBox()
  const clip = box ? {x: box.x - 40, y: box.y - 40, width: box.width + 80, height: box.height + 80} : undefined
  await page.screenshot({path: `${OUT}${name}.png`, clip})
  console.log(`${OUT}${name}.png`)
}

const BASE = 'http://localhost:5199'
const VIEWPORT = {viewport: {width: 1440, height: 900}, deviceScaleFactor: 2, colorScheme: 'dark' as const}

async function screenshots(browser: Browser) {
  const page = await browser.newPage(VIEWPORT)
  await mockServer(page, recommended, [cleanupEvents(recommended)], fixture.data)

  await page.setViewportSize({width: 1440, height: 960})
  await page.goto(`${BASE}/cleanup`)
  await page.getByRole('table').first().waitFor()
  await shot(page, 'cleanup')
  await page.setViewportSize({width: 1440, height: 900})

  await page.keyboard.press('ControlOrMeta+k')
  await page.getByRole('dialog').waitFor()
  await shot(page, 'palette')
  await page.keyboard.press('Escape')

  await page.setViewportSize({width: 1440, height: 1040})
  await page.goto(`${BASE}/storage`)
  await shot(page, 'storage')
  await page.setViewportSize({width: 1440, height: 900})

  await page.goto(`${BASE}/insights`)
  await shot(page, 'insights')

  await page.setViewportSize({width: 1680, height: 940})
  await page.goto(`${BASE}/cleanup`)
  await page.getByRole('table').first().waitFor()
  await page.getByRole('button', {name: /^Delete \d+ items/}).click()
  await page.getByRole('dialog').waitFor()
  await shot(page, 'confirm', page.getByRole('dialog'))

  await page.getByRole('dialog').getByRole('button', {name: /Move .* to the Trash/}).click()
  await page.setViewportSize({width: 1440, height: 960})
  await page.waitForTimeout(6000)
  await shot(page, 'finale')
  await page.close()
}

async function demo(browser: Browser) {
  const page = await browser.newPage(VIEWPORT)
  await mockServer(page, demoChosen, [scanEvents(), cleanupEvents(demoChosen)], {live: true})
  const frames = mkdtempSync(join(tmpdir(), 'disk-clean-demo-'))
  const stamps: {file: string; at: number}[] = []
  const cdp = await page.context().newCDPSession(page)
  cdp.on('Page.screencastFrame', ({data, metadata, sessionId}) => {
    const file = join(frames, `${String(stamps.length).padStart(5, '0')}.png`)
    writeFileSync(file, Buffer.from(data, 'base64'))
    stamps.push({file, at: metadata.timestamp ?? 0})
    void cdp.send('Page.screencastFrameAck', {sessionId})
  })
  await page.goto(`${BASE}/cleanup`)
  await page.getByText('Disk Clean').first().waitFor()
  await cdp.send('Page.startScreencast', {format: 'png', maxWidth: 1920, maxHeight: 1200})
  await page.waitForTimeout(3800)
  await page.getByRole('checkbox', {name: /node_modules/}).first().click()
  await page.waitForTimeout(1200)
  await page.keyboard.press('ControlOrMeta+k')
  await page.waitForTimeout(600)
  await page.keyboard.type('del', {delay: 120})
  await page.waitForTimeout(900)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(500)
  await page.getByRole('button', {name: /^Delete \d+ items/}).click()
  await page.waitForTimeout(1800)
  await page.getByRole('dialog').getByRole('button', {name: /Move .* to the Trash/}).click()
  await page.waitForTimeout(4500)
  await cdp.send('Page.stopScreencast')
  await page.close()

  const list = stamps.map((frame, i) => `file '${frame.file}'\nduration ${((stamps[i + 1]?.at ?? frame.at + 1) - frame.at).toFixed(4)}`)
  writeFileSync(join(frames, 'list.txt'), `${list.join('\n')}\nfile '${stamps.at(-1)?.file}'\n`)
  const palette = 'fps=15,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle'
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', join(frames, 'list.txt'), '-vf', palette, `${OUT}demo.gif`])
  rmSync(frames, {recursive: true})
  console.log(`${OUT}demo.gif`)
}

const server = await createServer({root: fileURLToPath(new URL('..', import.meta.url)), server: {port: 5199, strictPort: true}, logLevel: 'error'})
await server.listen()
const browser = await chromium.launch()
mkdirSync(OUT, {recursive: true})

try {
  if (!process.argv.includes('--gif-only')) await screenshots(browser)
  await demo(browser)
} finally {
  await browser.close()
  await server.close()
}
