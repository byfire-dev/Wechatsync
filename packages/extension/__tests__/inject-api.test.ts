import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

const injectApiSource = readFileSync(new URL('../public/inject-api.js', import.meta.url), 'utf8')

describe('injected Bridge v2 API', () => {
  it('exposes openPublicationDraft with the caller-bound request ID', () => {
    const listeners: Array<(event: unknown) => void> = []
    const postMessage = vi.fn()
    const windowObject: Record<string, unknown> = {
      postMessage,
      addEventListener: vi.fn((_name: string, listener: (event: unknown) => void) => {
        listeners.push(listener)
      }),
    }
    const location = {
      hostname: 'localhost',
      origin: 'http://localhost',
    }

    runInNewContext(injectApiSource, {
      console: { log: vi.fn() },
      JSON,
      location,
      Math,
      Date,
      window: windowObject,
    })

    const request = {
      requestId: 'open-weixin-001',
      platform: 'weixin',
      externalAccountId: 'gh_account',
      platformPostId: '9001',
    }
    const callback = vi.fn()
    const poster = windowObject.$poster as {
      openPublicationDraft(value: typeof request, cb: typeof callback): void
    }
    poster.openPublicationDraft(request, callback)

    expect(postMessage).toHaveBeenCalledWith(
      {
        namespace: 'vibemarket.syncer.bridge',
        apiVersion: '2.0',
        direction: 'PAGE_TO_EXTENSION',
        requestId: request.requestId,
        method: 'openPublicationDraft',
        payload: request,
      },
      location.origin
    )

    listeners[0]?.({
      source: windowObject,
      origin: location.origin,
      data: {
        namespace: 'vibemarket.syncer.bridge',
        apiVersion: '2.0',
        direction: 'EXTENSION_TO_PAGE',
        requestId: request.requestId,
        method: 'openPublicationDraft',
        ok: true,
        result: { opened: true },
      },
    })

    expect(callback).toHaveBeenCalledWith(null, { opened: true })
  })
})
