import { describe, expect, it, vi } from 'vitest'

import type { RuntimeInterface } from '../../../runtime/interface'
import type {
  PublicationInspectRequest,
  PublicationObservation,
} from '../../../publication-inspection/types'
import {
  normalizeWeixinAppMsgId,
  WEIXIN_PUBLIC_PAGE_MAX_BYTES,
} from '../../../publication-inspection/weixin'
import { WeixinAdapter } from '../weixin'

const ACCOUNT_ID = 'gh_test_account'
const TOKEN = '123456789'
const ARTICLE = {
  title: '微信公众号草稿',
  markdown: '正文',
  html: '<p>正文</p>',
}
const INSPECT_REQUEST: PublicationInspectRequest = {
  requestId: 'inspect-weixin-001',
  platform: 'weixin',
  externalAccountId: ACCOUNT_ID,
  draft: {
    platformPostId: '9001',
    draftUrl:
      'https://mp.weixin.qq.com/cgi-bin/appmsg?action=edit&appmsgid=9001&token=old-token',
    draftedAt: '2026-07-24T19:00:00+08:00',
  },
  articleHint: { title: '微信公众号草稿' },
  limit: 20,
}

function createRuntime(
  appMsgId?: unknown,
  overrides: Partial<RuntimeInterface> = {},
): RuntimeInterface {
  const responseAppMsgId = arguments.length === 0 ? '9001' : appMsgId
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(
        `<script>
          window.wx = {
            data: { t: "${TOKEN}" },
            ticket: "ticket",
            user_name: "${ACCOUNT_ID}",
            nick_name: "Test account",
            time: "1720000000"
          }
        </script>`,
        { headers: { 'Content-Type': 'text/html' } },
      ),
    )
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ appMsgId: responseAppMsgId }), {
        headers: { 'Content-Type': 'application/json' },
      }),
    )

  return {
    type: 'extension',
    fetch,
    cookies: {
      get: vi.fn(),
      set: vi.fn(),
      remove: vi.fn(),
    },
    storage: {
      get: vi.fn(),
      set: vi.fn(),
      remove: vi.fn(),
    },
    session: {
      get: vi.fn(),
      set: vi.fn(),
    },
    tabs: {
      query: vi.fn(),
      create: vi.fn().mockResolvedValue({ id: 1 }),
      remove: vi.fn(),
      waitForLoad: vi.fn(),
      executeScript: vi.fn(),
    },
    dom: {
      parseHTML: vi.fn(),
      querySelector: vi.fn(),
      querySelectorAll: vi.fn(),
      getTextContent: vi.fn(),
      getInnerHTML: vi.fn(),
    },
    ...overrides,
  } as RuntimeInterface
}

function authHtml(token = TOKEN, accountId = ACCOUNT_ID) {
  return `<script>window.wx={data:{t:"${token}"},ticket:"ticket",user_name:"${accountId}",nick_name:"Test account",time:"1720000000"}</script>`
}

function jsonResponse(value: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(value), {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
}

function publicHtmlResponse(
  body: BodyInit | null,
  url: string,
  options: {
    redirected?: boolean
    contentType?: string
    status?: number
  } = {},
): Response {
  const response = new Response(body, {
    status: options.status,
    headers: {
      'Content-Type': options.contentType ?? 'text/html; charset=utf-8',
    },
  })
  Object.defineProperties(response, {
    url: { value: url },
    redirected: { value: options.redirected ?? false },
  })
  return response
}

function opaqueRedirectResponse(): Response {
  const response = new Response(null)
  Object.defineProperties(response, {
    type: { value: 'opaqueredirect' },
    status: { value: 0 },
    url: { value: '' },
    redirected: { value: false },
  })
  return response
}

function publishedListResponse(publicUrl: string, appMsgId = '9001') {
  return jsonResponse({
    base_resp: { ret: 0 },
    publish_page: JSON.stringify({
      total_count: 1,
      publish_list: [
        {
          publish_info: JSON.stringify({
            publish_info: {
              draft_msgid: appMsgId,
              publish_status: 200,
              create_time: 1_720_000_000,
            },
            appmsgex: [
              {
                itemidx: 1,
                content_url: publicUrl,
              },
            ],
          }),
        },
      ],
    }),
  })
}

function emptyPublishedListResponse() {
  return jsonResponse({
    base_resp: { ret: 0 },
    publish_page: {
      total_count: 0,
      publish_list: [],
    },
  })
}

function createInspectionRuntime(
  fetchImpl: (url: string, options?: RequestInit) => Promise<Response>,
) {
  const add = vi.fn(async () => 'weixin-inspection-rule')
  const remove = vi.fn(async () => {})
  const runtime = {
    type: 'extension',
    fetch: vi.fn(fetchImpl),
    cookies: {},
    storage: {},
    session: {},
    dom: {},
    headerRules: { add, remove, clear: vi.fn(async () => {}) },
  } as unknown as RuntimeInterface
  return { runtime, add, remove }
}

describe('normalizeWeixinAppMsgId', () => {
  it.each([
    ['string', '9001', '9001'],
    ['trimmed string', ' 9001 ', '9001'],
    ['leading zero string', '0009001', '9001'],
    ['number', 9001, '9001'],
  ])('normalizes a safe %s', (_label, value, expected) => {
    expect(normalizeWeixinAppMsgId(value)).toBe(expected)
  })

  it.each([
    undefined,
    null,
    '',
    '0',
    0,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    '1e3',
    '9001x',
  ])('rejects an unsafe value: %s', (value) => {
    expect(normalizeWeixinAppMsgId(value)).toBeNull()
  })
})

describe('WeixinAdapter draft identity', () => {
  it.each([
    ['string', '9001'],
    ['number', 9001],
    ['canonicalized string', '0009001'],
  ])('returns a canonical postId for an appMsgId %s', async (_label, value) => {
    const adapter = new WeixinAdapter()
    await adapter.init(createRuntime(value))

    await expect(adapter.publish(ARTICLE)).resolves.toMatchObject({
      platform: 'weixin',
      success: true,
      postId: '9001',
      postUrl: expect.stringContaining('appmsgid=9001'),
      draftOnly: true,
    })
  })

  it.each([undefined, '', '0', 0, -1, 1.5, '9001x'])(
    'fails explicitly for an invalid appMsgId: %s',
    async (value) => {
      const adapter = new WeixinAdapter()
      await adapter.init(createRuntime(value))

      await expect(adapter.publish(ARTICLE)).resolves.toMatchObject({
        platform: 'weixin',
        success: false,
        error: '保存失败: 响应中的 appMsgId 无效',
      })
    },
  )

  it('opens the token-bearing editor internally and returns no URL', async () => {
    const runtime = createRuntime()
    const create = vi.fn().mockResolvedValue({ id: 1 })
    runtime.tabs!.create = create
    const adapter = new WeixinAdapter()
    await adapter.init(runtime)
    await expect(adapter.checkAuth()).resolves.toMatchObject({
      isAuthenticated: true,
      userId: ACCOUNT_ID,
    })

    const result = await adapter.openPublicationDraft({
      requestId: 'open-weixin-1',
      platform: 'weixin',
      externalAccountId: ACCOUNT_ID,
      platformPostId: '9001',
    })

    expect(result).toEqual({ opened: true })
    expect(JSON.stringify(result)).not.toContain(TOKEN)
    expect(create).toHaveBeenCalledTimes(1)
    const [url, active] = create.mock.calls[0]
    expect(active).toBe(true)
    expect(url).toContain('appmsgid=9001')
    expect(url).toContain(`token=${TOKEN}`)
  })

  it('does not expose a token-bearing URL when tab creation fails', async () => {
    const runtime = createRuntime()
    runtime.tabs!.create = vi
      .fn()
      .mockRejectedValue(
        new Error(`Cannot open https://mp.weixin.qq.com/?token=${TOKEN}`),
      )
    const adapter = new WeixinAdapter()
    await adapter.init(runtime)
    await adapter.checkAuth()

    await expect(
      adapter.openPublicationDraft({
        requestId: 'open-weixin-1',
        platform: 'weixin',
        externalAccountId: ACCOUNT_ID,
        platformPostId: '9001',
      }),
    ).rejects.toThrow('PUBLICATION_DRAFT_OPEN_FAILED')
  })

  it('closes a tab whose creation completes after the open deadline', async () => {
    let resolveCreate!: (tab: { id: number }) => void
    const create = vi.fn(
      () =>
        new Promise<{ id: number }>((resolve) => {
          resolveCreate = resolve
        }),
    )
    const remove = vi.fn().mockResolvedValue(undefined)
    const runtime = createRuntime()
    runtime.tabs!.create = create
    runtime.tabs!.remove = remove
    const adapter = new WeixinAdapter()
    await adapter.init(runtime)
    await adapter.checkAuth()
    const controller = new AbortController()
    const opening = adapter.openPublicationDraft(
      {
        requestId: 'open-weixin-late',
        platform: 'weixin',
        externalAccountId: ACCOUNT_ID,
        platformPostId: '9001',
      },
      { signal: controller.signal },
    )

    controller.abort()
    resolveCreate({ id: 42 })

    await expect(opening).rejects.toMatchObject({ name: 'AbortError' })
    expect(remove).toHaveBeenCalledWith(42)
  })
})

describe('WeixinAdapter publication inspection', () => {
  it('returns only DRAFT_PRESENT from a fresh authenticated temporary page', async () => {
    const tempUrl = 'http://mp.weixin.qq.com/s?tempkey=memory-only&mid=9001'
    const safeTempUrl =
      'https://mp.weixin.qq.com/s?tempkey=memory-only&mid=9001'
    const calls: Array<{ url: string; options?: RequestInit }> = []
    const { runtime, add, remove } = createInspectionRuntime(
      async (url, options) => {
        calls.push({ url, options })
        if (url === 'https://mp.weixin.qq.com/') {
          return new Response(authHtml('fresh-token'))
        }
        if (url.includes('/cgi-bin/appmsgpublish?')) {
          return emptyPublishedListResponse()
        }
        if (url.includes('action=get_temp_url')) {
          return jsonResponse({ base_resp: { ret: 0 }, temp_url: tempUrl })
        }
        if (url === safeTempUrl) {
          return new Response(
            '<h1 id="activity-name">Updated title</h1>' +
              '<section id="js_content"><p>Body one.</p><p>Body two.</p></section>',
          )
        }
        throw new Error('Unexpected request')
      },
    )
    const adapter = new WeixinAdapter()
    await adapter.init(runtime)

    const observations = await adapter.inspectPublication(INSPECT_REQUEST)

    expect(observations).toEqual([
      expect.objectContaining({
        platform: 'weixin',
        externalAccountId: ACCOUNT_ID,
        outcome: 'DRAFT_PRESENT',
        source: 'DRAFT_DETAIL',
        platformPostId: '9001',
        title: 'Updated title',
        bodyText: 'Body one.\n\nBody two.',
        bodyTruncated: false,
      }),
    ])
    expect(observations[0]).not.toHaveProperty('canonicalUrl')
    expect(JSON.stringify(observations)).not.toContain('memory-only')
    expect(JSON.stringify(observations)).not.toContain('fresh-token')
    expect(calls.map(({ url }) => url)).toContain(safeTempUrl)
    expect(calls.map(({ url }) => url)).not.toContain(tempUrl)
    expect(
      calls.find(({ url }) => url.includes('action=get_temp_url'))?.url,
    ).toContain('token=fresh-token')
    expect(
      calls.find(({ url }) => url.includes('action=get_temp_url'))?.options,
    ).toMatchObject({
      credentials: 'include',
      redirect: 'error',
    })
    expect(add).toHaveBeenCalledTimes(1)
    expect(remove).toHaveBeenCalledWith('weixin-inspection-rule')
  })

  it('passes one operation signal to every verification fetch', async () => {
    const controller = new AbortController()
    const receivedSignals: Array<AbortSignal | null | undefined> = []
    const tempUrl = 'https://mp.weixin.qq.com/s?tempkey=signal-test'
    const { runtime } = createInspectionRuntime(async (url, options) => {
      receivedSignals.push(options?.signal)
      if (url === 'https://mp.weixin.qq.com/') {
        return new Response(authHtml('fresh-token'))
      }
      if (url.includes('/cgi-bin/appmsgpublish?')) {
        return emptyPublishedListResponse()
      }
      if (url.includes('action=get_temp_url')) {
        return jsonResponse({ base_resp: { ret: 0 }, temp_url: tempUrl })
      }
      if (url === tempUrl) {
        return new Response(
          '<h1 id="activity-name">Title</h1><div id="js_content">Body</div>',
        )
      }
      throw new Error('Unexpected request')
    })
    const adapter = new WeixinAdapter()
    await adapter.init(runtime)

    await adapter.inspectPublication(INSPECT_REQUEST, {
      signal: controller.signal,
    })

    expect(receivedSignals).toHaveLength(4)
    expect(
      receivedSignals.every((signal) => signal === controller.signal),
    ).toBe(true)
  })

  it('resolves and rejects a conflicting appMsgId before authentication', async () => {
    const { runtime } = createInspectionRuntime(async () => {
      throw new Error('Authentication must not run')
    })
    const adapter = new WeixinAdapter()
    await adapter.init(runtime)

    const observations = await adapter.inspectPublication({
      ...INSPECT_REQUEST,
      draft: {
        ...INSPECT_REQUEST.draft,
        draftUrl:
          'https://mp.weixin.qq.com/cgi-bin/appmsg?action=edit&appmsgid=9002',
      },
    })

    expect(observations[0]).toMatchObject({
      outcome: 'PARSE_ERROR',
      platformPostId: '9001',
      errorCode: 'WEIXIN_DRAFT_ID_CONFLICT',
    })
    expect(runtime.fetch).not.toHaveBeenCalled()
  })

  it('refreshes authentication and uses the new token on every inspection', async () => {
    let authCount = 0
    const detailCalls: string[] = []
    const tempUrl = 'https://mp.weixin.qq.com/s?tempkey=memory-only'
    const { runtime } = createInspectionRuntime(async (url) => {
      if (url === 'https://mp.weixin.qq.com/') {
        authCount += 1
        return new Response(authHtml(`fresh-token-${authCount}`))
      }
      if (url.includes('/cgi-bin/appmsgpublish?')) {
        return emptyPublishedListResponse()
      }
      if (url.includes('action=get_temp_url')) {
        detailCalls.push(url)
        return jsonResponse({ base_resp: { ret: 0 }, temp_url: tempUrl })
      }
      return new Response(
        '<h1 id="activity-name">Title</h1><div id="js_content">Body</div>',
      )
    })
    const adapter = new WeixinAdapter()
    await adapter.init(runtime)

    await adapter.inspectPublication(INSPECT_REQUEST)
    await adapter.inspectPublication({
      ...INSPECT_REQUEST,
      requestId: 'inspect-weixin-002',
    })

    expect(authCount).toBe(2)
    expect(detailCalls[0]).toContain('token=fresh-token-1')
    expect(detailCalls[1]).toContain('token=fresh-token-2')
  })

  it('stops before draft detail when the active account does not match', async () => {
    const { runtime } = createInspectionRuntime(
      async () => new Response(authHtml('fresh-token', 'gh_other_account')),
    )
    const adapter = new WeixinAdapter()
    await adapter.init(runtime)

    const observations = await adapter.inspectPublication(INSPECT_REQUEST)

    expect(observations[0]).toMatchObject({
      outcome: 'ACCOUNT_MISMATCH',
      source: 'DRAFT_DETAIL',
      platformPostId: '9001',
      errorCode: 'WEIXIN_ACCOUNT_MISMATCH',
    })
    expect(runtime.fetch).toHaveBeenCalledTimes(1)
  })

  it('returns PUBLISHED only after an exact free-publish match and public-page verification', async () => {
    const publicUrl =
      'https://mp.weixin.qq.com/s?__biz=MzA0000000000%3D%3D&mid=777&idx=1'
    const calls: Array<{ url: string; options?: RequestInit }> = []
    const { runtime } = createInspectionRuntime(async (url, options) => {
      calls.push({ url, options })
      if (url === 'https://mp.weixin.qq.com/') {
        return new Response(authHtml('fresh-token'))
      }
      if (url.includes('/cgi-bin/appmsgpublish?')) {
        return jsonResponse({
          base_resp: { ret: 0 },
          publish_page: JSON.stringify({
            total_count: 1,
            publish_list: [
              {
                publish_info: JSON.stringify({
                  publish_info: {
                    draft_msgid: '9001',
                    publish_status: 200,
                    create_time: 1_720_000_000,
                  },
                  appmsgex: [
                    {
                      itemidx: 1,
                      content_url: publicUrl,
                    },
                  ],
                }),
              },
            ],
          }),
        })
      }
      if (url === publicUrl) {
        return publicHtmlResponse(
          '<h1 id="activity-name">Published title</h1>' +
            '<section id="js_content"><p>Published body</p></section>',
          publicUrl,
        )
      }
      throw new Error('Draft fallback must not run')
    })
    const adapter = new WeixinAdapter()
    await adapter.init(runtime)

    const observations = await adapter.inspectPublication(INSPECT_REQUEST)

    expect(observations).toEqual([
      expect.objectContaining({
        outcome: 'PUBLISHED',
        source: 'PUBLIC_PAGE',
        platformPostId: '9001',
        canonicalUrl: publicUrl,
        publishedAt: '2024-07-03T09:46:40.000Z',
        title: 'Published title',
        bodyText: 'Published body',
      }),
    ])
    expect(JSON.stringify(observations)).not.toContain('fresh-token')
    expect(calls).toHaveLength(3)
    const listCall = calls.find(({ url }) =>
      url.includes('/cgi-bin/appmsgpublish?'),
    )
    expect(listCall?.url).toContain('begin=0')
    expect(listCall?.url).toContain('count=10')
    expect(listCall?.url).toContain('token=fresh-token')
    expect(listCall?.options).toMatchObject({
      credentials: 'include',
      redirect: 'error',
      headers: {
        Accept: 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest',
      },
    })
    expect(calls.find(({ url }) => url === publicUrl)?.options).toMatchObject({
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
      headers: {
        Accept: 'text/html,application/xhtml+xml',
      },
    })
  })

  it('requires review for a published-list short URL without requesting it', async () => {
    const shortUrl = 'https://mp.weixin.qq.com/s/ShortAbC_123'
    const calls: string[] = []
    const { runtime } = createInspectionRuntime(async (url) => {
      calls.push(url)
      if (url === 'https://mp.weixin.qq.com/') {
        return new Response(authHtml('fresh-token'))
      }
      if (url.includes('/cgi-bin/appmsgpublish?')) {
        return publishedListResponse(shortUrl)
      }
      throw new Error('A short public URL must not be requested')
    })
    const adapter = new WeixinAdapter()
    await adapter.init(runtime)

    const observations = await adapter.inspectPublication(INSPECT_REQUEST)

    expect(observations[0]).toMatchObject({
      outcome: 'REVIEW_REQUIRED',
      source: 'PUBLISHED_LIST',
      platformPostId: '9001',
      errorCode: 'WEIXIN_PUBLISHED_EVIDENCE_INCOMPLETE',
    })
    expect(calls).toEqual([
      'https://mp.weixin.qq.com/',
      expect.stringContaining('/cgi-bin/appmsgpublish?'),
    ])
    expect(JSON.stringify(observations)).not.toContain(shortUrl)
  })

  it('fails closed if a runtime exposes an opaque manual redirect response', async () => {
    const publicUrl =
      'https://mp.weixin.qq.com/s?__biz=MzA0000000000%3D%3D&mid=777&idx=1'
    const publicRequests: RequestInit[] = []
    const { runtime } = createInspectionRuntime(async (url, options) => {
      if (url === 'https://mp.weixin.qq.com/') {
        return new Response(authHtml('fresh-token'))
      }
      if (url.includes('/cgi-bin/appmsgpublish?')) {
        return publishedListResponse(publicUrl)
      }
      if (url === publicUrl) {
        publicRequests.push(options ?? {})
        return opaqueRedirectResponse()
      }
      throw new Error('No redirect target may be requested')
    })
    const adapter = new WeixinAdapter()
    await adapter.init(runtime)

    const observations = await adapter.inspectPublication(INSPECT_REQUEST)

    expect(observations[0]).toMatchObject({
      outcome: 'REVIEW_REQUIRED',
      source: 'PUBLIC_PAGE',
      platformPostId: '9001',
      errorCode: 'WEIXIN_PUBLIC_REDIRECT_NOT_ALLOWED',
    })
    expect(publicRequests).toHaveLength(1)
    expect(publicRequests[0]).toMatchObject({ redirect: 'error' })
  })

  it('cancels the body when public response metadata is rejected', async () => {
    const publicUrl =
      'https://mp.weixin.qq.com/s?__biz=MzA0000000000%3D%3D&mid=777&idx=1'
    const cancelBody = vi.fn()
    const { runtime } = createInspectionRuntime(async (url) => {
      if (url === 'https://mp.weixin.qq.com/') {
        return new Response(authHtml('fresh-token'))
      }
      if (url.includes('/cgi-bin/appmsgpublish?')) {
        return publishedListResponse(publicUrl)
      }
      if (url === publicUrl) {
        return publicHtmlResponse(
          new ReadableStream<Uint8Array>({ cancel: cancelBody }),
          publicUrl,
          { contentType: 'application/json' },
        )
      }
      throw new Error('Draft fallback must not run')
    })
    const adapter = new WeixinAdapter()
    await adapter.init(runtime)

    const observations = await adapter.inspectPublication(INSPECT_REQUEST)

    expect(observations[0]).toMatchObject({
      outcome: 'REVIEW_REQUIRED',
      errorCode: 'WEIXIN_PUBLIC_UNEXPECTED_CONTENT_TYPE',
    })
    expect(cancelBody).toHaveBeenCalledTimes(1)
  })

  it('stops a chunked public body at the decoded byte limit', async () => {
    const publicUrl =
      'https://mp.weixin.qq.com/s?__biz=MzA0000000000%3D%3D&mid=777&idx=1'
    const cancelBody = vi.fn()
    const chunks = [
      new Uint8Array(WEIXIN_PUBLIC_PAGE_MAX_BYTES),
      new Uint8Array([1]),
      new Uint8Array([2]),
    ]
    const { runtime } = createInspectionRuntime(async (url) => {
      if (url === 'https://mp.weixin.qq.com/') {
        return new Response(authHtml('fresh-token'))
      }
      if (url.includes('/cgi-bin/appmsgpublish?')) {
        return publishedListResponse(publicUrl)
      }
      if (url === publicUrl) {
        return publicHtmlResponse(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              const chunk = chunks.shift()
              if (chunk) controller.enqueue(chunk)
            },
            cancel: cancelBody,
          }),
          publicUrl,
        )
      }
      throw new Error('Draft fallback must not run')
    })
    const adapter = new WeixinAdapter()
    await adapter.init(runtime)

    const observations = await adapter.inspectPublication(INSPECT_REQUEST)

    expect(observations[0]).toMatchObject({
      outcome: 'REVIEW_REQUIRED',
      errorCode: 'WEIXIN_PUBLIC_BODY_TOO_LARGE',
    })
    expect(cancelBody).toHaveBeenCalledTimes(1)
  })

  it('revalidates the canonical public URL and exact appMsgId in published proof', () => {
    const adapter = new WeixinAdapter()
    const validObservation: PublicationObservation = {
      observationKey: 'weixin:proof:published',
      platform: 'weixin',
      externalAccountId: ACCOUNT_ID,
      outcome: 'PUBLISHED',
      source: 'PUBLIC_PAGE',
      platformPostId: '9001',
      canonicalUrl:
        'https://mp.weixin.qq.com/s?__biz=MzA0000000000%3D%3D&mid=777&idx=1',
      title: 'Published title',
      publishedAt: '2024-07-03T09:46:40.000Z',
      bodyText: 'Published body',
      bodyTruncated: false,
      observedAt: '2024-07-03T09:47:00.000Z',
    }

    expect(
      adapter.provePublishedObservation(INSPECT_REQUEST, validObservation),
    ).toEqual({
      observedAuthorExternalAccountId: ACCOUNT_ID,
      publicAccess: { status: 'CONFIRMED' },
      bodyTruncated: false,
    })

    for (const invalidObservation of [
      {
        ...validObservation,
        canonicalUrl: 'https://attacker.example/public-article',
      },
      {
        ...validObservation,
        canonicalUrl: `${validObservation.canonicalUrl}&tracking=not-canonical`,
      },
      {
        ...validObservation,
        canonicalUrl: 'https://mp.weixin.qq.com/s/ShortAbC_123',
      },
      {
        ...validObservation,
        platformPostId: '9002',
      },
    ]) {
      expect(
        adapter.provePublishedObservation(INSPECT_REQUEST, invalidObservation),
      ).toBeNull()
    }
  })

  it('returns REVIEW_REQUIRED for an exact but incomplete published record', async () => {
    const { runtime } = createInspectionRuntime(async (url) => {
      if (url === 'https://mp.weixin.qq.com/') {
        return new Response(authHtml('fresh-token'))
      }
      if (url.includes('/cgi-bin/appmsgpublish?')) {
        return jsonResponse({
          publish_page: {
            total_count: 1,
            publish_list: [
              {
                publish_info: {
                  publish_info: {
                    draft_msgid: '9001',
                    publish_status: 199,
                  },
                  appmsgex: [
                    {
                      itemidx: 1,
                      content_url:
                        'https://mp.weixin.qq.com/s?__biz=MzA0000000000%3D%3D&mid=777&idx=1',
                    },
                  ],
                },
              },
            ],
          },
        })
      }
      throw new Error('No public or draft request is allowed')
    })
    const adapter = new WeixinAdapter()
    await adapter.init(runtime)

    const observations = await adapter.inspectPublication(INSPECT_REQUEST)

    expect(observations).toEqual([
      expect.objectContaining({
        outcome: 'REVIEW_REQUIRED',
        source: 'PUBLISHED_LIST',
        platformPostId: '9001',
        errorCode: 'WEIXIN_PUBLISHED_EVIDENCE_INCOMPLETE',
      }),
    ])
    expect(JSON.stringify(observations)).not.toContain('mid=777')
    expect(runtime.fetch).toHaveBeenCalledTimes(2)
  })

  it('returns REVIEW_REQUIRED without exposing the candidate when public verification fails', async () => {
    const publicUrl =
      'https://mp.weixin.qq.com/s?__biz=MzA0000000000%3D%3D&mid=777&idx=1'
    const { runtime } = createInspectionRuntime(async (url) => {
      if (url === 'https://mp.weixin.qq.com/') {
        return new Response(authHtml('fresh-token'))
      }
      if (url.includes('/cgi-bin/appmsgpublish?')) {
        return jsonResponse({
          publish_page: {
            total_count: 1,
            publish_list: [
              {
                publish_info: {
                  publish_info: {
                    draft_msgid: '9001',
                    publish_status: 200,
                    create_time: 1_720_000_000,
                  },
                  appmsgex: [
                    {
                      itemidx: 1,
                      content_url: publicUrl,
                    },
                  ],
                },
              },
            ],
          },
        })
      }
      if (url === publicUrl) {
        return publicHtmlResponse('<main>not an article</main>', publicUrl)
      }
      throw new Error('Unexpected request')
    })
    const adapter = new WeixinAdapter()
    await adapter.init(runtime)

    const observations = await adapter.inspectPublication(INSPECT_REQUEST)

    expect(observations[0]).toMatchObject({
      outcome: 'REVIEW_REQUIRED',
      source: 'PUBLIC_PAGE',
      platformPostId: '9001',
      errorCode: 'WEIXIN_PUBLIC_PAGE_CONTENT_INVALID',
    })
    expect(JSON.stringify(observations)).not.toContain('mid=777')
    expect(JSON.stringify(observations)).not.toContain('MzA0000000000')
  })

  it('requires review when the published-list response cannot be parsed', async () => {
    const { runtime } = createInspectionRuntime(async (url) => {
      if (url === 'https://mp.weixin.qq.com/') {
        return new Response(authHtml('fresh-token'))
      }
      if (url.includes('/cgi-bin/appmsgpublish?')) {
        return new Response('not json')
      }
      throw new Error('Unexpected request')
    })
    const adapter = new WeixinAdapter()
    await adapter.init(runtime)

    const observations = await adapter.inspectPublication(INSPECT_REQUEST)
    expect(observations).toEqual([
      expect.objectContaining({
        outcome: 'REVIEW_REQUIRED',
        source: 'PUBLISHED_LIST',
        platformPostId: '9001',
        errorCode: 'WEIXIN_PUBLISHED_LIST_PARSE_ERROR',
      }),
    ])
    const observation = observations[0]
    expect(observation).not.toHaveProperty('canonicalUrl')
    expect(observation).not.toHaveProperty('title')
    expect(observation).not.toHaveProperty('bodyText')
  })

  it.each([
    {
      name: 'request failure',
      response: () => {
        throw new Error('secret request URL')
      },
      errorCode: 'WEIXIN_PUBLISHED_LIST_FETCH_ERROR',
    },
    {
      name: 'HTTP failure',
      response: () => new Response('', { status: 503 }),
      errorCode: 'WEIXIN_PUBLISHED_LIST_FETCH_ERROR',
    },
    {
      name: 'response-shape failure',
      response: () =>
        jsonResponse({
          base_resp: { ret: 0 },
          publish_page: { publish_list: 'not-an-array' },
        }),
      errorCode: 'WEIXIN_PUBLISHED_LIST_PARSE_ERROR',
    },
    {
      name: 'record parse failure',
      response: () =>
        jsonResponse({
          base_resp: { ret: 0 },
          publish_page: {
            total_count: 1,
            publish_list: [{ publish_info: '{not-json' }],
          },
        }),
      errorCode: 'WEIXIN_PUBLISHED_LIST_PARSE_ERROR',
    },
  ])(
    'requires review without leaking fields after a published-list $name',
    async ({ response, errorCode }) => {
      const { runtime } = createInspectionRuntime(async (url) => {
        if (url === 'https://mp.weixin.qq.com/') {
          return new Response(authHtml('fresh-token'))
        }
        if (url.includes('/cgi-bin/appmsgpublish?')) {
          return response()
        }
        throw new Error('Unexpected request')
      })
      const adapter = new WeixinAdapter()
      await adapter.init(runtime)

      const observations = await adapter.inspectPublication(INSPECT_REQUEST)

      expect(observations).toEqual([
        expect.objectContaining({
          outcome: 'REVIEW_REQUIRED',
          source: 'PUBLISHED_LIST',
          platformPostId: '9001',
          errorCode,
        }),
      ])
      expect(observations[0]).not.toHaveProperty('canonicalUrl')
      expect(observations[0]).not.toHaveProperty('title')
      expect(observations[0]).not.toHaveProperty('bodyText')
      expect(JSON.stringify(observations)).not.toContain('secret request URL')
      expect(runtime.fetch).toHaveBeenCalledTimes(2)
    },
  )

  it('requires review when published-list pagination reaches its cap', async () => {
    const begins: string[] = []
    const { runtime } = createInspectionRuntime(async (url) => {
      if (url === 'https://mp.weixin.qq.com/') {
        return new Response(authHtml('fresh-token'))
      }
      if (url.includes('/cgi-bin/appmsgpublish?')) {
        const parsed = new URL(url)
        begins.push(parsed.searchParams.get('begin') ?? '')
        return jsonResponse({
          publish_page: {
            total_count: 100,
            publish_list: Array.from({ length: 10 }, (_, index) => ({
              publish_info: {
                draft_msgid: String(
                  Number(parsed.searchParams.get('begin')) + index + 1,
                ),
                publish_status: 200,
              },
            })),
          },
        })
      }
      throw new Error('Unexpected request')
    })
    const adapter = new WeixinAdapter()
    await adapter.init(runtime)

    const observations = await adapter.inspectPublication(INSPECT_REQUEST)

    expect(begins).toEqual(['0', '10', '20', '30', '40'])
    expect(observations[0]).toMatchObject({
      outcome: 'REVIEW_REQUIRED',
      source: 'PUBLISHED_LIST',
      platformPostId: '9001',
      errorCode: 'WEIXIN_PUBLISHED_SCAN_INCOMPLETE',
    })
    expect(observations[0]).not.toHaveProperty('canonicalUrl')
    expect(observations[0]).not.toHaveProperty('title')
    expect(observations[0]).not.toHaveProperty('bodyText')
  })

  it.each([
    {
      tempUrl: 'https://attacker.example/s?tempkey=must-not-leak',
      page: '<h1 id="activity-name">Title</h1><div id="js_content">Body</div>',
      errorCode: 'WEIXIN_TEMP_URL_HOST_MISMATCH',
      expectedFetchCount: 3,
      outcome: 'PARSE_ERROR',
    },
    {
      tempUrl: 'https://mp.weixin.qq.com/s?tempkey=memory-only',
      page: '<main>changed page structure</main>',
      errorCode: 'WEIXIN_DRAFT_STATE_REVIEW_REQUIRED',
      expectedFetchCount: 4,
      outcome: 'REVIEW_REQUIRED',
    },
  ])(
    'fails closed without leaking an unsafe or unreadable temporary page',
    async ({ tempUrl, page, errorCode, expectedFetchCount, outcome }) => {
      const { runtime } = createInspectionRuntime(async (url) => {
        if (url === 'https://mp.weixin.qq.com/') {
          return new Response(authHtml('fresh-token'))
        }
        if (url.includes('/cgi-bin/appmsgpublish?')) {
          return emptyPublishedListResponse()
        }
        if (url.includes('action=get_temp_url')) {
          return jsonResponse({
            base_resp: { ret: 0 },
            temp_url: tempUrl,
          })
        }
        return new Response(page)
      })
      const adapter = new WeixinAdapter()
      await adapter.init(runtime)

      const observations = await adapter.inspectPublication(INSPECT_REQUEST)

      expect(observations[0]).toMatchObject({
        outcome,
        errorCode,
        platformPostId: '9001',
      })
      expect(observations[0].outcome).not.toBe('NOT_FOUND')
      expect(observations[0].outcome).not.toBe('PUBLISHED')
      expect(JSON.stringify(observations)).not.toContain('must-not-leak')
      expect(JSON.stringify(observations)).not.toContain('attacker.example')
      expect(JSON.stringify(observations)).not.toContain('fresh-token')
      expect(runtime.fetch).toHaveBeenCalledTimes(expectedFetchCount)
    },
  )
})
