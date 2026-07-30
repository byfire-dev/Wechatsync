import { describe, expect, it, vi } from 'vitest'

import {
  fetchWithValidatedNoRedirects,
  readBoundedResponseText,
} from '../safe-http'

function responseAt(
  url: string,
  body: BodyInit | null,
  init?: ResponseInit,
): Response {
  const response = new Response(body, init)
  Object.defineProperty(response, 'url', { value: url })
  return response
}

function allowExactWeixinArticle(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (
      parsed.protocol !== 'https:' ||
      parsed.hostname !== 'mp.weixin.qq.com' ||
      parsed.port !== '' ||
      parsed.username !== '' ||
      parsed.password !== '' ||
      !parsed.pathname.startsWith('/s')
    ) {
      return null
    }
    return parsed.toString()
  } catch {
    return null
  }
}

describe('fetchWithValidatedNoRedirects', () => {
  const longUrl =
    'https://mp.weixin.qq.com/s?__biz=MzA0000000000%3D%3D&mid=777&idx=1'

  it('validates the only request target before calling fetch', async () => {
    const fetch = vi.fn()

    await expect(
      fetchWithValidatedNoRedirects({
        fetch,
        initialUrl: 'https://attacker.example/return-to-weixin',
        validateUrl: allowExactWeixinArticle,
      }),
    ).resolves.toEqual({
      success: false,
      errorCode: 'SAFE_FETCH_INITIAL_URL_INVALID',
    })

    expect(fetch).not.toHaveBeenCalled()
  })

  it('forces redirect:error and returns only an exact final response', async () => {
    const fetch = vi.fn(async (url: string) =>
      responseAt(url, '<html>published</html>', {
        headers: { 'Content-Type': 'text/html' },
      }),
    )

    const result = await fetchWithValidatedNoRedirects({
      fetch,
      initialUrl: longUrl,
      validateUrl: allowExactWeixinArticle,
      request: { redirect: 'follow' },
    })

    expect(result).toMatchObject({
      success: true,
      requestUrl: longUrl,
    })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledWith(
      longUrl,
      expect.objectContaining({ redirect: 'error' }),
    )
    if (result.success) await result.response.body?.cancel()
  })

  it('fails closed on browser opaqueredirect semantics without reading Location', async () => {
    const response = responseAt(longUrl, null)
    Object.defineProperties(response, {
      type: { value: 'opaqueredirect' },
      status: { value: 0 },
    })
    const fetch = vi.fn(async () => response)

    await expect(
      fetchWithValidatedNoRedirects({
        fetch,
        initialUrl: longUrl,
        validateUrl: allowExactWeixinArticle,
      }),
    ).resolves.toEqual({
      success: false,
      errorCode: 'SAFE_FETCH_REDIRECT_REJECTED',
    })

    expect(fetch).toHaveBeenCalledTimes(1)
    expect(response.headers.get('location')).toBeNull()
  })

  it('treats a redirect:error network rejection as a fixed failure', async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    })

    await expect(
      fetchWithValidatedNoRedirects({
        fetch,
        initialUrl: longUrl,
        validateUrl: allowExactWeixinArticle,
      }),
    ).resolves.toEqual({
      success: false,
      errorCode: 'SAFE_FETCH_REQUEST_FAILED',
    })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('rejects a non-compliant redirected response and cancels its body', async () => {
    const cancel = vi.fn()
    const response = responseAt(
      longUrl,
      new ReadableStream<Uint8Array>({ cancel }),
      {
        status: 302,
        headers: {
          Location: 'https://attacker.example/return-to-weixin',
        },
      },
    )
    const fetch = vi.fn(async () => response)

    await expect(
      fetchWithValidatedNoRedirects({
        fetch,
        initialUrl: longUrl,
        validateUrl: allowExactWeixinArticle,
      }),
    ).resolves.toEqual({
      success: false,
      errorCode: 'SAFE_FETCH_REDIRECT_REJECTED',
    })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('rejects a response URL change without requesting a second hop', async () => {
    const changedUrl = `${longUrl}&sn=changed`
    const cancel = vi.fn()
    const fetch = vi.fn(async () =>
      responseAt(changedUrl, new ReadableStream<Uint8Array>({ cancel })),
    )

    await expect(
      fetchWithValidatedNoRedirects({
        fetch,
        initialUrl: longUrl,
        validateUrl: allowExactWeixinArticle,
      }),
    ).resolves.toEqual({
      success: false,
      errorCode: 'SAFE_FETCH_RESPONSE_URL_INVALID',
    })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(cancel).toHaveBeenCalledTimes(1)
  })
})

describe('readBoundedResponseText', () => {
  it('reads chunked decoded bytes with no Content-Length', async () => {
    const encoder = new TextEncoder()
    const chunks = [encoder.encode('微信'), encoder.encode(' public page')]
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          const chunk = chunks.shift()
          if (chunk) controller.enqueue(chunk)
          else controller.close()
        },
      }),
      {
        headers: { 'Transfer-Encoding': 'chunked' },
      },
    )

    await expect(readBoundedResponseText(response, 64)).resolves.toEqual({
      success: true,
      text: '微信 public page',
    })
  })

  it('cancels an unknown-length decoded body as soon as it exceeds the limit', async () => {
    const cancel = vi.fn()
    const chunks = [
      new Uint8Array([1, 2, 3]),
      new Uint8Array([4, 5, 6]),
      new Uint8Array([7]),
    ]
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          const chunk = chunks.shift()
          if (chunk) controller.enqueue(chunk)
        },
        cancel,
      }),
    )

    await expect(readBoundedResponseText(response, 5)).resolves.toEqual({
      success: false,
      errorCode: 'SAFE_RESPONSE_BODY_TOO_LARGE',
    })
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(chunks).toHaveLength(1)
  })

  it('uses Content-Length only for an early fixed-code rejection', async () => {
    const cancel = vi.fn()
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }), {
      headers: { 'Content-Length': '100' },
    })

    await expect(readBoundedResponseText(response, 10)).resolves.toEqual({
      success: false,
      errorCode: 'SAFE_RESPONSE_BODY_TOO_LARGE',
    })
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('still enforces the stream limit when Content-Length understates the body', async () => {
    const cancel = vi.fn()
    const chunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])]
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          const chunk = chunks.shift()
          if (chunk) controller.enqueue(chunk)
        },
        cancel,
      }),
      {
        headers: { 'Content-Length': '1' },
      },
    )

    await expect(readBoundedResponseText(response, 5)).resolves.toEqual({
      success: false,
      errorCode: 'SAFE_RESPONSE_BODY_TOO_LARGE',
    })
    expect(cancel).toHaveBeenCalledTimes(1)
  })
})
