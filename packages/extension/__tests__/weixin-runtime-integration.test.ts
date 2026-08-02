import { afterEach, describe, expect, it, vi } from 'vitest'

import { WeixinAdapter } from '../../core/src/adapters/platforms/weixin'
import type { PublicationInspectRequest } from '@wechatsync/core/publication-inspection'
import { ExtensionRuntime } from '../src/runtime/extension'

const POST_ID = '900000001'
const ACCOUNT_ID = 'gh_account_001'
const TOKEN = 'fresh-token'
const TEMP_URL = 'https://mp.weixin.qq.com/s?tempkey=memory-only&mid=900000001'

const request: PublicationInspectRequest = {
  requestId: 'weixin-runtime-integration-1',
  platform: 'weixin',
  externalAccountId: ACCOUNT_ID,
  draft: {
    platformPostId: POST_ID,
    draftUrl:
      'https://mp.weixin.qq.com/cgi-bin/appmsg?action=edit' +
      `&appmsgid=${POST_ID}&token=old-token`,
    draftedAt: '2026-07-24T19:00:00+08:00',
  },
  articleHint: { title: '微信公众号在线核验' },
  limit: 20,
}

function authHtml(accountId = ACCOUNT_ID, token = TOKEN) {
  return `<script>window.wx={data:{t:"${token}"},ticket:"ticket",user_name:"${accountId}",nick_name:"Test",time:"1"}</script>`
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  })
}

function publicHtmlResponse(
  body: BodyInit | null,
  url: string,
  redirected = false,
): Response {
  const response = new Response(body, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  })
  Object.defineProperties(response, {
    url: { value: url },
    redirected: { value: redirected },
  })
  return response
}

async function inspectWith(
  fetchMock: ReturnType<typeof vi.fn>,
  events: string[],
  inspectRequest: PublicationInspectRequest = request,
) {
  vi.stubGlobal('fetch', fetchMock)
  const runtime = new ExtensionRuntime()
  const addHeaderRule = vi.fn(async () => {
    events.push('rule:add')
    return 'rule_weixin_inspection'
  })
  const removeHeaderRule = vi.fn(async () => {
    events.push('rule:remove')
  })
  runtime.headerRules = {
    add: addHeaderRule,
    remove: removeHeaderRule,
    clear: vi.fn(),
  }

  const adapter = new WeixinAdapter()
  await adapter.init(runtime)
  const observations = await adapter.inspectPublication(inspectRequest)

  return {
    observations,
    addHeaderRule,
    removeHeaderRule,
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('WeixinAdapter with ExtensionRuntime', () => {
  it('uses a fresh account session and keeps token-bearing URLs inside the runtime', async () => {
    const events: string[] = []
    const legacyTempUrl = TEMP_URL.replace('https://', 'http://')
    const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
      if (url === 'https://mp.weixin.qq.com/') {
        events.push('fetch:auth')
        return new Response(authHtml())
      }
      if (url.includes('/cgi-bin/appmsgpublish?')) {
        events.push('fetch:published-list')
        expect(url).toContain('begin=0')
        expect(url).toContain(`token=${TOKEN}`)
        return jsonResponse({
          base_resp: { ret: 0 },
          publish_page: {
            total_count: 0,
            publish_list: [],
          },
        })
      }
      if (url.includes('action=get_temp_url')) {
        events.push('fetch:detail')
        expect(url).toContain(`appmsgid=${POST_ID}`)
        expect(url).toContain(`token=${TOKEN}`)
        expect(options).toMatchObject({
          method: 'GET',
          credentials: 'include',
          redirect: 'error',
        })
        return jsonResponse({
          base_resp: { ret: 0 },
          temp_url: legacyTempUrl,
        })
      }
      if (url === TEMP_URL) {
        events.push('fetch:temp')
        expect(options).toMatchObject({
          method: 'GET',
          credentials: 'include',
          redirect: 'error',
        })
        return new Response(
          '<h1 id="activity-name">已核验微信草稿</h1>' +
            '<section id="js_content"><p>核验正文。</p></section>',
        )
      }
      throw new Error('Unexpected request')
    })

    const { observations, addHeaderRule, removeHeaderRule } = await inspectWith(
      fetchMock,
      events,
    )

    expect(observations).toEqual([
      expect.objectContaining({
        platform: 'weixin',
        externalAccountId: ACCOUNT_ID,
        outcome: 'DRAFT_PRESENT',
        source: 'DRAFT_DETAIL',
        platformPostId: POST_ID,
        title: '已核验微信草稿',
        bodyText: '核验正文。',
      }),
    ])
    expect(observations[0]).not.toHaveProperty('canonicalUrl')
    expect(JSON.stringify(observations)).not.toContain(TOKEN)
    expect(JSON.stringify(observations)).not.toContain('memory-only')
    expect(events).toEqual([
      'fetch:auth',
      'rule:add',
      'fetch:published-list',
      'fetch:detail',
      'fetch:temp',
      'rule:remove',
    ])
    expect(addHeaderRule).toHaveBeenCalledWith({
      urlFilter: '*://mp.weixin.qq.com/cgi-bin/*',
      headers: {
        Origin: 'https://mp.weixin.qq.com',
        Referer: 'https://mp.weixin.qq.com/',
      },
      resourceTypes: ['xmlhttprequest'],
    })
    expect(removeHeaderRule).toHaveBeenCalledWith('rule_weixin_inspection')
  })

  it('stops before header rules and draft detail for a mismatched account', async () => {
    const events: string[] = []
    const fetchMock = vi.fn(async (url: string) => {
      if (url === 'https://mp.weixin.qq.com/') {
        events.push('fetch:auth')
        return new Response(authHtml('gh_other_account'))
      }
      throw new Error('Draft detail must not run')
    })

    const { observations, addHeaderRule } = await inspectWith(fetchMock, events)

    expect(observations[0]).toMatchObject({
      outcome: 'ACCOUNT_MISMATCH',
      platformPostId: POST_ID,
      errorCode: 'WEIXIN_ACCOUNT_MISMATCH',
    })
    expect(events).toEqual(['fetch:auth'])
    expect(addHeaderRule).not.toHaveBeenCalled()
  })

  it('returns a public observation from the exact published-list mapping', async () => {
    const events: string[] = []
    const publicUrl = 'https://mp.weixin.qq.com/s?__biz=MzA1AA&mid=777&idx=1'
    const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
      if (url === 'https://mp.weixin.qq.com/') {
        events.push('fetch:auth')
        return new Response(authHtml())
      }
      if (url.includes('/cgi-bin/appmsgpublish?')) {
        events.push('fetch:published-list')
        return jsonResponse({
          base_resp: { ret: 0 },
          publish_page: JSON.stringify({
            total_count: 1,
            publish_list: [
              {
                publish_info: {
                  publish_info: {
                    draft_msgid: POST_ID,
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
          }),
        })
      }
      if (url === publicUrl) {
        events.push('fetch:public')
        expect(options).toMatchObject({
          credentials: 'omit',
          redirect: 'error',
          cache: 'no-store',
          headers: {
            Accept: 'text/html,application/xhtml+xml',
          },
        })
        return publicHtmlResponse(
          '<h1 id="activity-name">Published title</h1>' +
            '<section id="js_content">Published body</section>',
          publicUrl,
        )
      }
      throw new Error('Draft fallback must not run')
    })

    const { observations } = await inspectWith(fetchMock, events)

    expect(observations).toEqual([
      expect.objectContaining({
        outcome: 'PUBLISHED',
        source: 'PUBLIC_PAGE',
        platformPostId: POST_ID,
        canonicalUrl: publicUrl,
        title: 'Published title',
        bodyText: 'Published body',
        publicAccess: expect.objectContaining({
          status: 'CONFIRMED',
          checkedUrl: publicUrl,
          checkedPublicIdentityKey: 'weixin:article:v1:MzA1AA:777:1',
          httpStatus: 200,
        }),
      }),
    ])
    expect(events).toEqual([
      'fetch:auth',
      'rule:add',
      'fetch:published-list',
      'fetch:public',
      'rule:remove',
    ])
    expect(JSON.stringify(observations)).not.toContain(TOKEN)
  })

  it('does not request a published-list short URL in the MV3 runtime', async () => {
    const events: string[] = []
    const shortUrl = 'https://mp.weixin.qq.com/s/ShortAbC_123'
    const fetchMock = vi.fn(async (url: string) => {
      if (url === 'https://mp.weixin.qq.com/') {
        events.push('fetch:auth')
        return new Response(authHtml())
      }
      if (url.includes('/cgi-bin/appmsgpublish?')) {
        events.push('fetch:published-list')
        return jsonResponse({
          base_resp: { ret: 0 },
          publish_page: {
            total_count: 1,
            publish_list: [
              {
                publish_info: {
                  publish_info: {
                    draft_msgid: POST_ID,
                    publish_status: 200,
                    create_time: 1_720_000_000,
                  },
                  appmsgex: [
                    {
                      itemidx: 1,
                      content_url: shortUrl,
                    },
                  ],
                },
              },
            ],
          },
        })
      }
      throw new Error('A short public URL must not leave the service worker')
    })

    const { observations } = await inspectWith(fetchMock, events)

    expect(observations[0]).toMatchObject({
      outcome: 'REVIEW_REQUIRED',
      source: 'PUBLISHED_LIST',
      platformPostId: POST_ID,
      errorCode: 'WEIXIN_PUBLISHED_EVIDENCE_INCOMPLETE',
    })
    expect(events).toEqual([
      'fetch:auth',
      'rule:add',
      'fetch:published-list',
      'rule:remove',
    ])
    expect(JSON.stringify(observations)).not.toContain(shortUrl)
  })

  it('rejects a conflicting request appMsgId before authentication', async () => {
    const events: string[] = []
    const fetchMock = vi.fn(async () => {
      throw new Error('Authentication must not run')
    })

    const { observations, addHeaderRule } = await inspectWith(
      fetchMock,
      events,
      {
        ...request,
        draft: {
          ...request.draft,
          draftUrl:
            'https://mp.weixin.qq.com/cgi-bin/appmsg?action=edit&appmsgid=900000002',
        },
      },
    )

    expect(observations[0]).toMatchObject({
      outcome: 'PARSE_ERROR',
      errorCode: 'WEIXIN_DRAFT_ID_CONFLICT',
    })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(addHeaderRule).not.toHaveBeenCalled()
  })
})
