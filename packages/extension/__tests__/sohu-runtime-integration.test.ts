import { afterEach, describe, expect, it, vi } from 'vitest'

import { SohuAdapter } from '../../core/src/adapters/platforms/sohu'
import type { PublicationInspectRequest } from '@wechatsync/core/publication-inspection'
import { ExtensionRuntime } from '../src/runtime/extension'

const POST_ID = '1054312481'
const ACCOUNT_ID = '120219780'
const PUBLIC_URL = `https://www.sohu.com/a/${POST_ID}_${ACCOUNT_ID}`
const DETAIL_URL =
  `https://mp.sohu.com/mpbp/bp/news/v4/article?newsId=${POST_ID}` +
  `&accountId=${ACCOUNT_ID}`

const request: PublicationInspectRequest = {
  requestId: 'sohu-runtime-integration-1',
  platform: 'sohu',
  externalAccountId: ACCOUNT_ID,
  draft: {
    platformPostId: POST_ID,
    draftUrl:
      'https://mp.sohu.com/mpfe/v4/contentManagement/news/addarticle' +
      `?contentStatus=2&id=${POST_ID}`,
    draftedAt: '2026-07-24T16:30:00+08:00',
  },
  articleHint: {
    title: '小红书私信营销工具话术与转化力：3步实测评估法（2026版）',
  },
  limit: 20,
}

const publishedHtml = `
  <html>
    <head>
      <link rel="canonical" href="${PUBLIC_URL}">
      <meta property="og:url" content="${PUBLIC_URL}">
      <script type="application/ld+json">${JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'NewsArticle',
        url: PUBLIC_URL,
        mainEntityOfPage: {
          '@type': 'WebPage',
          '@id': PUBLIC_URL,
        },
        headline: request.articleHint.title,
        datePublished: '2026-07-24T16:40:14+0800',
        author: {
          '@type': 'Person',
          name: '快商通AI',
        },
      })}</script>
      <script>
        var cfgs = {
          news_id: "${POST_ID}",
          media_id: "${ACCOUNT_ID}",
          displayMode: "0"
        };
      </script>
    </head>
    <body>
      <article id="mp-editor"><p>已公开发布的搜狐文章正文。</p></article>
    </body>
  </html>
`

function responseWithUrl(
  url: string,
  body: string,
  contentType: string,
  status = 200,
): Response {
  const response = new Response(body, {
    status,
    headers: { 'Content-Type': contentType },
  })
  Object.defineProperty(response, 'url', { value: url })
  return response
}

function jsonResponse(url: string, payload: unknown, status = 200): Response {
  return responseWithUrl(
    url,
    JSON.stringify(payload),
    'application/json; charset=utf-8',
    status,
  )
}

function htmlResponse(url: string, body: string, status = 200): Response {
  return responseWithUrl(url, body, 'text/html; charset=utf-8', status)
}

function accountResponse(url: string, activeAccountId = ACCOUNT_ID): Response {
  return jsonResponse(url, {
    code: 2000000,
    data: {
      data: [
        {
          accounts: [],
        },
        {
          accounts: [
            {
              id: activeAccountId,
              nickName: '快商通AI',
              avatar: 'https://example.com/avatar.png',
            },
          ],
        },
      ],
    },
  })
}

function detailResponse(url: string): Response {
  return jsonResponse(url, {
    code: 2000000,
    data: {
      news: {
        id: Number(POST_ID),
        userId: Number(ACCOUNT_ID),
        status: 4,
        title: request.articleHint.title,
        content: '<p>已公开发布的搜狐文章正文。</p>',
        postTime: '2026-07-24 16:40:14',
      },
    },
  })
}

async function inspectWith(
  fetchMock: ReturnType<typeof vi.fn>,
  events: string[],
) {
  vi.stubGlobal('fetch', fetchMock)
  const runtime = new ExtensionRuntime()
  vi.spyOn(runtime, 'getCookie').mockResolvedValue('test-sp-cm')
  const addHeaderRule = vi.fn(async () => {
    events.push('rule:add')
    return 'rule_sohu_inspection'
  })
  const removeHeaderRule = vi.fn(async () => {
    events.push('rule:remove')
  })
  runtime.headerRules = {
    add: addHeaderRule,
    remove: removeHeaderRule,
    clear: vi.fn(),
  }

  const adapter = new SohuAdapter()
  await adapter.init(runtime)
  const observations = await adapter.inspectPublication(request)

  return {
    observations,
    addHeaderRule,
    removeHeaderRule,
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('SohuAdapter with ExtensionRuntime', () => {
  it('routes account, detail, and anonymous public requests inside header rules', async () => {
    const events: string[] = []
    const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
      if (url.startsWith('https://mp.sohu.com/mpbp/bp/account/list?')) {
        events.push('fetch:account')
        return accountResponse(url)
      }
      if (url === DETAIL_URL) {
        events.push('fetch:detail')
        expect(options).toMatchObject({
          method: 'GET',
          credentials: 'include',
          headers: {
            Accept: 'application/json',
            'x-requested-with': 'XMLHttpRequest',
            'dv-id': expect.stringMatching(/^[0-9a-f]{32}$/),
            'sp-cm': 'test-sp-cm',
          },
        })
        return detailResponse(url)
      }
      if (url === PUBLIC_URL) {
        events.push('fetch:public')
        expect(options).toMatchObject({
          method: 'GET',
          credentials: 'omit',
        })
        return htmlResponse(url, publishedHtml)
      }
      throw new Error(`Unexpected request: ${url}`)
    })

    const { observations, addHeaderRule, removeHeaderRule } = await inspectWith(
      fetchMock,
      events,
    )

    expect(observations).toHaveLength(1)
    expect(observations[0]).toMatchObject({
      platform: 'sohu',
      externalAccountId: ACCOUNT_ID,
      outcome: 'PUBLISHED',
      source: 'PUBLIC_PAGE',
      platformPostId: POST_ID,
      canonicalUrl: PUBLIC_URL,
      title: request.articleHint.title,
      publishedAt: '2026-07-24T08:40:14.000Z',
      bodyText: '已公开发布的搜狐文章正文。',
    })
    expect(events).toEqual([
      'rule:add',
      'fetch:account',
      'fetch:detail',
      'fetch:public',
      'rule:remove',
    ])
    expect(addHeaderRule).toHaveBeenCalledWith({
      urlFilter: '*://mp.sohu.com/*',
      headers: {
        Origin: 'https://mp.sohu.com',
        Referer: 'https://mp.sohu.com/',
      },
      resourceTypes: ['xmlhttprequest'],
    })
    expect(removeHeaderRule).toHaveBeenCalledWith('rule_sohu_inspection')
  })

  it('stops before article lookup for a mismatched bound account and clears rules', async () => {
    const events: string[] = []
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith('https://mp.sohu.com/mpbp/bp/account/list?')) {
        events.push('fetch:account')
        return accountResponse(url, '120000001')
      }
      throw new Error(`Unexpected request: ${url}`)
    })

    const { observations, removeHeaderRule } = await inspectWith(
      fetchMock,
      events,
    )

    expect(observations).toHaveLength(1)
    expect(observations[0]).toMatchObject({
      platform: 'sohu',
      outcome: 'ACCOUNT_MISMATCH',
      source: 'PLATFORM_DETAIL',
      platformPostId: POST_ID,
      errorCode: 'ACCOUNT_MISMATCH',
    })
    expect(events).toEqual(['rule:add', 'fetch:account', 'rule:remove'])
    expect(removeHeaderRule).toHaveBeenCalledWith('rule_sohu_inspection')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
