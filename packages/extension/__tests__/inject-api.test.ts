import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import {
  publicationBridgeV3IdempotencyConflictResponseFixture,
  publicationBridgeV3NegotiationRequestFixture,
  publicationBridgeV3NegotiationResponseFixture,
  publicationBridgeV3PublishRequestFixture,
  publicationBridgeV31InspectRequestFixture,
  publicationBridgeV32InspectRequestFixture,
} from '@byfire-dev/publication-bridge-contract/v3/testing'
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
  it('exposes one raw v3 call on both aliases and returns the full envelope', () => {
    const {
      clearTimeoutMock,
      listeners,
      location,
      postMessage,
      windowObject,
    } = createInjectedApiHarness()
    const callback = vi.fn()
    const poster = windowObject.$poster as {
      callPublicationBridgeV3(
        request: typeof publicationBridgeV3NegotiationRequestFixture,
        cb: typeof callback
      ): void
    }
    expect(windowObject.$syncer).toBe(windowObject.$poster)

    poster.callPublicationBridgeV3(
      publicationBridgeV3NegotiationRequestFixture,
      callback,
    )
    expect(postMessage).toHaveBeenCalledWith(
      publicationBridgeV3NegotiationRequestFixture,
      location.origin,
    )

    listeners[0]?.({
      source: windowObject,
      origin: location.origin,
      data: publicationBridgeV3NegotiationResponseFixture,
    })
    expect(callback).toHaveBeenCalledWith(
      null,
      publicationBridgeV3NegotiationResponseFixture,
    )
    expect(clearTimeoutMock).toHaveBeenCalledTimes(1)
  })

  it('returns a contract-level ok:false response as a successful transport exchange', () => {
    const { listeners, location, windowObject } = createInjectedApiHarness()
    const poster = windowObject.$poster as {
      callPublicationBridgeV3(
        request: Record<string, unknown>,
        cb: (error: unknown, response?: unknown) => void
      ): void
    }
    const request = {
      ...publicationBridgeV3PublishRequestFixture,
      requestId:
        publicationBridgeV3IdempotencyConflictResponseFixture.requestId,
      operationId:
        publicationBridgeV3IdempotencyConflictResponseFixture.operationId,
    }
    const callback = vi.fn()

    poster.callPublicationBridgeV3(request, callback)
    listeners[0]?.({
      source: windowObject,
      origin: location.origin,
      data: publicationBridgeV3IdempotencyConflictResponseFixture,
    })

    expect(callback).toHaveBeenCalledWith(
      null,
      publicationBridgeV3IdempotencyConflictResponseFixture,
    )
  })

  it('returns a relay transport failure immediately and clears the pending request', () => {
    const { clearTimeoutMock, listeners, location, postMessage, windowObject } =
      createInjectedApiHarness()
    const poster = windowObject.$poster as {
      callPublicationBridgeV3(
        request: Record<string, unknown>,
        cb: (error: unknown, response?: unknown) => void
      ): void
    }
    const callback = vi.fn()

    poster.callPublicationBridgeV3(
      publicationBridgeV3NegotiationRequestFixture,
      callback,
    )
    listeners[0]?.({
      source: windowObject,
      origin: location.origin,
      data: {
        namespace: 'byfire.publication-bridge',
        direction: 'TRANSPORT_ERROR',
        protocolMajor: 3,
        requestId: publicationBridgeV3NegotiationRequestFixture.requestId,
        command: publicationBridgeV3NegotiationRequestFixture.command,
        error: {
          code: 'BRIDGE_RUNTIME_ERROR',
          message: 'The Publication Bridge transport failed.',
        },
      },
    })

    expect(callback).toHaveBeenCalledWith({
      code: 'BRIDGE_RUNTIME_ERROR',
      message: 'The Publication Bridge transport failed.',
    })
    expect(clearTimeoutMock).toHaveBeenCalledTimes(1)

    poster.callPublicationBridgeV3(
      publicationBridgeV3NegotiationRequestFixture,
      vi.fn(),
    )
    expect(postMessage).toHaveBeenCalledTimes(2)
  })

  it('rejects malformed requests and duplicate pending request IDs', () => {
    const { postMessage, windowObject } = createInjectedApiHarness()
    const poster = windowObject.$poster as {
      callPublicationBridgeV3(
        request: Record<string, unknown>,
        cb: (error: unknown, response?: unknown) => void
      ): void
    }
    const firstCallback = vi.fn()
    const duplicateCallback = vi.fn()

    poster.callPublicationBridgeV3(
      publicationBridgeV3NegotiationRequestFixture,
      firstCallback,
    )
    poster.callPublicationBridgeV3(
      {
        ...publicationBridgeV3NegotiationRequestFixture,
        command: 'accounts.resolve',
      },
      duplicateCallback,
    )

    expect(postMessage).toHaveBeenCalledTimes(1)
    expect(duplicateCallback).toHaveBeenCalledWith({
      code: 'DUPLICATE_REQUEST_ID',
      message: 'A Publication Bridge request with this requestId is pending.',
    })

    const invalidCallback = vi.fn()
    poster.callPublicationBridgeV3(
      {
        ...publicationBridgeV3NegotiationRequestFixture,
        requestId: ' invalid ',
      },
      invalidCallback,
    )
    expect(invalidCallback).toHaveBeenCalledWith({
      code: 'INVALID_BRIDGE_REQUEST',
      message: 'Publication Bridge request is invalid.',
    })
    expect(postMessage).toHaveBeenCalledTimes(1)
  })

  it('keeps the legacy fixed timeout behavior for pre-3.2 inspection', () => {
    const { setTimeoutMock, windowObject } = createInjectedApiHarness()
    const poster = windowObject.$poster as {
      callPublicationBridgeV3(
        request: Record<string, unknown>,
        cb: (error: unknown, response?: unknown) => void
      ): void
    }

    poster.callPublicationBridgeV3(
      publicationBridgeV3NegotiationRequestFixture,
      vi.fn(),
    )
    poster.callPublicationBridgeV3(
      {
        ...publicationBridgeV31InspectRequestFixture,
        requestId: 'req-inspect-transport-timeout',
      },
      vi.fn(),
    )

    expect(setTimeoutMock).toHaveBeenNthCalledWith(
      1,
      expect.any(Function),
      30000,
    )
    expect(setTimeoutMock).toHaveBeenNthCalledWith(
      2,
      expect.any(Function),
      40000,
    )
  })

  it('uses the v3.2 top-level deadline and aborts through a normal cancel request exactly once', () => {
    const {
      listeners,
      location,
      postMessage,
      setTimeoutMock,
      windowObject,
    } = createInjectedApiHarness()
    const deadlineAt = new Date(Date.now() + 12_345).toISOString()
    const request = {
      ...publicationBridgeV32InspectRequestFixture,
      requestId: 'req-inspect-abort-001',
      operationId: 'operation-inspect-abort-001',
      deadlineAt,
    }
    const callback = vi.fn()
    const abortController = new AbortController()
    const poster = windowObject.$poster as {
      callPublicationBridgeV3(
        request: typeof request,
        cb: typeof callback,
        options: { signal: AbortSignal },
      ): { cancel(reason?: 'CALLER_ABORTED' | 'DEADLINE_EXCEEDED'): boolean }
    }

    const handle = poster.callPublicationBridgeV3(request, callback, {
      signal: abortController.signal,
    })
    const scheduledDelay = setTimeoutMock.mock.calls[0]?.[1]
    expect(scheduledDelay).toBeGreaterThanOrEqual(12_340)
    expect(scheduledDelay).toBeLessThanOrEqual(12_345)

    abortController.abort()
    expect(callback).toHaveBeenCalledWith({
      code: 'BRIDGE_REQUEST_ABORTED',
      message: 'The Publication Bridge request was cancelled.',
    })
    expect(postMessage).toHaveBeenNthCalledWith(1, request, location.origin)
    expect(postMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        namespace: 'byfire.publication-bridge',
        direction: 'REQUEST',
        contractVersion: '3.2',
        sessionId: request.sessionId,
        operationId: request.operationId,
        command: 'bridge.cancel',
        payload: {
          targetRequestId: request.requestId,
          targetCommand: 'publication.inspect',
          reason: 'CALLER_ABORTED',
        },
      }),
      location.origin,
    )
    expect(handle.cancel()).toBe(false)

    listeners[0]?.({
      source: windowObject,
      origin: location.origin,
      data: {
        namespace: request.namespace,
        direction: 'RESPONSE',
        protocolMajor: request.protocolMajor,
        contractVersion: request.contractVersion,
        sessionId: request.sessionId,
        requestId: request.requestId,
        operationId: request.operationId,
        command: request.command,
        ok: false,
        runtime: { extensionVersion: '2.0.35', bridgeCapabilities: [], adapters: [] },
        error: {
          code: 'publication.inspection-cancelled',
          stage: 'TRANSPORT',
          message: 'cancelled',
          retryPolicy: 'SAFE_TO_RETRY',
          requiredUserAction: 'RETRY',
        },
      },
    })
    expect(callback).toHaveBeenCalledTimes(1)
  })

  it('sends DEADLINE_EXCEEDED when the v3.2 page deadline fires', () => {
    const { location, postMessage, timeoutCallbacks, windowObject } =
      createInjectedApiHarness()
    const request = {
      ...publicationBridgeV32InspectRequestFixture,
      requestId: 'req-inspect-deadline-001',
      operationId: 'operation-inspect-deadline-001',
      deadlineAt: new Date(Date.now() + 5_000).toISOString(),
    }
    const callback = vi.fn()
    const poster = windowObject.$poster as {
      callPublicationBridgeV3(
        request: typeof request,
        cb: typeof callback,
      ): { cancel(reason?: 'CALLER_ABORTED' | 'DEADLINE_EXCEEDED'): boolean }
    }

    const handle = poster.callPublicationBridgeV3(request, callback)
    const timeoutCallback = [...timeoutCallbacks.values()][0]
    timeoutCallback?.()

    expect(callback).toHaveBeenCalledWith({
      code: 'BRIDGE_REQUEST_TIMEOUT',
      message: 'The Publication Bridge request timed out.',
    })
    expect(postMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        command: 'bridge.cancel',
        payload: expect.objectContaining({ reason: 'DEADLINE_EXCEEDED' }),
      }),
      location.origin,
    )
    expect(handle.cancel()).toBe(false)
    expect(callback).toHaveBeenCalledTimes(1)
  })

  it('settles a synchronously aborted v3.2 call before posting the request', () => {
    const { postMessage, setTimeoutMock, windowObject } = createInjectedApiHarness()
    const request = {
      ...publicationBridgeV32InspectRequestFixture,
      requestId: 'req-inspect-pre-aborted-001',
      operationId: 'operation-inspect-pre-aborted-001',
      deadlineAt: new Date(Date.now() + 5_000).toISOString(),
    }
    const callback = vi.fn()
    const controller = new AbortController()
    controller.abort()
    const poster = windowObject.$poster as {
      callPublicationBridgeV3(
        request: typeof request,
        cb: typeof callback,
        options: { signal: AbortSignal },
      ): { cancel(): boolean }
    }

    const handle = poster.callPublicationBridgeV3(request, callback, {
      signal: controller.signal,
    })

    expect(callback).toHaveBeenCalledWith({
      code: 'BRIDGE_REQUEST_ABORTED',
      message: 'The Publication Bridge request was cancelled.',
    })
    expect(postMessage).not.toHaveBeenCalled()
    expect(setTimeoutMock).not.toHaveBeenCalled()
    expect(handle.cancel()).toBe(false)
  })

  it('ignores foreign or mismatched responses, then times out and cleans up', () => {
    const {
      listeners,
      location,
      postMessage,
      setTimeoutMock,
      timeoutCallbacks,
      windowObject,
    } = createInjectedApiHarness()
    const poster = windowObject.$poster as {
      callPublicationBridgeV3(
        request: Record<string, unknown>,
        cb: (error: unknown, response?: unknown) => void
      ): void
    }
    const callback = vi.fn()

    poster.callPublicationBridgeV3(
      publicationBridgeV3NegotiationRequestFixture,
      callback,
    )
    expect(setTimeoutMock).toHaveBeenCalledWith(expect.any(Function), 30000)

    for (const event of [
      {
        source: { foreign: true },
        origin: location.origin,
        data: publicationBridgeV3NegotiationResponseFixture,
      },
      {
        source: windowObject,
        origin: 'https://evil.example',
        data: publicationBridgeV3NegotiationResponseFixture,
      },
      {
        source: windowObject,
        origin: location.origin,
        data: {
          ...publicationBridgeV3NegotiationResponseFixture,
          command: 'accounts.resolve',
        },
      },
    ]) {
      listeners[0]?.(event)
    }
    expect(callback).not.toHaveBeenCalled()

    const timeoutCallback = [...timeoutCallbacks.values()][0]
    timeoutCallback?.()
    expect(callback).toHaveBeenCalledWith({
      code: 'BRIDGE_REQUEST_TIMEOUT',
      message: 'The Publication Bridge request timed out.',
    })

    listeners[0]?.({
      source: windowObject,
      origin: location.origin,
      data: publicationBridgeV3NegotiationResponseFixture,
    })
    expect(callback).toHaveBeenCalledTimes(1)

    poster.callPublicationBridgeV3(
      publicationBridgeV3NegotiationRequestFixture,
      vi.fn(),
    )
    expect(postMessage).toHaveBeenCalledTimes(2)
  })
})
