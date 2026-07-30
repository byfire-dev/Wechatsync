import { describe, expect, it, vi } from 'vitest'
import type { PublicationInspectRequest } from '../types'
import {
  inspectSohuPublication,
  parseSohuPublishedArticleEvidence,
  type SohuInspectionDependencies,
} from '../sohu'

const POST_ID = '1054312481'
const ACCOUNT_ID = '120219780'
const NOW = '2026-07-24T17:00:00+08:00'
const PUBLISHED_AT = '2026-07-24T08:40:14.000Z'
const PUBLIC_URL = `https://www.sohu.com/a/${POST_ID}_${ACCOUNT_ID}`
const DRAFT_URL =
  `https://mp.sohu.com/mpfe/v4/contentManagement/news/addarticle` +
  `?id=${POST_ID}&accountId=${ACCOUNT_ID}`
const DETAIL_URL =
  `https://mp.sohu.com/mpbp/bp/news/v4/article` +
  `?newsId=${POST_ID}&accountId=${ACCOUNT_ID}`

function createRequest(
  overrides: Partial<PublicationInspectRequest> = {},
): PublicationInspectRequest {
  return {
    requestId: 'request-sohu-1',
    platform: 'sohu',
    externalAccountId: ACCOUNT_ID,
    draft: {
      platformPostId: POST_ID,
      draftUrl: DRAFT_URL,
      draftedAt: '2026-07-23T10:00:00+08:00',
    },
    articleHint: { title: '投递时的标题' },
    limit: 20,
    ...overrides,
  }
}

function jsonResponse(
  status: number,
  url: string,
  payload: unknown,
  contentType = 'application/json; charset=utf-8',
): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    url,
    headers: new Headers({ 'content-type': contentType }),
    json: async () => payload,
  } as Response
}

function htmlResponse(
  status: number,
  url: string,
  body = '',
  contentType = 'text/html; charset=utf-8',
): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    url,
    headers: new Headers({ 'content-type': contentType }),
    text: async () => body,
  } as Response
}

function detailPayload(
  status: number,
  overrides: Record<string, unknown> = {},
): unknown {
  return {
    code: 2_000_000,
    data: {
      news: {
        id: Number(POST_ID),
        userId: Number(ACCOUNT_ID),
        status,
        title: '平台详情标题',
        content: '<p>平台详情正文</p>',
        ...overrides,
      },
    },
  }
}

function publishedHtml(
  options: {
    canonicalUrl?: string
    ogUrl?: string
    articleUrl?: string
    mainEntityUrl?: string
    newsId?: string
    mediaId?: string
    displayMode?: string
    headline?: string
    publishedAt?: string
    body?: string
    extraHead?: string
    extraBody?: string
  } = {},
): string {
  const canonicalUrl = options.canonicalUrl ?? PUBLIC_URL
  const ogUrl = options.ogUrl ?? PUBLIC_URL.replace(/^https:\/\//, '')
  const articleUrl = options.articleUrl ?? PUBLIC_URL
  const mainEntityUrl = options.mainEntityUrl ?? PUBLIC_URL
  const newsId = options.newsId ?? POST_ID
  const mediaId = options.mediaId ?? ACCOUNT_ID
  const displayMode = options.displayMode ?? '0'
  const headline = options.headline ?? '公开页修改后的标题'
  const datePublished = options.publishedAt ?? '2026-07-24T16:40:14+0800'
  const body = options.body ?? '<p>第一段</p><p>第二段 &amp; 证据</p>'

  return `
    <html>
      <head>
        <link rel="canonical" href="${canonicalUrl}">
        <meta property="og:url" content="${ogUrl}">
        <script type="application/ld+json">${JSON.stringify({
          '@context': 'https://schema.org',
          '@graph': [
            {
              '@type': 'BreadcrumbList',
              itemListElement: [],
            },
            {
              '@type': 'NewsArticle',
              headline,
              datePublished,
              url: articleUrl,
              mainEntityOfPage: {
                '@type': 'WebPage',
                '@id': mainEntityUrl,
              },
            },
          ],
        })}</script>
        ${options.extraHead ?? ''}
      </head>
      <body>
        <article class="article" id="mp-editor">${body}</article>
        <script>
          var cfgs = {
            news_id: "${newsId}",
            media_id: "${mediaId}",
            displayMode: "${displayMode}",
          }
        </script>
        ${options.extraBody ?? ''}
      </body>
    </html>
  `
}

function createDependencies(
  fetchImpl: SohuInspectionDependencies['fetch'],
  auth: Awaited<ReturnType<SohuInspectionDependencies['checkAuth']>> = {
    isAuthenticated: true,
    userId: ACCOUNT_ID,
  },
): SohuInspectionDependencies {
  return {
    checkAuth: vi.fn().mockResolvedValue(auth),
    fetch: fetchImpl,
    detailHeaders: () => ({
      'dv-id': 'device-id',
      'sp-cm': 'session-proof',
    }),
    now: () => NOW,
  }
}

describe('Sohu public publication evidence', () => {
  it('requires all independent public identity and content evidence', () => {
    expect(
      parseSohuPublishedArticleEvidence(publishedHtml(), POST_ID, ACCOUNT_ID),
    ).toEqual({
      success: true,
      evidence: {
        title: '公开页修改后的标题',
        publishedAt: PUBLISHED_AT,
        bodyText: '第一段\n第二段 & 证据',
        bodyTruncated: false,
      },
    })
  })

  it.each([
    [
      'a different canonical article',
      publishedHtml({
        canonicalUrl: `https://www.sohu.com/a/999_${ACCOUNT_ID}`,
      }),
      'IDENTITY_METADATA_MISMATCH',
    ],
    [
      'a different JSON-LD account',
      publishedHtml({
        articleUrl: `https://www.sohu.com/a/${POST_ID}_999`,
      }),
      'NEWS_ARTICLE_IDENTITY_MISMATCH',
    ],
    [
      'a different cfgs news ID',
      publishedHtml({ newsId: '999' }),
      'CFGS_IDENTITY_MISMATCH',
    ],
    [
      'a login-only display mode',
      publishedHtml({ displayMode: '2' }),
      'DISPLAY_MODE_RESTRICTED',
    ],
    [
      'an invalid publication timestamp',
      publishedHtml({ publishedAt: '2026-07-24' }),
      'NEWS_ARTICLE_PAYLOAD_INVALID',
    ],
    [
      'an empty article body',
      publishedHtml({ body: '<p><br></p>' }),
      'ARTICLE_BODY_EMPTY',
    ],
  ])('fails closed for %s', (_name, html, reason) => {
    expect(
      parseSohuPublishedArticleEvidence(html, POST_ID, ACCOUNT_ID),
    ).toEqual({ success: false, reason })
  })

  it('rejects duplicate identity-bearing evidence', () => {
    const html = publishedHtml({
      extraHead: `<link rel="canonical" href="${PUBLIC_URL}">`,
    })

    expect(
      parseSohuPublishedArticleEvidence(html, POST_ID, ACCOUNT_ID),
    ).toEqual({
      success: false,
      reason: 'IDENTITY_METADATA_DUPLICATE',
    })
  })
})

describe('Sohu exact-ID publication inspector', () => {
  it('rejects conflicting exact IDs before checking authentication', async () => {
    const dependencies = createDependencies(vi.fn())
    const result = await inspectSohuPublication(
      createRequest({
        draft: {
          platformPostId: POST_ID,
          draftUrl:
            'https://mp.sohu.com/mpfe/v4/contentManagement/news/addarticle?id=999',
          draftedAt: '2026-07-23T10:00:00+08:00',
        },
      }),
      dependencies,
    )

    expect(result[0]).toMatchObject({
      outcome: 'PARSE_ERROR',
      errorCode: 'SOHU_POST_ID_CONFLICT',
    })
    expect(dependencies.checkAuth).not.toHaveBeenCalled()
  })

  it('rejects a draft URL bound to another account', async () => {
    const dependencies = createDependencies(vi.fn())
    const result = await inspectSohuPublication(
      createRequest({
        draft: {
          platformPostId: POST_ID,
          draftUrl:
            `https://mp.sohu.com/mpfe/v4/contentManagement/news/addarticle` +
            `?id=${POST_ID}&accountId=999`,
          draftedAt: '2026-07-23T10:00:00+08:00',
        },
      }),
      dependencies,
    )

    expect(result[0]).toMatchObject({
      outcome: 'PARSE_ERROR',
      errorCode: 'SOHU_DRAFT_ACCOUNT_ID_CONFLICT',
    })
  })

  it('requires the active account to match the bound stable ID', async () => {
    const dependencies = createDependencies(vi.fn(), {
      isAuthenticated: true,
      userId: '999',
    })

    const result = await inspectSohuPublication(createRequest(), dependencies)

    expect(result[0]).toMatchObject({
      outcome: 'ACCOUNT_MISMATCH',
      errorCode: 'ACCOUNT_MISMATCH',
      platformPostId: POST_ID,
    })
    expect(dependencies.fetch).not.toHaveBeenCalled()
  })

  it('maps business code 1211 to LOGIN_REQUIRED', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, DETAIL_URL, { code: 1_211 }))

    const result = await inspectSohuPublication(
      createRequest(),
      createDependencies(fetch),
    )

    expect(result[0]).toMatchObject({
      outcome: 'LOGIN_REQUIRED',
      errorCode: 'SOHU_LOGIN_REQUIRED',
      source: 'PLATFORM_DETAIL',
    })
  })

  it('sends the exact news/account locator with authenticated detail headers', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, DETAIL_URL, detailPayload(1)))

    await inspectSohuPublication(createRequest(), createDependencies(fetch))

    expect(fetch).toHaveBeenCalledOnce()
    expect(fetch).toHaveBeenCalledWith(
      DETAIL_URL,
      expect.objectContaining({
        method: 'GET',
        credentials: 'include',
        redirect: 'error',
        headers: {
          Accept: 'application/json',
          'x-requested-with': 'fetch',
          'dv-id': 'device-id',
          'sp-cm': 'session-proof',
        },
      }),
    )
  })

  it.each([
    [1, 'DRAFT_PRESENT'],
    [2, 'PENDING_REVIEW'],
    [3, 'REJECTED'],
    [5, 'SCHEDULED'],
    [7, 'DELETED'],
    [9, 'DELETED'],
  ])('maps Sohu status %i to %s', async (status, outcome) => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, DETAIL_URL, detailPayload(status)),
      )

    const result = await inspectSohuPublication(
      createRequest(),
      createDependencies(fetch),
    )

    expect(result[0]).toMatchObject({
      outcome,
      source: 'PLATFORM_DETAIL',
      platformPostId: POST_ID,
      title: '平台详情标题',
      bodyText: '平台详情正文',
    })
  })

  it.each([16, 99])(
    'keeps unproven Sohu status %i behind manual review',
    async (status) => {
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse(200, DETAIL_URL, detailPayload(status)),
        )

      const result = await inspectSohuPublication(
        createRequest(),
        createDependencies(fetch),
      )

      expect(result[0]).toMatchObject({
        outcome: 'REVIEW_REQUIRED',
        errorCode:
          status === 16 ? 'SOHU_STATUS_REVIEW_REQUIRED' : 'SOHU_STATUS_UNKNOWN',
      })
    },
  )

  it('publishes status 4 only after strict anonymous public verification', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          200,
          DETAIL_URL,
          detailPayload(4, { title: '与公开页不同的详情标题' }),
        ),
      )
      .mockResolvedValueOnce(htmlResponse(200, PUBLIC_URL, publishedHtml()))

    const result = await inspectSohuPublication(
      createRequest(),
      createDependencies(fetch),
    )

    expect(fetch).toHaveBeenNthCalledWith(
      2,
      PUBLIC_URL,
      expect.objectContaining({
        method: 'GET',
        credentials: 'omit',
        redirect: 'follow',
      }),
    )
    expect(result).toEqual([
      {
        observationKey: 'sohu:request-sohu-1:PUBLIC_PAGE:PUBLISHED',
        platform: 'sohu',
        externalAccountId: ACCOUNT_ID,
        observedAt: NOW,
        outcome: 'PUBLISHED',
        source: 'PUBLIC_PAGE',
        platformPostId: POST_ID,
        canonicalUrl: PUBLIC_URL,
        title: '公开页修改后的标题',
        publishedAt: PUBLISHED_AT,
        bodyText: '第一段\n第二段 & 证据',
        bodyTruncated: false,
      },
    ])
  })

  it.each([
    [
      'a separate public host article type',
      { type: 30 },
      'SOHU_UNSUPPORTED_ARTICLE_TYPE',
    ],
    [
      'a protected public route',
      { secureScore: 10 },
      'SOHU_SECURE_PUBLIC_ROUTE_REVIEW_REQUIRED',
    ],
  ])(
    'keeps %s behind manual review without probing the ordinary public URL',
    async (_name, detailOverrides, errorCode) => {
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse(200, DETAIL_URL, detailPayload(4, detailOverrides)),
        )

      const result = await inspectSohuPublication(
        createRequest(),
        createDependencies(fetch),
      )

      expect(fetch).toHaveBeenCalledTimes(1)
      expect(result[0]).toMatchObject({
        outcome: 'REVIEW_REQUIRED',
        source: 'PLATFORM_DETAIL',
        platformPostId: POST_ID,
        errorCode,
      })
    },
  )

  it.each([
    ['type', { type: '30' }, 'SOHU_DETAIL_TYPE_INVALID'],
    ['secureScore', { secureScore: 10.5 }, 'SOHU_DETAIL_SECURE_SCORE_INVALID'],
  ])(
    'rejects an invalid optional detail %s value',
    async (_name, detailOverrides, errorCode) => {
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse(200, DETAIL_URL, detailPayload(4, detailOverrides)),
        )

      const result = await inspectSohuPublication(
        createRequest(),
        createDependencies(fetch),
      )

      expect(fetch).toHaveBeenCalledTimes(1)
      expect(result[0]).toMatchObject({
        outcome: 'PARSE_ERROR',
        source: 'PLATFORM_DETAIL',
        errorCode,
      })
    },
  )

  it('does not accept a soft-404 redirect as publication evidence', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, DETAIL_URL, detailPayload(4)))
      .mockResolvedValueOnce(
        htmlResponse(
          200,
          'https://www.sohu.com/404.html',
          '<html><title>页面不存在</title></html>',
        ),
      )

    const result = await inspectSohuPublication(
      createRequest(),
      createDependencies(fetch),
    )

    expect(result[0]).toMatchObject({
      outcome: 'REVIEW_REQUIRED',
      source: 'PUBLIC_PAGE',
      errorCode: 'SOHU_PUBLIC_RESPONSE_URL_MISMATCH',
    })
  })

  it('does not accept status 4 when public evidence is incomplete', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, DETAIL_URL, detailPayload(4)))
      .mockResolvedValueOnce(
        htmlResponse(200, PUBLIC_URL, publishedHtml({ displayMode: '2' })),
      )

    const result = await inspectSohuPublication(
      createRequest(),
      createDependencies(fetch),
    )

    expect(result[0]).toMatchObject({
      outcome: 'REVIEW_REQUIRED',
      source: 'PUBLIC_PAGE',
      errorCode: 'SOHU_PUBLIC_DISPLAY_MODE_RESTRICTED',
    })
  })

  it('rejects detail payloads for another post or account', async () => {
    const postFetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, DETAIL_URL, detailPayload(1, { id: 999 })),
      )
    const accountFetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, DETAIL_URL, detailPayload(1, { userId: 999 })),
      )

    const [postResult, accountResult] = await Promise.all([
      inspectSohuPublication(createRequest(), createDependencies(postFetch)),
      inspectSohuPublication(createRequest(), createDependencies(accountFetch)),
    ])

    expect(postResult[0]).toMatchObject({
      outcome: 'PARSE_ERROR',
      errorCode: 'SOHU_DETAIL_POST_ID_MISMATCH',
    })
    expect(accountResult[0]).toMatchObject({
      outcome: 'ACCOUNT_MISMATCH',
      errorCode: 'ACCOUNT_MISMATCH',
    })
  })

  it('reports transport failures without inferring NOT_FOUND', async () => {
    const result = await inspectSohuPublication(
      createRequest(),
      createDependencies(vi.fn().mockRejectedValue(new Error('offline'))),
    )

    expect(result[0]).toMatchObject({
      outcome: 'FETCH_ERROR',
      errorCode: 'SOHU_DETAIL_FETCH_ERROR',
    })
  })
})
