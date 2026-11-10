import {inject} from 'vitest'
import {cdp, server} from 'vitest/browser'

declare module 'vitest' {
  export interface ProvidedContext {
    cpuSlowdown: number
  }
}

const rate = inject('cpuSlowdown')
if (rate > 1 && server.browser === 'chromium') await cdp().send('Emulation.setCPUThrottlingRate', {rate})
