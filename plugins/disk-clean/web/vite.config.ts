import {fileURLToPath} from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import {tanstackRouter} from '@tanstack/router-plugin/vite'
import react from '@vitejs/plugin-react'
import {playwright} from '@vitest/browser-playwright'
import {defineConfig} from 'vitest/config'
import {viteSingleFile} from 'vite-plugin-singlefile'
import {startWalk, stopWalk} from './walk-commands'

const review = process.env.DISK_CLEAN_REVIEW_URL
const slow = process.env.DISK_CLEAN_SLOW === '1'
const SOFTWARE_GL = {'webgl.forbid-hardware': true, 'gfx.webrender.software': true}
const ci = Boolean(process.env.CI)
const launchOptions = {
  args: [...(slow ? ['--disable-gpu'] : []), ...(ci ? ['--disable-webgl', '--disable-webgl2'] : [])],
  firefoxUserPrefs: {...(slow ? SOFTWARE_GL : {}), ...(ci ? {'webgl.disabled': true} : {})},
}
const browsers = (contextOptions = {}) => playwright({launchOptions, contextOptions})
const retina = browsers({deviceScaleFactor: 2})
const reduced = browsers({reducedMotion: 'reduce'})
const softwareGl = playwright({launchOptions: {firefoxUserPrefs: SOFTWARE_GL}, contextOptions: {deviceScaleFactor: 2}})
const VIEWPORT = {width: 1440, height: 960}
const CHROMIUM = {browser: 'chromium' as const, viewport: VIEWPORT}
const FIREFOX = {browser: 'firefox' as const, viewport: VIEWPORT}
const FILM = ['src/film.test.tsx']
const REALTIME = ['src/realtime.test.tsx']
const SOFTWARE_GL_TESTS = ['src/software-gl.test.tsx']
const ROUTER = ['src/router.test.tsx']
const TRASH = ['src/trash.test.tsx']
const SCANNING = ['src/scanning.test.tsx', 'src/growing.test.tsx']
const WORDS = ['src/words.test.tsx', 'src/selection.test.tsx', 'src/empty.test.tsx', 'src/stability.test.tsx']
const URLS = ['src/url-privacy.test.tsx']
const TOOLTIPS = ['src/chart-tooltips.test.tsx']
const COMMANDS = ['src/commands.test.tsx']

interface Instance {
  browser: 'chromium' | 'firefox'
  viewport: {width: number; height: number}
  name?: string
  include?: string[]
  exclude?: string[]
  provider?: typeof retina
}

function inBrowsers(project: string, instances: Instance[]) {
  return {
    enabled: true,
    commands: {startWalk, stopWalk},
    headless: true,
    provider: browsers(),
    instances: instances.map(instance => ({...instance, name: `${project} ${instance.name ?? instance.browser}`})),
  }
}

export default defineConfig({
  plugins: [tanstackRouter({target: 'react'}), react(), tailwindcss(), viteSingleFile()],
  resolve: {alias: {'@': fileURLToPath(new URL('./src', import.meta.url))}},
  server: {proxy: review ? {'/preview': review, '/decide': review, '/events': review, '/undo': review, '/empty': review} : undefined},
  optimizeDeps: {
    include: [
      '@base-ui/react/popover',
      '@base-ui/react/tooltip',
      'gsap',
      'gsap/CustomEase',
      'gsap/DrawSVGPlugin',
      'gsap/Flip',
      'gsap/SplitText',
      '@gsap/react',
      '@tanstack/db',
      '@tanstack/react-db',
      '@tanstack/react-store',
      '@tanstack/react-router',
      '@tanstack/react-table',
      '@tanstack/react-virtual',
      'cmdk',
    ],
  },
  build: {outDir: '../cli/assets', emptyOutDir: false},
  test: {
    fileParallelism: false,
    projects: [
      {
        extends: true,
        test: {
          name: 'app',
          include: ['src/**/*.test.tsx'],
          exclude: ['src/perf.test.tsx', 'src/frames.test.tsx', ...REALTIME],
          setupFiles: ['src/test/slow-cpu.ts'],
          provide: {cpuSlowdown: slow ? 4 : 1},
          browser: inBrowsers('app', [
            {...CHROMIUM, exclude: ['src/perf.test.tsx', 'src/frames.test.tsx', ...REALTIME, ...SOFTWARE_GL_TESTS]},
            {...FIREFOX, include: [...FILM, ...ROUTER, ...TRASH, ...SCANNING, ...WORDS, ...URLS, ...TOOLTIPS, ...COMMANDS], provider: retina},
            {...CHROMIUM, name: 'chromium reduced', include: TOOLTIPS, provider: reduced},
            {...FIREFOX, name: 'firefox reduced', include: TOOLTIPS, provider: reduced},
            {browser: 'chromium', name: 'chromium-retina', viewport: {width: 1280, height: 900}, include: FILM, provider: retina},
            {...FIREFOX, name: 'firefox software-gl', include: SOFTWARE_GL_TESTS, provider: softwareGl},
          ]),
        },
      },
      {
        extends: true,
        test: {
          name: 'realtime',
          include: REALTIME,
          browser: inBrowsers('realtime', [
            CHROMIUM,
            {...FIREFOX, provider: retina},
            {browser: 'chromium', name: 'chromium-retina', viewport: {width: 1280, height: 900}, provider: retina},
          ]),
        },
      },
      {
        extends: true,
        mode: 'production',
        define: {'process.env.NODE_ENV': JSON.stringify('production')},
        cacheDir: 'node_modules/.vite-perf',
        server: {headers: {'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp'}},
        resolve: {alias: [{find: /^react-dom\/client$/, replacement: 'react-dom/profiling'}]},
        oxc: {jsx: {runtime: 'automatic', development: false}},
        test: {name: 'perf', include: ['src/perf.test.tsx'], browser: inBrowsers('perf', [CHROMIUM, FIREFOX])},
      },
      {
        extends: true,
        mode: 'production',
        define: {'process.env.NODE_ENV': JSON.stringify('production')},
        cacheDir: 'node_modules/.vite-frames',
        oxc: {jsx: {runtime: 'automatic', development: false}},
        test: {
          name: 'frames',
          include: ['src/frames.test.tsx'],
          browser: inBrowsers('frames', [
            CHROMIUM,
            FIREFOX,
            {...CHROMIUM, name: 'chromium reduced', provider: reduced},
            {...FIREFOX, name: 'firefox reduced', provider: reduced},
          ]),
        },
      },
    ],
  },
})
