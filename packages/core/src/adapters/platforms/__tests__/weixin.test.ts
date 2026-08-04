import { describe, expect, it, vi } from 'vitest'

import type { RuntimeInterface } from '../../../runtime/interface'
import type {
  PublicationInspectionObservation as PublicationObservation,
  PublicationInspectionRequest as PublicationInspectRequest,
} from '../../../publication-inspection/domain'
import { derivePublicationPublicIdentity } from '../../../publication-inspection/url'
import {
  normalizeWeixinAppMsgId,
  WEIXIN_PUBLISHED_LIST_MAX_BYTES,
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

function publishedHistoryPage(
  records: Array<{ draftMsgId: string; publishedAt?: string }>,
  totalCount = records.length,
) {
  return jsonResponse({
    base_resp: { ret: 0 },
    publish_page: {
      total_count: totalCount,
      publish_list: records.map(({ draftMsgId, publishedAt }) => ({
        publish_info: {
          draft_msgid: draftMsgId,
          publish_status: 200,
          ...(publishedAt
            ? { create_time: Math.floor(Date.parse(publishedAt) / 1_000) }
            : {}),
        },
      })),
    },
  })
}

function createInspectionRuntime(
  fetchImpl: (url: string, options?: RequestInit) => Promise<Response>,
  options: { defaultDraftListAppMsgId?: string | null } = {},
) {
  const defaultDraftListAppMsgId =
    typeof options.defaultDraftListAppMsgId === 'undefined'
      ? '9001'
      : options.defaultDraftListAppMsgId
  const add = vi.fn(async () => 'weixin-inspection-rule')
  const remove = vi.fn(async () => {})
  const runtime = {
    type: 'extension',
    fetch: vi.fn(async (url: string, requestOptions?: RequestInit) => {
      if (defaultDraftListAppMsgId && url.includes('action=list_card')) {
        return jsonResponse({
          base_resp: { ret: 0 },
          app_msg_info: { item: [{ app_id: defaultDraftListAppMsgId }] },
        })
      }
      return fetchImpl(url, requestOptions)
    }),
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
  it('probes one stable authenticated account', async () => {
    const adapter = new WeixinAdapter()
    await adapter.init(createRuntime())

    await expect(adapter.probeAccounts()).resolves.toEqual({
      status: 'AUTHENTICATED',
      accounts: [
        {
          externalAccountId: ACCOUNT_ID,
          displayName: 'Test account',
        },
      ],
    })
    expect(adapter.meta.capabilities).toContain('account_binding')
  })

  it('rejects a stale binding before the first platform write', async () => {
    const fetch = vi.fn(
      async (_url: string) => new Response(authHtml(TOKEN, 'gh_other_account')),
    )
    const adapter = new WeixinAdapter()
    await adapter.init(createRuntime(undefined, { fetch }))

    await expect(
      adapter.publish(ARTICLE, {
        accountBinding: { externalAccountId: ACCOUNT_ID },
      }),
    ).resolves.toMatchObject({
      platform: 'weixin',
      success: false,
      externalAccountId: ACCOUNT_ID,
      errorCode: 'ACCOUNT_BINDING_NOT_FOUND',
    })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0]?.[0]).toBe('https://mp.weixin.qq.com/')
  })

  it.each([
    ['string', '9001'],
    ['number', 9001],
    ['canonicalized string', '0009001'],
  ])('returns a canonical postId for an appMsgId %s', async (_label, value) => {
    const adapter = new WeixinAdapter()
    await adapter.init(createRuntime(value))

    await expect(
      adapter.publish(ARTICLE, {
        accountBinding: { externalAccountId: ACCOUNT_ID },
      }),
    ).resolves.toMatchObject({
      platform: 'weixin',
      success: true,
      postId: '9001',
      postUrl: expect.stringContaining('appmsgid=9001'),
      externalAccountId: ACCOUNT_ID,
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
  it('verifies a known public locator directly without scanning published or draft lists', async () => {
    const publicUrl = 'https://mp.weixin.qq.com/s/AaBbCcDd_123'
    const identity = derivePublicationPublicIdentity('weixin', publicUrl)
    if (!identity) throw new Error('Expected a valid WeChat public identity')
    const requestedUrls: string[] = []
    const { runtime } = createInspectionRuntime(async (url) => {
      requestedUrls.push(url)
      if (url === 'https://mp.weixin.qq.com/') {
        return new Response(authHtml('fresh-token'))
      }
      if (url === publicUrl) {
        return publicHtmlResponse(
          '<script>var ct = "1720000000"; oriCreateTime = \'1720000000\';</script>' +
            '<h1 id="activity-name">Known public article</h1>' +
            '<section id="js_content"><p>Verified body.</p></section>',
          publicUrl,
        )
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    const adapter = new WeixinAdapter()
    await adapter.init(runtime)

    const observations = await adapter.inspectPublication({
      ...INSPECT_REQUEST,
      knownPublicLocator: {
        publicUrl: identity.canonicalUrl,
        publicIdentityKey: identity.key,
      },
    })

    expect(observations).toEqual([
      expect.objectContaining({
        outcome: 'PUBLISHED',
        source: 'PUBLIC_PAGE',
        canonicalUrl: publicUrl,
        platformPostId: '9001',
        title: 'Known public article',
        bodyText: 'Verified body.',
        bodyTruncated: false,
        publishedAt: '2024-07-03T09:46:40.000Z',
        publicAccess: expect.objectContaining({
          status: 'CONFIRMED',
          checkedUrl: publicUrl,
          checkedPublicIdentityKey: identity.key,
          httpStatus: 200,
        }),
      }),
    ])
    expect(requestedUrls).toEqual(['https://mp.weixin.qq.com/', publicUrl])
    expect(requestedUrls.some((url) => url.includes('appmsgpublish'))).toBe(
      false,
    )
    expect(requestedUrls.some((url) => url.includes('list_card'))).toBe(false)
    expect(requestedUrls.some((url) => url.includes('get_temp_url'))).toBe(
      false,
    )
  })

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
          return jsonResponse({
            base_resp: { ret: 0 },
            publish_page: {
              total_count: 11,
              publish_list: Array.from({ length: 10 }, () => ({
                publish_info: '',
              })),
            },
          })
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
    expect(
      calls.filter(({ url }) => url.includes('/cgi-bin/appmsgpublish?')),
    ).toHaveLength(1)
    expect(runtime.fetch).toHaveBeenCalledWith(
      expect.stringContaining('action=list_card'),
      expect.objectContaining({ credentials: 'include', redirect: 'error' }),
    )
    expect(add).toHaveBeenCalledTimes(1)
    expect(remove).toHaveBeenCalledWith('weixin-inspection-rule')
  })

  it('does not treat a temporary preview as a draft without exact current-list membership', async () => {
    const requestedUrls: string[] = []
    const { runtime } = createInspectionRuntime(
      async (url) => {
        requestedUrls.push(url)
        if (url === 'https://mp.weixin.qq.com/') {
          return new Response(authHtml('fresh-token'))
        }
        if (url.includes('/cgi-bin/appmsgpublish?')) {
          return emptyPublishedListResponse()
        }
        if (url.includes('action=list_card')) {
          return jsonResponse({
            base_resp: { ret: 0 },
            app_msg_info: { item: [{ app_id: '8999' }] },
          })
        }
        if (url.includes('action=get_temp_url')) {
          throw new Error('Temporary preview must not be requested')
        }
        throw new Error(`Unexpected request: ${url}`)
      },
      { defaultDraftListAppMsgId: null },
    )
    const adapter = new WeixinAdapter()
    await adapter.init(runtime)

    const observations = await adapter.inspectPublication(INSPECT_REQUEST)

    expect(observations).toEqual([
      expect.objectContaining({
        outcome: 'REVIEW_REQUIRED',
        source: 'DRAFT_LIST',
        platformPostId: '9001',
        errorCode: 'WEIXIN_DRAFT_MEMBERSHIP_UNRESOLVED',
      }),
    ])
    expect(
      requestedUrls.filter((url) => url.includes('action=list_card')),
    ).toHaveLength(2)
    expect(
      requestedUrls.some((url) => url.includes('action=get_temp_url')),
    ).toBe(false)
  })

  it('stops published history at the newest-first draft boundary before opening the draft', async () => {
    const tempUrl = 'https://mp.weixin.qq.com/s?tempkey=bounded-history'
    const listBegins: string[] = []
    const { runtime } = createInspectionRuntime(async (url) => {
      if (url === 'https://mp.weixin.qq.com/') {
        return new Response(authHtml('fresh-token'))
      }
      if (url.includes('/cgi-bin/appmsgpublish?')) {
        listBegins.push(new URL(url).searchParams.get('begin') ?? '')
        return jsonResponse({
          base_resp: { ret: 0 },
          publish_page: {
            total_count: 100,
            publish_list: [
              {
                publish_info: {
                  draft_msgid: '8999',
                  publish_status: 200,
                  create_time: 1720000000,
                },
              },
              ...Array.from({ length: 9 }, () => ({ publish_info: '' })),
            ],
          },
        })
      }
      if (url.includes('action=get_temp_url')) {
        return jsonResponse({ base_resp: { ret: 0 }, temp_url: tempUrl })
      }
      if (url === tempUrl) {
        return new Response(
          '<h1 id="activity-name">Bounded draft</h1><div id="js_content">Draft body</div>',
        )
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    const adapter = new WeixinAdapter()
    await adapter.init(runtime)

    const observations = await adapter.inspectPublication({
      ...INSPECT_REQUEST,
      articleHint: {
        ...INSPECT_REQUEST.articleHint,
        publishedAfter: '2024-07-03T10:00:00.000Z',
      },
    })

    expect(listBegins).toEqual(['0'])
    expect(observations).toEqual([
      expect.objectContaining({
        outcome: 'DRAFT_PRESENT',
        platformPostId: '9001',
        title: 'Bounded draft',
      }),
    ])
  })

  it('does not derive the publication cutoff from draft.draftedAt alone', async () => {
    const tempUrl = 'https://mp.weixin.qq.com/s?tempkey=drafted-at-only'
    const listBegins: string[] = []
    const { runtime } = createInspectionRuntime(async (url) => {
      if (url === 'https://mp.weixin.qq.com/') {
        return new Response(authHtml('fresh-token'))
      }
      if (url.includes('/cgi-bin/appmsgpublish?')) {
        const begin = new URL(url).searchParams.get('begin') ?? ''
        listBegins.push(begin)
        return begin === '0'
          ? publishedHistoryPage(
              [{ draftMsgId: '8999', publishedAt: '2024-07-03T09:00:00.000Z' }],
              1,
            )
          : emptyPublishedListResponse()
      }
      if (url.includes('action=get_temp_url')) {
        return jsonResponse({ base_resp: { ret: 0 }, temp_url: tempUrl })
      }
      if (url === tempUrl) {
        return new Response(
          '<h1 id="activity-name">Drafted-at only</h1><div id="js_content">Draft body</div>',
        )
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    const adapter = new WeixinAdapter()
    await adapter.init(runtime)

    const observations = await adapter.inspectPublication(INSPECT_REQUEST)

    expect(listBegins).toEqual(['0', '1'])
    expect(observations[0]).toMatchObject({
      outcome: 'DRAFT_PRESENT',
      source: 'DRAFT_DETAIL',
      platformPostId: '9001',
    })
  })

  it.each([
    {
      name: 'keeps scanning at the exact ten-minute boundary',
      publishedAfter: '2024-07-03T10:00:00.000Z',
      expectedBegins: ['0', '1'],
    },
    {
      name: 'cuts off when the newest record is strictly older than the ten-minute boundary',
      publishedAfter: '2024-07-03T10:00:00.001Z',
      expectedBegins: ['0'],
    },
  ])('$name', async ({ publishedAfter, expectedBegins }) => {
    const tempUrl = 'https://mp.weixin.qq.com/s?tempkey=clock-skew-boundary'
    const listBegins: string[] = []
    const { runtime } = createInspectionRuntime(async (url) => {
      if (url === 'https://mp.weixin.qq.com/') {
        return new Response(authHtml('fresh-token'))
      }
      if (url.includes('/cgi-bin/appmsgpublish?')) {
        const begin = new URL(url).searchParams.get('begin') ?? ''
        listBegins.push(begin)
        return begin === '0'
          ? publishedHistoryPage(
              [{ draftMsgId: '8999', publishedAt: '2024-07-03T09:50:00.000Z' }],
              1,
            )
          : emptyPublishedListResponse()
      }
      if (url.includes('action=get_temp_url')) {
        return jsonResponse({ base_resp: { ret: 0 }, temp_url: tempUrl })
      }
      if (url === tempUrl) {
        return new Response(
          '<h1 id="activity-name">Clock skew boundary</h1><div id="js_content">Draft body</div>',
        )
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    const adapter = new WeixinAdapter()
    await adapter.init(runtime)

    const observations = await adapter.inspectPublication({
      ...INSPECT_REQUEST,
      articleHint: { ...INSPECT_REQUEST.articleHint, publishedAfter },
    })

    expect(listBegins).toEqual(expectedBegins)
    expect(observations[0]).toMatchObject({ outcome: 'DRAFT_PRESENT' })
  })

  it('requires exact current-draft membership when windowed history has no trustworthy timestamps', async () => {
    const tempUrl = 'https://mp.weixin.qq.com/s?tempkey=untimestamped-history'
    const listBegins: string[] = []
    const { runtime } = createInspectionRuntime(
      async (url) => {
        if (url === 'https://mp.weixin.qq.com/') {
          return new Response(authHtml('fresh-token'))
        }
        if (url.includes('/cgi-bin/appmsgpublish?')) {
          const begin = new URL(url).searchParams.get('begin') ?? ''
          listBegins.push(begin)
          return jsonResponse({
            base_resp: { ret: 0 },
            publish_page: {
              total_count: 100,
              publish_list: [
                { publish_info: { draft_msgid: '8999' } },
                ...Array.from({ length: 9 }, () => ({ publish_info: '' })),
              ],
            },
          })
        }
        if (url.includes('action=list_card')) {
          return jsonResponse({
            base_resp: { ret: 0 },
            app_msg_info: { item: [{ app_id: '9001' }] },
          })
        }
        if (url.includes('action=get_temp_url')) {
          return jsonResponse({ base_resp: { ret: 0 }, temp_url: tempUrl })
        }
        if (url === tempUrl) {
          return new Response(
            '<h1 id="activity-name">Untimestamped draft</h1><div id="js_content">Draft body</div>',
          )
        }
        throw new Error(`Unexpected request: ${url}`)
      },
      { defaultDraftListAppMsgId: null },
    )
    const adapter = new WeixinAdapter()
    await adapter.init(runtime)

    const observations = await adapter.inspectPublication({
      ...INSPECT_REQUEST,
      articleHint: {
        ...INSPECT_REQUEST.articleHint,
        publishedAfter: '2026-08-03T10:00:00.000Z',
      },
    })

    expect(listBegins).toEqual(['0'])
    expect(observations[0]).toMatchObject({
      outcome: 'DRAFT_PRESENT',
      source: 'DRAFT_DETAIL',
      platformPostId: '9001',
      title: 'Untimestamped draft',
    })
  })

  it('requires exact current-draft membership when timestamps reverse across pages', async () => {
    const tempUrl = 'https://mp.weixin.qq.com/s?tempkey=cross-page-order'
    const listBegins: string[] = []
    const { runtime } = createInspectionRuntime(
      async (url) => {
        if (url === 'https://mp.weixin.qq.com/') {
          return new Response(authHtml('fresh-token'))
        }
        if (url.includes('/cgi-bin/appmsgpublish?')) {
          const begin = new URL(url).searchParams.get('begin') ?? ''
          listBegins.push(begin)
          if (begin === '0') {
            return publishedHistoryPage(
              [
                { draftMsgId: '8999', publishedAt: '2024-07-03T10:00:00.000Z' },
                { draftMsgId: '8998', publishedAt: '2024-07-03T09:40:00.000Z' },
              ],
              3,
            )
          }
          if (begin === '2') {
            return publishedHistoryPage(
              [{ draftMsgId: '8997', publishedAt: '2024-07-03T09:45:00.000Z' }],
              3,
            )
          }
          return emptyPublishedListResponse()
        }
        if (url.includes('action=list_card')) {
          return jsonResponse({
            base_resp: { ret: 0 },
            app_msg_info: { item: [{ app_id: 9001 }] },
          })
        }
        if (url.includes('action=get_temp_url')) {
          return jsonResponse({ base_resp: { ret: 0 }, temp_url: tempUrl })
        }
        if (url === tempUrl) {
          return new Response(
            '<h1 id="activity-name">Cross-page order</h1><div id="js_content">Draft body</div>',
          )
        }
        throw new Error(`Unexpected request: ${url}`)
      },
      { defaultDraftListAppMsgId: null },
    )
    const adapter = new WeixinAdapter()
    await adapter.init(runtime)

    const observations = await adapter.inspectPublication({
      ...INSPECT_REQUEST,
      articleHint: {
        ...INSPECT_REQUEST.articleHint,
        publishedAfter: '2024-07-03T10:00:00.000Z',
      },
    })

    expect(listBegins).toEqual(['0', '2'])
    expect(observations[0]).toMatchObject({ outcome: 'DRAFT_PRESENT' })
  })

  it('accepts an exact published identity before applying the time cutoff', async () => {
    const publicUrl = 'https://mp.weixin.qq.com/s?__biz=MzA1AA&mid=780&idx=1'
    const listBegins: string[] = []
    const { runtime } = createInspectionRuntime(async (url) => {
      if (url === 'https://mp.weixin.qq.com/') {
        return new Response(authHtml('fresh-token'))
      }
      if (url.includes('/cgi-bin/appmsgpublish?')) {
        listBegins.push(new URL(url).searchParams.get('begin') ?? '')
        return publishedListResponse(publicUrl)
      }
      if (url === publicUrl) {
        return publicHtmlResponse(
          '<h1 id="activity-name">Exact match wins</h1><div id="js_content">Published body</div>',
          publicUrl,
        )
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    const adapter = new WeixinAdapter()
    await adapter.init(runtime)

    const observations = await adapter.inspectPublication({
      ...INSPECT_REQUEST,
      articleHint: {
        ...INSPECT_REQUEST.articleHint,
        publishedAfter: '2026-08-03T10:00:00.000Z',
      },
    })

    expect(listBegins).toEqual(['0'])
    expect(observations[0]).toMatchObject({
      outcome: 'PUBLISHED',
      source: 'PUBLIC_PAGE',
      canonicalUrl: publicUrl,
      title: 'Exact match wins',
    })
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

  it('stops an adaptive sparse-page scan as soon as the operation is aborted', async () => {
    const controller = new AbortController()
    const begins: string[] = []
    const { runtime } = createInspectionRuntime(async (url) => {
      if (url === 'https://mp.weixin.qq.com/') {
        return new Response(authHtml('fresh-token'))
      }
      if (url.includes('/cgi-bin/appmsgpublish?')) {
        const begin = new URL(url).searchParams.get('begin') ?? ''
        begins.push(begin)
        controller.abort()
        return jsonResponse({
          base_resp: { ret: 0 },
          publish_page: {
            total_count: 11,
            publish_list: [
              { publish_info: { draft_msgid: '8999' } },
              ...Array.from({ length: 9 }, () => ({ publish_info: '' })),
            ],
          },
        })
      }
      throw new Error('No request is allowed after abort')
    })
    const adapter = new WeixinAdapter()
    await adapter.init(runtime)

    await expect(
      adapter.inspectPublication(INSPECT_REQUEST, {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(begins).toEqual(['0'])
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

  it('reuses the same-operation verified account session without probing twice', async () => {
    const publicUrl = 'https://mp.weixin.qq.com/s/AaBbCcDd_456'
    const identity = derivePublicationPublicIdentity('weixin', publicUrl)
    if (!identity) throw new Error('Expected a valid WeChat public identity')
    let authCount = 0
    const { runtime } = createInspectionRuntime(async (url) => {
      if (url === 'https://mp.weixin.qq.com/') {
        authCount += 1
        return new Response(authHtml('verified-token'))
      }
      if (url === publicUrl) {
        return publicHtmlResponse(
          '<script>var ct = "1720000000"; oriCreateTime = "1720000000";</script>' +
            '<h1 id="activity-name">Verified session article</h1>' +
            '<section id="js_content"><p>Verified body.</p></section>',
          publicUrl,
        )
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    const adapter = new WeixinAdapter()
    await adapter.init(runtime)
    const verifiedAccountProbe = await adapter.probeAccounts()

    const observations = await adapter.inspectPublication(
      {
        ...INSPECT_REQUEST,
        knownPublicLocator: {
          publicUrl: identity.canonicalUrl,
          publicIdentityKey: identity.key,
        },
      },
      { verifiedAccountProbe },
    )

    expect(authCount).toBe(1)
    expect(observations[0]).toMatchObject({
      outcome: 'PUBLISHED',
      source: 'PUBLIC_PAGE',
      canonicalUrl: publicUrl,
    })
  })

  it('refreshes authentication when verified account evidence does not match', async () => {
    const publicUrl = 'https://mp.weixin.qq.com/s/AaBbCcDd_789'
    const identity = derivePublicationPublicIdentity('weixin', publicUrl)
    if (!identity) throw new Error('Expected a valid WeChat public identity')
    let authCount = 0
    const { runtime } = createInspectionRuntime(async (url) => {
      if (url === 'https://mp.weixin.qq.com/') {
        authCount += 1
        return new Response(authHtml(`fresh-token-${authCount}`))
      }
      if (url === publicUrl) {
        return publicHtmlResponse(
          '<script>var ct = "1720000000"; oriCreateTime = "1720000000";</script>' +
            '<h1 id="activity-name">Refreshed session article</h1>' +
            '<section id="js_content"><p>Verified body.</p></section>',
          publicUrl,
        )
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    const adapter = new WeixinAdapter()
    await adapter.init(runtime)
    await adapter.probeAccounts()

    const observations = await adapter.inspectPublication(
      {
        ...INSPECT_REQUEST,
        knownPublicLocator: {
          publicUrl: identity.canonicalUrl,
          publicIdentityKey: identity.key,
        },
      },
      {
        verifiedAccountProbe: {
          status: 'AUTHENTICATED',
          accounts: [{ externalAccountId: 'gh_different_account' }],
        },
      },
    )

    expect(authCount).toBe(2)
    expect(observations[0]).toMatchObject({ outcome: 'PUBLISHED' })
  })

  it('returns an explicit review result before a published scan exhausts its adapter deadline', async () => {
    vi.useFakeTimers()
    try {
      let publishedSignal: AbortSignal | undefined
      const { runtime } = createInspectionRuntime(async (url, options) => {
        if (url === 'https://mp.weixin.qq.com/') {
          return new Response(authHtml('fresh-token'))
        }
        if (url.includes('/cgi-bin/appmsgpublish?')) {
          publishedSignal = options?.signal as AbortSignal | undefined
          return new Promise<Response>((_resolve, reject) => {
            publishedSignal?.addEventListener(
              'abort',
              () => reject(publishedSignal?.reason),
              { once: true },
            )
          })
        }
        throw new Error(`Unexpected request: ${url}`)
      })
      const adapter = new WeixinAdapter()
      await adapter.init(runtime)
      const pending = adapter.inspectPublication(INSPECT_REQUEST, {
        deadlineAt: Date.now() + 10_000,
      })

      await vi.advanceTimersByTimeAsync(1_999)
      let settled = false
      void pending.then(() => {
        settled = true
      })
      await Promise.resolve()
      expect(settled).toBe(false)

      await vi.advanceTimersByTimeAsync(1)
      await expect(pending).resolves.toEqual([
        expect.objectContaining({
          outcome: 'REVIEW_REQUIRED',
          source: 'PUBLISHED_LIST',
          errorCode: 'WEIXIN_PUBLISHED_SCAN_DEADLINE',
        }),
      ])
      expect(publishedSignal?.aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
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
    const publicUrl = 'https://mp.weixin.qq.com/s?__biz=MzA1AA&mid=777&idx=1'
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
        publicAccess: {
          status: 'CONFIRMED',
          checkedUrl: publicUrl,
          checkedPublicIdentityKey: 'weixin:article:v1:MzA1AA:777:1',
          checkedAt: expect.any(String),
          httpStatus: 200,
        },
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

  it('advances mixed published-list pages by materialized records without skipping the target', async () => {
    const publicUrl = 'https://mp.weixin.qq.com/s?__biz=MzA1AA&mid=778&idx=1'
    const begins: string[] = []
    const { runtime } = createInspectionRuntime(async (url) => {
      if (url === 'https://mp.weixin.qq.com/') {
        return new Response(authHtml('fresh-token'))
      }
      if (url.includes('/cgi-bin/appmsgpublish?')) {
        const begin = new URL(url).searchParams.get('begin') ?? ''
        begins.push(begin)
        if (begin === '0') {
          return jsonResponse({
            base_resp: { ret: 0 },
            publish_page: {
              total_count: 2,
              publish_list: [
                { publish_info: { draft_msgid: '8999' } },
                ...Array.from({ length: 9 }, () => ({ publish_info: '' })),
              ],
            },
          })
        }
        if (begin === '1') return publishedListResponse(publicUrl)
      }
      if (url === publicUrl) {
        return publicHtmlResponse(
          '<h1 id="activity-name">Published after mixed page</h1>' +
            '<section id="js_content"><p>Published body</p></section>',
          publicUrl,
        )
      }
      throw new Error('Unexpected request')
    })
    const adapter = new WeixinAdapter()
    await adapter.init(runtime)

    const observations = await adapter.inspectPublication(INSPECT_REQUEST)

    expect(begins).toEqual(['0', '1'])
    expect(observations[0]).toMatchObject({
      outcome: 'PUBLISHED',
      source: 'PUBLIC_PAGE',
      platformPostId: '9001',
      canonicalUrl: publicUrl,
      title: 'Published after mixed page',
    })
  })

  it('uses the reported record count to scan beyond five sparse pages before falling back to draft detail', async () => {
    const tempUrl = 'https://mp.weixin.qq.com/s?tempkey=sparse-pages'
    const begins: string[] = []
    const { runtime } = createInspectionRuntime(async (url) => {
      if (url === 'https://mp.weixin.qq.com/') {
        return new Response(authHtml('fresh-token'))
      }
      if (url.includes('/cgi-bin/appmsgpublish?')) {
        const begin = Number(new URL(url).searchParams.get('begin'))
        begins.push(String(begin))
        if (begin >= 11) {
          return jsonResponse({
            base_resp: { ret: 0 },
            publish_page: {
              total_count: 11,
              publish_list: Array.from({ length: 10 }, () => ({
                publish_info: '',
              })),
            },
          })
        }
        return jsonResponse({
          base_resp: { ret: 0 },
          publish_page: {
            total_count: 11,
            publish_list: [
              { publish_info: { draft_msgid: String(8_000 + begin) } },
              ...Array.from({ length: 9 }, () => ({ publish_info: '' })),
            ],
          },
        })
      }
      if (url.includes('action=get_temp_url')) {
        return jsonResponse({ base_resp: { ret: 0 }, temp_url: tempUrl })
      }
      if (url === tempUrl) {
        return new Response(
          '<h1 id="activity-name">Sparse page draft</h1>' +
            '<section id="js_content">Draft body</section>',
        )
      }
      throw new Error('Unexpected request')
    })
    const adapter = new WeixinAdapter()
    await adapter.init(runtime)

    const observations = await adapter.inspectPublication(INSPECT_REQUEST)

    expect(begins).toEqual(
      Array.from({ length: 12 }, (_, index) => String(index)),
    )
    expect(observations[0]).toMatchObject({
      outcome: 'DRAFT_PRESENT',
      source: 'DRAFT_DETAIL',
      platformPostId: '9001',
      title: 'Sparse page draft',
    })
  })

  it('rechecks the advisory boundary and observes a target added while scanning', async () => {
    const publicUrl = 'https://mp.weixin.qq.com/s?__biz=MzA1AA&mid=779&idx=1'
    const begins: string[] = []
    const { runtime } = createInspectionRuntime(async (url) => {
      if (url === 'https://mp.weixin.qq.com/') {
        return new Response(authHtml('fresh-token'))
      }
      if (url.includes('/cgi-bin/appmsgpublish?')) {
        const begin = Number(new URL(url).searchParams.get('begin'))
        begins.push(String(begin))
        if (begin === 6) return publishedListResponse(publicUrl)
        return jsonResponse({
          base_resp: { ret: 0 },
          publish_page: {
            total_count: 6,
            publish_list: [
              { publish_info: { draft_msgid: String(8_500 + begin) } },
              ...Array.from({ length: 9 }, () => ({ publish_info: '' })),
            ],
          },
        })
      }
      if (url === publicUrl) {
        return publicHtmlResponse(
          '<h1 id="activity-name">Published during scan</h1>' +
            '<section id="js_content">Published body</section>',
          publicUrl,
        )
      }
      throw new Error('Draft fallback must not run')
    })
    const adapter = new WeixinAdapter()
    await adapter.init(runtime)

    const observations = await adapter.inspectPublication(INSPECT_REQUEST)

    expect(begins).toEqual(['0', '1', '2', '3', '4', '5', '6'])
    expect(observations[0]).toMatchObject({
      outcome: 'PUBLISHED',
      source: 'PUBLIC_PAGE',
      canonicalUrl: publicUrl,
      title: 'Published during scan',
    })
  })

  it('accepts an empty publish_info sentinel only with exact inline identity and evidence', async () => {
    const publicUrl = 'https://mp.weixin.qq.com/s?__biz=MzA1AA&mid=777&idx=1'
    const calls: string[] = []
    const { runtime } = createInspectionRuntime(async (url) => {
      calls.push(url)
      if (url === 'https://mp.weixin.qq.com/') {
        return new Response(authHtml('fresh-token'))
      }
      if (url.includes('/cgi-bin/appmsgpublish?')) {
        return jsonResponse({
          base_resp: { ret: 0 },
          publish_page: {
            total_count: 1,
            publish_list: [
              {
                publish_info: '',
                draft_msgid: '9001',
                publish_status: 200,
                create_time: 1_720_000_000,
                appmsgex: [{ itemidx: 1, content_url: publicUrl }],
              },
            ],
          },
        })
      }
      if (url === publicUrl) {
        return publicHtmlResponse(
          '<h1 id="activity-name">Published title</h1>' +
            '<section id="js_content">Published body</section>',
          publicUrl,
        )
      }
      throw new Error('Draft fallback must not run')
    })
    const adapter = new WeixinAdapter()
    await adapter.init(runtime)

    const observations = await adapter.inspectPublication(INSPECT_REQUEST)

    expect(observations[0]).toMatchObject({
      outcome: 'PUBLISHED',
      source: 'PUBLIC_PAGE',
      platformPostId: '9001',
      canonicalUrl: publicUrl,
      title: 'Published title',
      bodyText: 'Published body',
    })
    expect(calls).toEqual([
      'https://mp.weixin.qq.com/',
      expect.stringContaining('/cgi-bin/appmsgpublish?'),
      publicUrl,
    ])
  })

  it('verifies a direct short public URL with a decoded body between 2 and 4 MiB', async () => {
    const shortUrl = 'https://mp.weixin.qq.com/s/ShortAbC_123'
    const calls: Array<{ url: string; options?: RequestInit }> = []
    const { runtime } = createInspectionRuntime(async (url, options) => {
      calls.push({ url, options })
      if (url === 'https://mp.weixin.qq.com/') {
        return new Response(authHtml('fresh-token'))
      }
      if (url.includes('/cgi-bin/appmsgpublish?')) {
        return publishedListResponse(shortUrl)
      }
      if (url === shortUrl) {
        return publicHtmlResponse(
          '<h1 id="activity-name">Published title</h1>' +
            `<section id="js_content">${'x'.repeat(3 * 1024 * 1024)}</section>`,
          shortUrl,
        )
      }
      throw new Error('Draft fallback must not run')
    })
    const adapter = new WeixinAdapter()
    await adapter.init(runtime)

    const observations = await adapter.inspectPublication(INSPECT_REQUEST)

    expect(observations[0]).toMatchObject({
      outcome: 'PUBLISHED',
      source: 'PUBLIC_PAGE',
      platformPostId: '9001',
      canonicalUrl: shortUrl,
      title: 'Published title',
      bodyTruncated: true,
      publicAccess: {
        status: 'CONFIRMED',
        checkedUrl: shortUrl,
        checkedPublicIdentityKey: 'weixin:short:v1:ShortAbC_123',
        checkedAt: expect.any(String),
        httpStatus: 200,
      },
    })
    expect(calls.map(({ url }) => url)).toEqual([
      'https://mp.weixin.qq.com/',
      expect.stringContaining('/cgi-bin/appmsgpublish?'),
      shortUrl,
    ])
    expect(calls[2]?.options).toMatchObject({
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
    })
  })

  it('fails closed if a runtime exposes an opaque manual redirect response', async () => {
    const publicUrl = 'https://mp.weixin.qq.com/s?__biz=MzA1AA&mid=777&idx=1'
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
    const publicUrl = 'https://mp.weixin.qq.com/s?__biz=MzA1AA&mid=777&idx=1'
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
          {
            contentType: 'application/json',
          },
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
    const publicUrl = 'https://mp.weixin.qq.com/s?__biz=MzA1AA&mid=777&idx=1'
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
      canonicalUrl: 'https://mp.weixin.qq.com/s?__biz=MzA1AA&mid=777&idx=1',
      title: 'Published title',
      publishedAt: '2024-07-03T09:46:40.000Z',
      bodyText: 'Published body',
      bodyTruncated: false,
      publicAccess: {
        status: 'CONFIRMED',
        checkedUrl: 'https://mp.weixin.qq.com/s?__biz=MzA1AA&mid=777&idx=1',
        checkedPublicIdentityKey: 'weixin:article:v1:MzA1AA:777:1',
        checkedAt: '2024-07-03T09:46:50.000Z',
        httpStatus: 200,
      },
      observedAt: '2024-07-03T09:47:00.000Z',
    }

    expect(
      adapter.provePublishedObservation(INSPECT_REQUEST, validObservation),
    ).toEqual({
      observedAuthorExternalAccountId: ACCOUNT_ID,
      publicAccess: validObservation.publicAccess,
      bodyTruncated: false,
    })

    const validShortObservation: PublicationObservation = {
      ...validObservation,
      canonicalUrl: 'https://mp.weixin.qq.com/s/ShortAbC_123',
      publicAccess: {
        ...validObservation.publicAccess,
        checkedUrl: 'https://mp.weixin.qq.com/s/ShortAbC_123',
        checkedPublicIdentityKey: 'weixin:short:v1:ShortAbC_123',
      },
    }
    expect(
      adapter.provePublishedObservation(INSPECT_REQUEST, validShortObservation),
    ).toEqual({
      observedAuthorExternalAccountId: ACCOUNT_ID,
      publicAccess: validShortObservation.publicAccess,
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
        ...validShortObservation,
        publicAccess: {
          ...validShortObservation.publicAccess,
          checkedPublicIdentityKey: 'weixin:short:v1:Different_123',
        },
      },
      {
        ...validShortObservation,
        publicAccess: {
          ...validShortObservation.publicAccess,
          checkedUrl: 'https://mp.weixin.qq.com/s/Different_123',
        },
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
                        'https://mp.weixin.qq.com/s?__biz=MzA1AA&mid=777&idx=1',
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
    const publicUrl = 'https://mp.weixin.qq.com/s?__biz=MzA1AA&mid=777&idx=1'
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
    expect(JSON.stringify(observations)).not.toContain('MzA1AA')
  })

  it('requires review when the published-list response cannot be parsed', async () => {
    const { runtime } = createInspectionRuntime(async (url) => {
      if (url === 'https://mp.weixin.qq.com/') {
        return new Response(authHtml('fresh-token'))
      }
      if (url.includes('/cgi-bin/appmsgpublish?')) {
        return new Response('<html>secret-account-title-url-token</html>', {
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        })
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
        errorCode: 'WEIXIN_PUBLISHED_LIST_JSON_INVALID',
        errorMessage: expect.stringContaining(
          'wx-list-shape:v1;response_body=invalid-json;content_type=html',
        ),
      }),
    ])
    expect(JSON.stringify(observations)).not.toContain(
      'secret-account-title-url-token',
    )
    const observation = observations[0]
    expect(observation).not.toHaveProperty('canonicalUrl')
    expect(observation).not.toHaveProperty('title')
    expect(observation).not.toHaveProperty('bodyText')
  })

  it.each([
    {
      name: 'exceeds the decoded byte limit',
      response: () =>
        new Response('', {
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': String(WEIXIN_PUBLISHED_LIST_MAX_BYTES + 1),
          },
        }),
      errorCode: 'WEIXIN_PUBLISHED_LIST_BODY_TOO_LARGE',
      fingerprint: 'wx-list-shape:v1;response_body=too-large;content_type=json',
    },
    {
      name: 'has no readable body',
      response: () =>
        new Response(null, { headers: { 'Content-Type': 'application/json' } }),
      errorCode: 'WEIXIN_PUBLISHED_LIST_BODY_READ_ERROR',
      fingerprint: 'wx-list-shape:v1;response_body=missing;content_type=json',
    },
  ])(
    'returns a bounded diagnostic when the published-list response $name',
    async ({ response, errorCode, fingerprint }) => {
      const { runtime } = createInspectionRuntime(async (url) => {
        if (url === 'https://mp.weixin.qq.com/') {
          return new Response(authHtml('fresh-token'))
        }
        if (url.includes('/cgi-bin/appmsgpublish?')) return response()
        throw new Error('No fallback request is allowed')
      })
      const adapter = new WeixinAdapter()
      await adapter.init(runtime)

      const observations = await adapter.inspectPublication(INSPECT_REQUEST)

      expect(observations[0]).toMatchObject({
        outcome: 'REVIEW_REQUIRED',
        source: 'PUBLISHED_LIST',
        platformPostId: '9001',
        errorCode,
        errorMessage: expect.stringContaining(fingerprint),
      })
      expect(runtime.fetch).toHaveBeenCalledTimes(2)
    },
  )

  it.each([
    {
      name: 'request failure',
      response: () => {
        throw new Error('secret request URL')
      },
      errorCode: 'WEIXIN_PUBLISHED_LIST_FETCH_ERROR',
      fingerprint: undefined,
    },
    {
      name: 'HTTP failure',
      response: () => new Response('', { status: 503 }),
      errorCode: 'WEIXIN_PUBLISHED_LIST_FETCH_ERROR',
      fingerprint: undefined,
    },
    {
      name: 'response-shape failure',
      response: () =>
        jsonResponse({
          base_resp: { ret: 0 },
          publish_page: {
            publish_list: 'secret-account-title-url-token',
          },
        }),
      errorCode: 'WEIXIN_PUBLISHED_LIST_PUBLISH_LIST_INVALID',
      fingerprint:
        'wx-list-shape:v1;publish_page.publish_list=string:invalid-json',
    },
    {
      name: 'record parse failure',
      response: () =>
        jsonResponse({
          base_resp: { ret: 0 },
          publish_page: {
            total_count: 1,
            publish_list: [{ publish_info: '{secret-account-title-url-token' }],
          },
        }),
      errorCode: 'WEIXIN_PUBLISHED_LIST_PUBLISH_INFO_INVALID',
      fingerprint: 'wx-list-shape:v1;publish_info=string:invalid-json',
    },
  ])(
    'requires review without leaking fields after a published-list $name',
    async ({ response, errorCode, fingerprint }) => {
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
      if (fingerprint) {
        expect(observations[0]?.errorMessage).toContain(fingerprint)
      }
      expect(JSON.stringify(observations)).not.toContain('secret request URL')
      expect(JSON.stringify(observations)).not.toContain(
        'secret-account-title-url-token',
      )
      expect(runtime.fetch).toHaveBeenCalledTimes(2)
    },
  )

  it('fails closed when the first record beyond the record cap matches the target', async () => {
    const publicUrl = 'https://mp.weixin.qq.com/s/record-101-must-not-open'
    const begins: string[] = []
    const { runtime } = createInspectionRuntime(async (url) => {
      if (url === 'https://mp.weixin.qq.com/') {
        return new Response(authHtml('fresh-token'))
      }
      if (url.includes('/cgi-bin/appmsgpublish?')) {
        const begin = Number(new URL(url).searchParams.get('begin'))
        begins.push(String(begin))
        if (begin === 100) {
          return jsonResponse({
            publish_page: {
              total_count: 100,
              publish_list: [
                {
                  publish_info: {
                    draft_msgid: '9001',
                    publish_status: 200,
                    create_time: 1_720_000_000,
                    appmsgex: [{ itemidx: 1, content_url: publicUrl }],
                  },
                },
              ],
            },
          })
        }
        return jsonResponse({
          publish_page: {
            total_count: 100,
            publish_list: Array.from({ length: 10 }, (_, index) => ({
              publish_info: {
                draft_msgid: String(10_000 + begin + index),
                publish_status: 200,
              },
            })),
          },
        })
      }
      throw new Error('Public-page and draft fallback must not run')
    })
    const adapter = new WeixinAdapter()
    await adapter.init(runtime)

    const observations = await adapter.inspectPublication(INSPECT_REQUEST)

    expect(begins).toEqual(
      Array.from({ length: 11 }, (_, index) => String(index * 10)),
    )
    expect(observations[0]).toMatchObject({
      outcome: 'REVIEW_REQUIRED',
      source: 'PUBLISHED_LIST',
      errorCode: 'WEIXIN_PUBLISHED_SCAN_INCOMPLETE',
    })
    expect(runtime.fetch).not.toHaveBeenCalledWith(publicUrl, expect.anything())
  })

  it('allows draft fallback after exactly 100 records and an empty sentinel', async () => {
    const tempUrl = 'https://mp.weixin.qq.com/s?tempkey=record-cap-sentinel'
    const begins: string[] = []
    const { runtime } = createInspectionRuntime(async (url) => {
      if (url === 'https://mp.weixin.qq.com/') {
        return new Response(authHtml('fresh-token'))
      }
      if (url.includes('/cgi-bin/appmsgpublish?')) {
        const begin = Number(new URL(url).searchParams.get('begin'))
        begins.push(String(begin))
        if (begin === 100) {
          return jsonResponse({
            publish_page: {
              total_count: 100,
              publish_list: Array.from({ length: 10 }, () => ({
                publish_info: '',
              })),
            },
          })
        }
        return jsonResponse({
          publish_page: {
            total_count: 100,
            publish_list: Array.from({ length: 10 }, (_, index) => ({
              publish_info: {
                draft_msgid: String(11_000 + begin + index),
                publish_status: 200,
              },
            })),
          },
        })
      }
      if (url.includes('action=get_temp_url')) {
        return jsonResponse({ base_resp: { ret: 0 }, temp_url: tempUrl })
      }
      if (url === tempUrl) {
        return new Response(
          '<h1 id="activity-name">Record cap draft</h1>' +
            '<section id="js_content">Draft body</section>',
        )
      }
      throw new Error('Unexpected request')
    })
    const adapter = new WeixinAdapter()
    await adapter.init(runtime)

    const observations = await adapter.inspectPublication(INSPECT_REQUEST)

    expect(begins).toEqual(
      Array.from({ length: 11 }, (_, index) => String(index * 10)),
    )
    expect(observations[0]).toMatchObject({
      outcome: 'DRAFT_PRESENT',
      source: 'DRAFT_DETAIL',
      title: 'Record cap draft',
    })
  })

  it('allows draft fallback when the twentieth request is an empty sentinel', async () => {
    const tempUrl = 'https://mp.weixin.qq.com/s?tempkey=request-cap-sentinel'
    const begins: string[] = []
    const { runtime } = createInspectionRuntime(async (url) => {
      if (url === 'https://mp.weixin.qq.com/') {
        return new Response(authHtml('fresh-token'))
      }
      if (url.includes('/cgi-bin/appmsgpublish?')) {
        const begin = Number(new URL(url).searchParams.get('begin'))
        begins.push(String(begin))
        return jsonResponse({
          publish_page: {
            total_count: 19,
            publish_list:
              begin === 19
                ? Array.from({ length: 10 }, () => ({ publish_info: '' }))
                : [
                    {
                      publish_info: {
                        draft_msgid: String(12_000 + begin),
                        publish_status: 200,
                      },
                    },
                    ...Array.from({ length: 9 }, () => ({
                      publish_info: '',
                    })),
                  ],
          },
        })
      }
      if (url.includes('action=get_temp_url')) {
        return jsonResponse({ base_resp: { ret: 0 }, temp_url: tempUrl })
      }
      if (url === tempUrl) {
        return new Response(
          '<h1 id="activity-name">Request cap draft</h1>' +
            '<section id="js_content">Draft body</section>',
        )
      }
      throw new Error('Unexpected request')
    })
    const adapter = new WeixinAdapter()
    await adapter.init(runtime)

    const observations = await adapter.inspectPublication(INSPECT_REQUEST)

    expect(begins).toEqual(
      Array.from({ length: 20 }, (_, index) => String(index)),
    )
    expect(observations[0]).toMatchObject({
      outcome: 'DRAFT_PRESENT',
      source: 'DRAFT_DETAIL',
      title: 'Request cap draft',
    })
  })

  it('requires review when the twentieth request still has a materialized record', async () => {
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
            publish_list: [
              {
                publish_info: {
                  draft_msgid: String(
                    Number(parsed.searchParams.get('begin')) + 1,
                  ),
                  publish_status: 200,
                },
              },
              ...Array.from({ length: 9 }, () => ({ publish_info: '' })),
            ],
          },
        })
      }
      throw new Error('Unexpected request')
    })
    const adapter = new WeixinAdapter()
    await adapter.init(runtime)

    const observations = await adapter.inspectPublication(INSPECT_REQUEST)

    expect(begins).toEqual(
      Array.from({ length: 20 }, (_, index) => String(index)),
    )
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

  it('treats a reported count above the cap as advisory and finds an early target', async () => {
    const publicUrl = 'https://mp.weixin.qq.com/s/high-count-early-target'
    const begins: string[] = []
    const { runtime } = createInspectionRuntime(async (url) => {
      if (url === 'https://mp.weixin.qq.com/') {
        return new Response(authHtml('fresh-token'))
      }
      if (url.includes('/cgi-bin/appmsgpublish?')) {
        const begin = new URL(url).searchParams.get('begin') ?? ''
        begins.push(begin)
        if (begin === '1') return publishedListResponse(publicUrl)
        return jsonResponse({
          publish_page: {
            total_count: 101,
            publish_list: [
              { publish_info: { draft_msgid: '8999', publish_status: 200 } },
            ],
          },
        })
      }
      if (url === publicUrl) {
        return publicHtmlResponse(
          '<h1 id="activity-name">High count target</h1>' +
            '<section id="js_content">Published body</section>',
          publicUrl,
        )
      }
      throw new Error('Unexpected request')
    })
    const adapter = new WeixinAdapter()
    await adapter.init(runtime)

    const observations = await adapter.inspectPublication(INSPECT_REQUEST)

    expect(begins).toEqual(['0', '1'])
    expect(observations[0]).toMatchObject({
      outcome: 'PUBLISHED',
      source: 'PUBLIC_PAGE',
      canonicalUrl: publicUrl,
      title: 'High count target',
    })
  })

  it('allows an empty sentinel even when the reported count exceeds the cap', async () => {
    const tempUrl = 'https://mp.weixin.qq.com/s?tempkey=high-count-sentinel'
    const begins: string[] = []
    const { runtime } = createInspectionRuntime(async (url) => {
      if (url === 'https://mp.weixin.qq.com/') {
        return new Response(authHtml('fresh-token'))
      }
      if (url.includes('/cgi-bin/appmsgpublish?')) {
        const begin = new URL(url).searchParams.get('begin') ?? ''
        begins.push(begin)
        return jsonResponse({
          publish_page: {
            total_count: 101,
            publish_list:
              begin === '0'
                ? [
                    {
                      publish_info: {
                        draft_msgid: '8999',
                        publish_status: 200,
                      },
                    },
                  ]
                : Array.from({ length: 10 }, () => ({ publish_info: '' })),
          },
        })
      }
      if (url.includes('action=get_temp_url')) {
        return jsonResponse({ base_resp: { ret: 0 }, temp_url: tempUrl })
      }
      if (url === tempUrl) {
        return new Response(
          '<h1 id="activity-name">High count draft</h1>' +
            '<section id="js_content">Draft body</section>',
        )
      }
      throw new Error('Unexpected request')
    })
    const adapter = new WeixinAdapter()
    await adapter.init(runtime)

    const observations = await adapter.inspectPublication(INSPECT_REQUEST)

    expect(begins).toEqual(['0', '1'])
    expect(observations[0]).toMatchObject({
      outcome: 'DRAFT_PRESENT',
      source: 'DRAFT_DETAIL',
      title: 'High count draft',
    })
  })

  it.each([
    {
      tempUrl: 'https://attacker.example/s?tempkey=must-not-leak',
      page: '<h1 id="activity-name">Title</h1><div id="js_content">Body</div>',
      errorCode: 'WEIXIN_TEMP_URL_HOST_MISMATCH',
      expectedFetchCount: 5,
      outcome: 'PARSE_ERROR',
    },
    {
      tempUrl: 'https://mp.weixin.qq.com/s?tempkey=memory-only',
      page: '<main>changed page structure</main>',
      errorCode: 'WEIXIN_DRAFT_STATE_REVIEW_REQUIRED',
      expectedFetchCount: 6,
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
