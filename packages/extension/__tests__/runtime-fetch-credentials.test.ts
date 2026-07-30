import { afterEach, describe, expect, it, vi } from 'vitest'

import { ExtensionRuntime } from '../src/runtime/extension'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ExtensionRuntime.fetch credentials', () => {
  it('preserves an explicit anonymous request', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)

    await new ExtensionRuntime().fetch('https://example.com/public', {
      credentials: 'omit',
    })

    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.com/public',
      expect.objectContaining({ credentials: 'omit' }),
    )
  })

  it('defaults to authenticated requests when credentials are absent', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)

    await new ExtensionRuntime().fetch('https://example.com/account')

    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.com/account',
      expect.objectContaining({ credentials: 'include' }),
    )
  })

  it('keeps an explicit authenticated draft request', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)

    await new ExtensionRuntime().fetch('https://example.com/draft', {
      credentials: 'include',
    })

    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.com/draft',
      expect.objectContaining({ credentials: 'include' }),
    )
  })

  it('forwards an external abort without misclassifying it as a timeout', async () => {
    let runtimeSignal: AbortSignal | undefined
    const fetchMock = vi.fn(
      async (_url: string, options?: RequestInit): Promise<Response> => {
        runtimeSignal = options?.signal ?? undefined
        return new Promise((_resolve, reject) => {
          runtimeSignal?.addEventListener(
            'abort',
            () => reject(runtimeSignal?.reason),
            { once: true },
          )
        })
      },
    )
    vi.stubGlobal('fetch', fetchMock)
    const callerController = new AbortController()
    const request = new ExtensionRuntime({ timeout: 10_000 }).fetch(
      'https://example.com/cancellable',
      { signal: callerController.signal },
    )

    callerController.abort()

    await expect(request).rejects.toMatchObject({ name: 'AbortError' })
    expect(runtimeSignal).not.toBe(callerController.signal)
    expect(runtimeSignal?.aborted).toBe(true)
  })

  it('keeps the external deadline active while the response body is pending', async () => {
    let runtimeSignal: AbortSignal | undefined
    let rejectBody!: (reason?: unknown) => void
    const response = {
      body: {},
      text: vi.fn(
        () =>
          new Promise<string>((_resolve, reject) => {
            rejectBody = reject
          }),
      ),
    } as unknown as Response
    const fetchMock = vi.fn(
      async (_url: string, options?: RequestInit): Promise<Response> => {
        runtimeSignal = options?.signal ?? undefined
        runtimeSignal?.addEventListener(
          'abort',
          () => rejectBody(runtimeSignal?.reason),
          { once: true },
        )
        return response
      },
    )
    vi.stubGlobal('fetch', fetchMock)
    const callerController = new AbortController()
    const receivedResponse = await new ExtensionRuntime({
      timeout: 10_000,
    }).fetch('https://example.com/slow-body', {
      signal: callerController.signal,
    })
    const bodyRead = receivedResponse.text()

    callerController.abort()

    await expect(bodyRead).rejects.toMatchObject({ name: 'AbortError' })
    expect(runtimeSignal?.aborted).toBe(true)
  })

  it('cleans the abort scope when a streamed response body is cancelled', async () => {
    let runtimeSignal: AbortSignal | undefined
    const cancelBody = vi.fn()
    const fetchMock = vi.fn(
      async (_url: string, options?: RequestInit): Promise<Response> => {
        runtimeSignal = options?.signal ?? undefined
        return new Response(
          new ReadableStream<Uint8Array>({
            cancel: cancelBody,
          }),
        )
      },
    )
    vi.stubGlobal('fetch', fetchMock)
    const callerController = new AbortController()
    const response = await new ExtensionRuntime({ timeout: 10_000 }).fetch(
      'https://example.com/rejected-metadata',
      { signal: callerController.signal },
    )

    await response.body?.cancel()
    callerController.abort()

    expect(cancelBody).toHaveBeenCalledTimes(1)
    expect(runtimeSignal?.aborted).toBe(false)
  })

  it('cleans the abort scope when a stream reader reaches EOF', async () => {
    let runtimeSignal: AbortSignal | undefined
    const fetchMock = vi.fn(
      async (_url: string, options?: RequestInit): Promise<Response> => {
        runtimeSignal = options?.signal ?? undefined
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('bounded'))
              controller.close()
            },
          }),
        )
      },
    )
    vi.stubGlobal('fetch', fetchMock)
    const callerController = new AbortController()
    const response = await new ExtensionRuntime({ timeout: 10_000 }).fetch(
      'https://example.com/streamed',
      { signal: callerController.signal },
    )

    const reader = response.body?.getReader()
    await expect(reader?.read()).resolves.toMatchObject({ done: false })
    await expect(reader?.read()).resolves.toEqual({
      done: true,
      value: undefined,
    })
    callerController.abort()

    expect(runtimeSignal?.aborted).toBe(false)
  })

  it('keeps external cancellation active during a pending stream read', async () => {
    let runtimeSignal: AbortSignal | undefined
    const fetchMock = vi.fn(
      async (_url: string, options?: RequestInit): Promise<Response> => {
        runtimeSignal = options?.signal ?? undefined
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              runtimeSignal?.addEventListener(
                'abort',
                () => controller.error(runtimeSignal?.reason),
                { once: true },
              )
            },
          }),
        )
      },
    )
    vi.stubGlobal('fetch', fetchMock)
    const callerController = new AbortController()
    const response = await new ExtensionRuntime({ timeout: 10_000 }).fetch(
      'https://example.com/pending-stream',
      { signal: callerController.signal },
    )
    const bodyRead = response.body?.getReader().read()

    callerController.abort()

    await expect(bodyRead).rejects.toMatchObject({ name: 'AbortError' })
    expect(runtimeSignal?.aborted).toBe(true)
  })
})
