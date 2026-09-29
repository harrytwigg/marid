// @vitest-environment node
import { EventEmitter } from 'node:events'
import type { ProxyOptions, UserConfig } from 'vite'
import { describe, expect, it } from 'vitest'
import viteConfig from '../../../vite.config'

// the dev proxy rewrites Host to the gateway (changeOrigin), so it
// must pass on the host the browser dialled or the gateway refuses every
// terminal socket as cross-origin. the same holds for /ws and a
// plugin's event socket under /api, which the gateway now origin-checks too.

function wsProxy(prefix: '/ws' | '/api' = '/ws'): ProxyOptions {
  const config = (typeof viteConfig === 'function'
    ? viteConfig({ command: 'serve', mode: 'development' })
    : viteConfig) as UserConfig
  return config.server!.proxy![prefix] as ProxyOptions
}

function forward(
  requestHeaders: Record<string, string>,
  alreadySet: Record<string, string> = {},
  { prefix = '/ws', event = 'proxyReqWs' }: { prefix?: '/ws' | '/api'; event?: 'proxyReqWs' | 'proxyReq' } = {},
) {
  const proxy = new EventEmitter()
  const options = wsProxy(prefix)
  options.configure!(proxy as never, options)
  const sent = new Map<string, string>(Object.entries(alreadySet))
  const proxyReq = {
    getHeader: (name: string) => sent.get(name.toLowerCase()),
    setHeader: (name: string, value: string) => { sent.set(name.toLowerCase(), value) },
  }
  proxy.emit(event, proxyReq, { headers: requestHeaders })
  return sent
}

describe('Vite dev /ws proxy', () => {
  it('rewrites Host and forwards the dialled host as X-Forwarded-Host', () => {
    expect(wsProxy()).toMatchObject({ ws: true, changeOrigin: true })
    expect(forward({ host: 'localhost:5173' }).get('x-forwarded-host')).toBe('localhost:5173')
  })

  it('keeps an X-Forwarded-Host an outer proxy already set', () => {
    expect(forward({ host: 'localhost:5173' }, { 'x-forwarded-host': 'jinn.example.com' }).get('x-forwarded-host')).toBe('jinn.example.com')
  })
})

describe('Vite dev /api proxy', () => {
  it("upgrades a plugin's event socket and forwards the dialled host on it", () => {
    expect(wsProxy('/api')).toMatchObject({ ws: true, changeOrigin: true })
    expect(forward({ host: 'localhost:5173' }, {}, { prefix: '/api' }).get('x-forwarded-host')).toBe('localhost:5173')
  })

  it('forwards nothing on a plain /api request, which keeps the loopback same-origin trust', () => {
    expect(forward({ host: 'localhost:5173' }, {}, { prefix: '/api', event: 'proxyReq' }).has('x-forwarded-host')).toBe(false)
  })
})
