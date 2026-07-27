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

    const detailedCallback = vi.fn()
    const detailedPoster = windowObject.$poster as {
      getAccountsV2Detailed(
        options: { platforms: string[]; forceRefresh: boolean },
        cb: typeof detailedCallback
      ): void
    }
    detailedPoster.getAccountsV2Detailed(
      { platforms: ['toutiao'], forceRefresh: true },
      detailedCallback,
    )

    const detailedRequest = postMessage.mock.calls.at(-1)?.[0] as {
      requestId: string
    }
    expect(detailedRequest).toMatchObject({
      namespace: 'vibemarket.syncer.bridge',
      apiVersion: '2.0',
      direction: 'PAGE_TO_EXTENSION',
      method: 'getAccountsV2Detailed',
      payload: { platforms: ['toutiao'], forceRefresh: true },
    })

    listeners[0]?.({
      source: windowObject,
      origin: location.origin,
      data: {
        namespace: 'vibemarket.syncer.bridge',
        apiVersion: '2.0',
        direction: 'EXTENSION_TO_PAGE',
        requestId: detailedRequest.requestId,
        method: 'getAccountsV2Detailed',
        ok: true,
        result: {
          accounts: [],
          probes: [
            {
              platform: 'toutiao',
              status: 'PROBE_FAILED',
              source: 'MAIN_WORLD',
              errorCode: 'PAGE_CONTEXT_UNAVAILABLE',
            },
          ],
        },
      },
    })
    expect(detailedCallback).toHaveBeenCalledWith(null, {
      accounts: [],
      probes: [
        {
          platform: 'toutiao',
          status: 'PROBE_FAILED',
          source: 'MAIN_WORLD',
          errorCode: 'PAGE_CONTEXT_UNAVAILABLE',
        },
      ],
    })
  })
})
