import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

const injectApiSource = readFileSync(new URL('../public/inject-api.js', import.meta.url), 'utf8')

function createInjectedApiHarness() {
  const listeners: Array<(event: unknown) => void> = []
  const postMessage = vi.fn()
  const timeoutCallbacks = new Map<number, () => void>()
  let nextTimeoutId = 1
  const setTimeoutMock = vi.fn((callback: () => void, _timeoutMs: number) => {
    const timeoutId = nextTimeoutId
    nextTimeoutId += 1
    timeoutCallbacks.set(timeoutId, callback)
    return timeoutId
  })
  const clearTimeoutMock = vi.fn((timeoutId: number) => {
    timeoutCallbacks.delete(timeoutId)
  })
  const windowObject: Record<string, unknown> = {
    postMessage,
    addEventListener: vi.fn(
      (_name: string, listener: (event: unknown) => void) => {
        listeners.push(listener)
      },
    ),
  }
  const location = {
    hostname: 'localhost',
    origin: 'http://localhost',
  }

  runInNewContext(injectApiSource, {
    clearTimeout: clearTimeoutMock,
    console: { log: vi.fn() },
    JSON,
    location,
    Math,
    Date,
    Object,
    setTimeout: setTimeoutMock,
    window: windowObject,
  })

  return {
    clearTimeoutMock,
    listeners,
    location,
    postMessage,
    setTimeoutMock,
    timeoutCallbacks,
    windowObject,
  }
}

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

describe('injected publication Bridge v3 API', () => {
  it('exposes distinct v3 info and inspection methods without consuming v2 responses', () => {
    const {
      clearTimeoutMock,
      listeners,
      location,
      postMessage,
      windowObject,
    } = createInjectedApiHarness()

    const request = {
      contractVersion: '3.0',
      requestId: 'inspect-v3-001',
      platform: 'zhihu',
      externalAccountId: 'zhihu-user-1',
      draft: {
        platformPostId: '123456789',
        draftedAt: '2026-07-29T08:00:00.000Z',
      },
      articleHint: { title: 'Bridge v3 article' },
      limit: 20,
    }
    const callback = vi.fn()
    const poster = windowObject.$poster as {
      getPublicationBridgeInfoV3(cb: typeof callback): void
      inspectPublicationV3(value: typeof request, cb: typeof callback): void
      inspectPublication(value: typeof request, cb: typeof callback): void
    }

    poster.getPublicationBridgeInfoV3(callback)
    expect(postMessage.mock.calls.at(-1)?.[0]).toMatchObject({
      namespace: 'vibemarket.syncer.bridge',
      apiVersion: '3.0',
      direction: 'PAGE_TO_EXTENSION',
      method: 'getPublicationBridgeInfoV3',
      payload: {},
    })

    poster.inspectPublicationV3(request, callback)
    expect(postMessage.mock.calls.at(-1)?.[0]).toEqual({
      namespace: 'vibemarket.syncer.bridge',
      apiVersion: '3.0',
      direction: 'PAGE_TO_EXTENSION',
      requestId: request.requestId,
      method: 'inspectPublicationV3',
      payload: request,
    })

    const v2Callback = vi.fn()
    poster.inspectPublication(request, v2Callback)

    listeners[0]?.({
      source: windowObject,
      origin: location.origin,
      data: {
        namespace: 'vibemarket.syncer.bridge',
        apiVersion: '2.0',
        direction: 'EXTENSION_TO_PAGE',
        requestId: request.requestId,
        method: 'inspectPublicationV3',
        ok: true,
        result: { shouldNotBeAccepted: true },
      },
    })
    expect(callback).not.toHaveBeenCalled()
    expect(v2Callback).not.toHaveBeenCalled()

    const result = {
      contractVersion: '3.0',
      requestId: request.requestId,
      platform: 'zhihu',
      externalAccountId: 'zhihu-user-1',
      adapterVersion: '2.0.27',
      ok: false,
      failure: {
        stage: 'TIMEOUT',
        code: 'PUBLICATION_INSPECTION_TIMEOUT',
        retryable: true,
        message: 'The publication inspection timed out.',
      },
    }
    listeners[0]?.({
      source: windowObject,
      origin: location.origin,
      data: {
        namespace: 'vibemarket.syncer.bridge',
        apiVersion: '3.0',
        direction: 'EXTENSION_TO_PAGE',
        requestId: request.requestId,
        method: 'inspectPublicationV3',
        ok: true,
        result,
      },
    })
    expect(callback).toHaveBeenCalledWith(null, result)
    expect(clearTimeoutMock).toHaveBeenCalledTimes(1)
    expect(v2Callback).not.toHaveBeenCalled()

    listeners[0]?.({
      source: windowObject,
      origin: location.origin,
      data: {
        namespace: 'vibemarket.syncer.bridge',
        apiVersion: '2.0',
        direction: 'EXTENSION_TO_PAGE',
        requestId: request.requestId,
        method: 'inspectPublication',
        ok: true,
        result: [],
      },
    })
    expect(v2Callback).toHaveBeenCalledWith(null, [])
  })

  it('normalizes v3 request IDs and rejects blank IDs without posting', () => {
    const { postMessage, windowObject } = createInjectedApiHarness()
    const poster = windowObject.$poster as {
      inspectPublicationV3(
        request: { requestId: string; platform: string },
        cb: (error?: unknown) => void,
      ): void
    }

    const normalizedCallback = vi.fn()
    poster.inspectPublicationV3(
      { requestId: '  inspect-v3-normalized  ', platform: 'zhihu' },
      normalizedCallback,
    )
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        apiVersion: '3.0',
        requestId: 'inspect-v3-normalized',
        payload: {
          requestId: 'inspect-v3-normalized',
          platform: 'zhihu',
        },
      }),
      'http://localhost',
    )

    const callsBeforeBlankId = postMessage.mock.calls.length
    const invalidCallback = vi.fn()
    poster.inspectPublicationV3(
      { requestId: '   ', platform: 'zhihu' },
      invalidCallback,
    )
    expect(invalidCallback).toHaveBeenCalledWith({
      code: 'INVALID_REQUEST_ID',
      message: 'Publication Bridge requestId must be a non-empty string.',
    })
    expect(postMessage).toHaveBeenCalledTimes(callsBeforeBlankId)
  })

  it('rejects a duplicate pending v3 request ID without replacing the first callback', () => {
    const { listeners, location, postMessage, windowObject } =
      createInjectedApiHarness()
    const poster = windowObject.$poster as {
      inspectPublicationV3(
        request: { requestId: string; platform: string },
        cb: (error: unknown, result?: unknown) => void,
      ): void
    }
    const request = { requestId: 'inspect-v3-duplicate', platform: 'zhihu' }
    const firstCallback = vi.fn()
    const duplicateCallback = vi.fn()

    poster.inspectPublicationV3(request, firstCallback)
    poster.inspectPublicationV3(request, duplicateCallback)

    expect(postMessage).toHaveBeenCalledTimes(1)
    expect(duplicateCallback).toHaveBeenCalledWith({
      code: 'DUPLICATE_REQUEST_ID',
      message: 'A Publication Bridge request with this requestId is pending.',
    })

    listeners[0]?.({
      source: windowObject,
      origin: location.origin,
      data: {
        namespace: 'vibemarket.syncer.bridge',
        apiVersion: '3.0',
        direction: 'EXTENSION_TO_PAGE',
        requestId: request.requestId,
        method: 'inspectPublicationV3',
        ok: true,
        result: { ok: true },
      },
    })
    expect(firstCallback).toHaveBeenCalledWith(null, { ok: true })
  })

  it('times out and removes a pending v3 callback', () => {
    const {
      listeners,
      location,
      postMessage,
      setTimeoutMock,
      timeoutCallbacks,
      windowObject,
    } = createInjectedApiHarness()
    const poster = windowObject.$poster as {
      inspectPublicationV3(
        request: { requestId: string; platform: string },
        cb: (error: unknown, result?: unknown) => void,
      ): void
    }
    const request = { requestId: 'inspect-v3-timeout', platform: 'zhihu' }
    const callback = vi.fn()

    poster.inspectPublicationV3(request, callback)
    expect(setTimeoutMock).toHaveBeenCalledWith(expect.any(Function), 15000)
    const timeoutCallback = [...timeoutCallbacks.values()][0]
    timeoutCallback?.()
    expect(callback).toHaveBeenCalledWith({
      code: 'BRIDGE_REQUEST_TIMEOUT',
      message: 'The Publication Bridge request timed out.',
    })

    listeners[0]?.({
      source: windowObject,
      origin: location.origin,
      data: {
        namespace: 'vibemarket.syncer.bridge',
        apiVersion: '3.0',
        direction: 'EXTENSION_TO_PAGE',
        requestId: request.requestId,
        method: 'inspectPublicationV3',
        ok: true,
        result: { tooLate: true },
      },
    })
    expect(callback).toHaveBeenCalledTimes(1)

    poster.inspectPublicationV3(request, vi.fn())
    expect(postMessage).toHaveBeenCalledTimes(2)
  })
})
