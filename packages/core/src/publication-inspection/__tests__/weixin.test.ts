import { describe, expect, it } from 'vitest'

import massSendPublishedListFixture from '../__fixtures__/weixin-appmsgpublish-masssend.json'
import { WEIXIN_APP_MSG_ID_MAX_LENGTH } from '../types'
import {
  WEIXIN_DRAFT_BODY_TEXT_LIMIT,
  buildWeixinPublishedListRequest,
  buildWeixinTempUrlRequest,
  classifyWeixinTempUrl,
  normalizeWeixinAppMsgId,
  normalizeWeixinLongPublicArticleUrl,
  normalizeWeixinPublicArticleUrl,
  parseWeixinDraftHtml,
  parseWeixinPublishedListPayload,
  parseWeixinPublicArticleHtml,
  parseWeixinTempUrlPayload,
  resolveWeixinAppMsgId,
  resolveWeixinTempUrl,
  validateWeixinPublicPageResponse,
  validateWeixinTempUrl,
  WEIXIN_PUBLIC_PAGE_MAX_REDIRECTS,
} from '../weixin'

const WEIXIN_LONG_A = 'https://mp.weixin.qq.com/s?__biz=MzA1AA&mid=777&idx=1'
const WEIXIN_LONG_A_WITH_SN = `${WEIXIN_LONG_A}&sn=0123456789abcdef0123456789abcdef`
const WEIXIN_LONG_B = 'https://mp.weixin.qq.com/s?__biz=MzA1AA&mid=778&idx=1'
const WEIXIN_SHORT_A = 'https://mp.weixin.qq.com/s/ShortAbC_123'

function publicResponseMetadata(
  url: string,
  redirected = false,
  contentType: string | null = 'text/html; charset=utf-8',
): Pick<Response, 'url' | 'redirected' | 'headers'> {
  return {
    url,
    redirected,
    headers: new Headers(
      contentType === null ? {} : { 'Content-Type': contentType },
    ),
  }
}

describe('WeChat publication-inspection helpers', () => {
  it.each([
    ['000900000001', '900000001'],
    [' 42 ', '42'],
    [42, '42'],
    [Number.MAX_SAFE_INTEGER, String(Number.MAX_SAFE_INTEGER)],
  ])('normalizes a safe appMsgId %p', (value, expected) => {
    expect(normalizeWeixinAppMsgId(value)).toBe(expected)
  })

  it('enforces the bridge-compatible appMsgId length boundary', () => {
    const maximumLengthId = '1'.repeat(WEIXIN_APP_MSG_ID_MAX_LENGTH)
    expect(normalizeWeixinAppMsgId(maximumLengthId)).toBe(maximumLengthId)
    expect(
      normalizeWeixinAppMsgId('1'.repeat(WEIXIN_APP_MSG_ID_MAX_LENGTH + 1)),
    ).toBeNull()
  })

  it.each([
    null,
    undefined,
    '',
    '0',
    '000',
    '1.5',
    '1e3',
    0,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
  ])('rejects an unsafe appMsgId %p', (value) => {
    expect(normalizeWeixinAppMsgId(value)).toBeNull()
  })

  it('prefers platformPostId and rejects a conflicting strict draft URL', () => {
    expect(
      resolveWeixinAppMsgId(
        '900000001',
        'https://mp.weixin.qq.com/cgi-bin/appmsg?action=edit&appmsgid=900000002',
      ),
    ).toMatchObject({
      success: false,
      outcome: 'PARSE_ERROR',
      errorCode: 'WEIXIN_DRAFT_ID_CONFLICT',
    })
  })

  it('uses a verified draft URL only when postId is absent', () => {
    expect(
      resolveWeixinAppMsgId(
        undefined,
        'https://mp.weixin.qq.com/cgi-bin/appmsg?t=media%2Fappmsg_edit&appmsgid=900000001',
      ),
    ).toEqual({ success: true, appMsgId: '900000001' })
    expect(
      resolveWeixinAppMsgId(
        '000900000001',
        'https://mp.weixin.qq.com/cgi-bin/appmsg?action=edit&appmsgid=000900000001',
      ),
    ).toEqual({ success: true, appMsgId: '900000001' })
  })

  it.each([
    'http://mp.weixin.qq.com/cgi-bin/appmsg?action=edit&appmsgid=1',
    'https://attacker.example/cgi-bin/appmsg?action=edit&appmsgid=1',
    'https://user@mp.weixin.qq.com/cgi-bin/appmsg?action=edit&appmsgid=1',
    'https://mp.weixin.qq.com/cgi-bin/appmsg?action=view&appmsgid=1',
    'https://mp.weixin.qq.com/cgi-bin/appmsg?action=edit&appmsgid=1&appmsgid=2',
    'https://mp.weixin.qq.com/cgi-bin/appmsg?action=edit&action=view&appmsgid=1',
    'https://mp.weixin.qq.com/cgi-bin/appmsg?action=edit&appmsgid=1#editor',
    'https://mp.weixin.qq.com/s?__biz=MzA1AA&mid=1&idx=1',
  ])('rejects an unverified draft URL shape: %s', (draftUrl) => {
    expect(resolveWeixinAppMsgId(undefined, draftUrl)).toMatchObject({
      success: false,
      outcome: 'PARSE_ERROR',
      errorCode: 'WEIXIN_DRAFT_URL_INVALID',
    })
  })

  it('returns UNSUPPORTED when no appMsgId is available', () => {
    expect(resolveWeixinAppMsgId()).toMatchObject({
      success: false,
      outcome: 'UNSUPPORTED',
      errorCode: 'WEIXIN_DRAFT_ID_REQUIRED',
    })
  })

  it.each(['draft-1', '-1', '0', '000', '1.5', '1 2'])(
    'rejects a non-numeric appMsgId: %s',
    (appMsgId) => {
      expect(resolveWeixinAppMsgId(appMsgId)).toMatchObject({
        success: false,
        outcome: 'PARSE_ERROR',
        errorCode: 'WEIXIN_DRAFT_ID_INVALID',
      })
    },
  )

  it('builds the verified in-memory request without losing identity', () => {
    const url = new URL(buildWeixinTempUrlRequest('900000001', 'fresh-token'))
    expect(url.origin + url.pathname).toBe(
      'https://mp.weixin.qq.com/cgi-bin/appmsg',
    )
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      action: 'get_temp_url',
      appmsgid: '900000001',
      itemidx: '1',
      token: 'fresh-token',
      lang: 'zh_CN',
      f: 'json',
      ajax: '1',
    })
  })

  it('builds the bounded published-list request with the verified query shape', () => {
    const url = new URL(buildWeixinPublishedListRequest('fresh-token', 10, 10))
    expect(url.origin + url.pathname).toBe(
      'https://mp.weixin.qq.com/cgi-bin/appmsgpublish',
    )
    expect(Object.fromEntries(url.searchParams)).toEqual({
      sub: 'list',
      begin: '10',
      count: '10',
      query: '',
      type: '101_1_102_103',
      show_type: '',
      free_publish_type: '1_102_103',
      sub_action: 'list_ex',
      search_card: '0',
      token: 'fresh-token',
      lang: 'zh_CN',
      f: 'json',
      ajax: '1',
    })
  })

  it('matches a free-publish record by nested draft_msgid, not public mid', () => {
    const result = parseWeixinPublishedListPayload(
      {
        base_resp: { ret: 0 },
        publish_page: JSON.stringify({
          total_count: 1,
          publish_list: [
            {
              publish_info: JSON.stringify({
                publish_info: {
                  draft_msgid: '900000001',
                  publish_status: 200,
                  create_time: 1_720_000_000,
                },
                appmsgex: [
                  {
                    itemidx: 1,
                    link: 'http://mp.weixin.qq.com/s?__biz=MzA1AA&amp;mid=777&amp;idx=1',
                  },
                ],
              }),
            },
          ],
        }),
      },
      '900000001',
      0,
      10,
    )

    expect(result).toEqual({
      success: true,
      match: 'PUBLISHED',
      canonicalUrl: 'https://mp.weixin.qq.com/s?__biz=MzA1AA&mid=777&idx=1',
      publishedAt: '2024-07-03T09:46:40.000Z',
    })
  })

  it('does not accept IDs or links from unrelated nested metadata', () => {
    expect(
      parseWeixinPublishedListPayload(
        {
          publish_page: {
            total_count: 1,
            publish_list: [
              {
                publish_info: {
                  publish_status: 200,
                  create_time: 1_720_000_000,
                  forwarded_article: {
                    draft_msgid: '900000001',
                    appmsgex: [
                      {
                        itemidx: 1,
                        link: 'https://mp.weixin.qq.com/s/Unrelated123',
                      },
                    ],
                  },
                },
              },
            ],
          },
        },
        '900000001',
        0,
        10,
      ),
    ).toEqual({
      success: true,
      match: 'NOT_FOUND',
      hasMore: false,
    })
  })

  it('requires manual review when one draft ID maps to conflicting records', () => {
    const record = (canonicalUrl: string, createTime: number) => ({
      publish_info: {
        publish_info: {
          draft_msgid: '900000001',
          publish_status: 200,
          create_time: createTime,
        },
        appmsgex: [{ itemidx: 1, link: canonicalUrl }],
      },
    })
    expect(
      parseWeixinPublishedListPayload(
        {
          publish_page: {
            total_count: 2,
            publish_list: [
              record('https://mp.weixin.qq.com/s/PublishedOne1', 1_720_000_000),
              record('https://mp.weixin.qq.com/s/PublishedTwo2', 1_720_000_100),
            ],
          },
        },
        '900000001',
        0,
        10,
      ),
    ).toEqual({
      success: true,
      match: 'REVIEW_REQUIRED',
    })
  })

  it('requires review when a mass-send record exposes only a short URL', () => {
    const result = parseWeixinPublishedListPayload(
      massSendPublishedListFixture,
      '900000001',
      0,
      10,
    )

    expect(result).toEqual({
      success: true,
      match: 'REVIEW_REQUIRED',
    })
  })

  it('requires complete status, itemidx=1, public URL, and publication time', () => {
    const baseInfo = {
      draft_msgid: '900000001',
      publish_status: 200,
      create_time: 1_720_000_000,
      appmsgex: [
        {
          itemidx: 1,
          content_url: 'https://mp.weixin.qq.com/s?__biz=MzA1AA&mid=777&idx=1',
        },
      ],
    }
    for (const publishInfo of [
      { ...baseInfo, publish_status: 201 },
      { ...baseInfo, appmsgex: [{ ...baseInfo.appmsgex[0], itemidx: 2 }] },
      {
        ...baseInfo,
        appmsgex: [
          {
            itemidx: 1,
            content_url: 'https://attacker.example/s?secret=candidate',
          },
        ],
      },
      { ...baseInfo, create_time: undefined },
      { ...baseInfo, create_time: 1 },
    ]) {
      const result = parseWeixinPublishedListPayload(
        {
          publish_page: {
            total_count: 1,
            publish_list: [{ publish_info: publishInfo }],
          },
        },
        '900000001',
        0,
        10,
      )
      expect(result).toEqual({
        success: true,
        match: 'REVIEW_REQUIRED',
      })
      expect(JSON.stringify(result)).not.toContain('candidate')
      expect(JSON.stringify(result)).not.toContain('attacker')
    }
  })

  it('keeps a non-matching page distinct from an invalid list response', () => {
    expect(
      parseWeixinPublishedListPayload(
        {
          publish_page: {
            total_count: 25,
            publish_list: Array.from({ length: 10 }, (_, index) => ({
              publish_info: {
                draft_msgid: String(index + 1),
                publish_status: 200,
              },
            })),
          },
        },
        '900000001',
        0,
        10,
      ),
    ).toEqual({
      success: true,
      match: 'NOT_FOUND',
      hasMore: true,
    })
    expect(
      parseWeixinPublishedListPayload(
        { base_resp: { ret: 1 }, publish_page: {} },
        '900000001',
        0,
        10,
      ),
    ).toEqual({
      success: false,
      errorCode: 'WEIXIN_PUBLISHED_LIST_API_ERROR',
    })
    expect(
      parseWeixinPublishedListPayload(
        { base_resp: { ret: {} }, publish_page: {} },
        '900000001',
        0,
        10,
      ),
    ).toEqual({
      success: false,
      errorCode: 'WEIXIN_PUBLISHED_LIST_RESPONSE_INVALID',
    })
  })

  it.each([
    {
      name: 'non-object list row',
      publishPage: { total_count: 1, publish_list: [null] },
    },
    {
      name: 'unparseable publish_info',
      publishPage: {
        total_count: 1,
        publish_list: [{ publish_info: '{not-json' }],
      },
    },
    {
      name: 'unparseable nested publish_info',
      publishPage: {
        total_count: 1,
        publish_list: [
          {
            publish_info: {
              publish_info: '{not-json',
              appmsgex: [],
            },
          },
        ],
      },
    },
    {
      name: 'inconsistent total_count',
      publishPage: {
        total_count: 0,
        publish_list: [{ publish_info: { draft_msgid: 'other' } }],
      },
    },
  ])('rejects an incomplete scan caused by $name', ({ publishPage }) => {
    expect(
      parseWeixinPublishedListPayload(
        { publish_page: publishPage },
        '900000001',
        0,
        10,
      ),
    ).toEqual({
      success: false,
      errorCode: 'WEIXIN_PUBLISHED_LIST_RESPONSE_INVALID',
    })
  })

  it('distinguishes login, API, and response-shape failures', () => {
    expect(parseWeixinTempUrlPayload(null)).toMatchObject({
      outcome: 'PARSE_ERROR',
      errorCode: 'WEIXIN_TEMP_RESPONSE_INVALID',
    })
    expect(
      parseWeixinTempUrlPayload({ base_resp: { ret: '0' } }),
    ).toMatchObject({
      outcome: 'PARSE_ERROR',
      errorCode: 'WEIXIN_TEMP_RESPONSE_INVALID',
    })
    expect(
      parseWeixinTempUrlPayload({ base_resp: { ret: 200003 } }),
    ).toMatchObject({ outcome: 'LOGIN_REQUIRED' })
    expect(
      parseWeixinTempUrlPayload({ base_resp: { ret: 12345 } }),
    ).toMatchObject({ outcome: 'FETCH_ERROR' })
    expect(parseWeixinTempUrlPayload({ base_resp: { ret: 0 } })).toMatchObject({
      outcome: 'PARSE_ERROR',
      errorCode: 'WEIXIN_TEMP_URL_MISSING',
    })
    expect(
      parseWeixinTempUrlPayload({
        base_resp: { ret: 0 },
        temp_url: ' https://mp.weixin.qq.com/s?tempkey=memory-only ',
      }),
    ).toEqual({
      success: true,
      tempUrl: 'https://mp.weixin.qq.com/s?tempkey=memory-only',
    })
  })

  it('accepts trusted HTTPS and upgrades only trusted legacy HTTP URLs', () => {
    expect(
      validateWeixinTempUrl(
        'https://mp.weixin.qq.com/s?tempkey=redacted&mid=900000001',
      ),
    ).toBe('https://mp.weixin.qq.com/s?tempkey=redacted&mid=900000001')
    expect(
      validateWeixinTempUrl(
        'http://mp.weixin.qq.com/s?tempkey=redacted&mid=900000001',
      ),
    ).toBe('https://mp.weixin.qq.com/s?tempkey=redacted&mid=900000001')
    expect(
      classifyWeixinTempUrl('http://mp.weixin.qq.com/s?tempkey=must-not-leak'),
    ).toEqual({
      success: true,
      shape: 'SAFE_HTTP_UPGRADED',
    })
    expect(
      resolveWeixinTempUrl('http://mp.weixin.qq.com/s?tempkey=must-not-leak'),
    ).toEqual({
      success: true,
      shape: 'SAFE_HTTP_UPGRADED',
      url: 'https://mp.weixin.qq.com/s?tempkey=must-not-leak',
    })
    expect(
      validateWeixinTempUrl('https://attacker.example/s?tempkey=redacted'),
    ).toBeUndefined()
    expect(
      validateWeixinTempUrl('https://user@mp.weixin.qq.com/s?tempkey=redacted'),
    ).toBeUndefined()
  })

  it.each([
    [
      'http://attacker.example/s?tempkey=must-not-leak',
      'HOST_MISMATCH',
      'WEIXIN_TEMP_URL_HOST_MISMATCH',
    ],
    [
      'http://mp.weixin.qq.com.attacker.example/s?tempkey=must-not-leak',
      'HOST_MISMATCH',
      'WEIXIN_TEMP_URL_HOST_MISMATCH',
    ],
    [
      '//mp.weixin.qq.com/s?tempkey=must-not-leak',
      'PROTOCOL_RELATIVE',
      'WEIXIN_TEMP_URL_PROTOCOL_RELATIVE',
    ],
    [
      '/s?tempkey=must-not-leak',
      'PATH_RELATIVE',
      'WEIXIN_TEMP_URL_PATH_RELATIVE',
    ],
    [
      'https://untrusted.example/s?tempkey=must-not-leak',
      'HOST_MISMATCH',
      'WEIXIN_TEMP_URL_HOST_MISMATCH',
    ],
    [
      'https://mp.weixin.qq.com/cgi-bin/appmsg?tempkey=must-not-leak',
      'PATH_MISMATCH',
      'WEIXIN_TEMP_URL_PATH_MISMATCH',
    ],
    [
      'https://user@mp.weixin.qq.com/s?tempkey=must-not-leak',
      'PORT_OR_USERINFO',
      'WEIXIN_TEMP_URL_PORT_OR_USERINFO',
    ],
    [
      'https://mp.weixin.qq.com:444/s?tempkey=must-not-leak',
      'PORT_OR_USERINFO',
      'WEIXIN_TEMP_URL_PORT_OR_USERINFO',
    ],
    [
      'javascript:must-not-leak',
      'INVALID_OR_OTHER_SCHEME',
      'WEIXIN_TEMP_URL_INVALID_OR_OTHER_SCHEME',
    ],
    [
      'not a valid URL must-not-leak',
      'INVALID_OR_OTHER_SCHEME',
      'WEIXIN_TEMP_URL_INVALID_OR_OTHER_SCHEME',
    ],
  ] as const)(
    'classifies an unsafe temp URL without returning its components: %s',
    (tempUrl, shape, errorCode) => {
      const result = classifyWeixinTempUrl(tempUrl)
      expect(result).toEqual({ success: false, shape, errorCode })
      expect(JSON.stringify(result)).not.toContain('must-not-leak')
      expect(JSON.stringify(result)).not.toContain('untrusted.example')
      expect(validateWeixinTempUrl(tempUrl)).toBeUndefined()
    },
  )

  it('classifies the existing strict allowlist shape as safe', () => {
    expect(
      classifyWeixinTempUrl(
        'https://mp.weixin.qq.com/s?tempkey=memory-only#preview',
      ),
    ).toEqual({
      success: true,
      shape: 'SAFE_ABSOLUTE_HTTPS',
    })
  })

  it.each([
    'http://mp.weixin.qq.com/s/ShortAbC_123',
    'https://attacker.example/s/ShortAbC_123',
    'https://mp.weixin.qq.com.attacker.example/s/ShortAbC_123',
    'https://user:password@mp.weixin.qq.com/s/ShortAbC_123',
    'https://mp.weixin.qq.com:444/s/ShortAbC_123',
    'https://mp.weixin.qq.com/cgi-bin/appmsg?action=edit&appmsgid=9001',
  ])('rejects an unsafe public-page request target: %s', (url) => {
    expect(normalizeWeixinPublicArticleUrl(url)).toBeNull()
    expect(normalizeWeixinLongPublicArticleUrl(url)).toBeNull()
  })

  it('accepts short URLs for classification but never as public-page request targets', () => {
    expect(normalizeWeixinPublicArticleUrl(WEIXIN_SHORT_A)).toBe(WEIXIN_SHORT_A)
    expect(normalizeWeixinLongPublicArticleUrl(WEIXIN_SHORT_A)).toBeNull()
    expect(normalizeWeixinLongPublicArticleUrl(WEIXIN_LONG_A)).toBe(
      WEIXIN_LONG_A,
    )
    expect(WEIXIN_PUBLIC_PAGE_MAX_REDIRECTS).toBe(0)
  })

  it.each([
    {
      name: 'the same long URL',
      candidate: WEIXIN_LONG_A,
      responseUrl: WEIXIN_LONG_A,
      redirected: false,
      expectedCanonical: WEIXIN_LONG_A,
    },
    {
      name: 'an explicit default HTTPS port normalized by URL semantics',
      candidate: WEIXIN_LONG_A.replace(
        'mp.weixin.qq.com',
        'mp.weixin.qq.com:443',
      ),
      responseUrl: WEIXIN_LONG_A,
      redirected: false,
      expectedCanonical: WEIXIN_LONG_A,
    },
  ])(
    'accepts $name and returns the final canonical URL',
    ({ candidate, responseUrl, redirected, expectedCanonical }) => {
      expect(
        validateWeixinPublicPageResponse(
          candidate,
          publicResponseMetadata(responseUrl, redirected),
        ),
      ).toEqual({
        success: true,
        canonicalUrl: expectedCanonical,
      })
    },
  )

  it.each([
    {
      name: 'a canonical change for the same long identity',
      candidate: WEIXIN_LONG_A,
      responseUrl: WEIXIN_LONG_A_WITH_SN,
      redirected: false,
      errorCode: 'WEIXIN_PUBLIC_RESPONSE_IDENTITY_MISMATCH',
    },
    {
      name: 'a different long identity',
      candidate: WEIXIN_LONG_A,
      responseUrl: WEIXIN_LONG_B,
      redirected: true,
      errorCode: 'WEIXIN_PUBLIC_REDIRECT_NOT_ALLOWED',
    },
    {
      name: 'a redirected response even when the URL is unchanged',
      candidate: WEIXIN_LONG_A,
      responseUrl: WEIXIN_LONG_A,
      redirected: true,
      errorCode: 'WEIXIN_PUBLIC_REDIRECT_NOT_ALLOWED',
    },
  ] as const)(
    'rejects $name',
    ({ candidate, responseUrl, redirected, errorCode }) => {
      expect(
        validateWeixinPublicPageResponse(
          candidate,
          publicResponseMetadata(responseUrl, redirected),
        ),
      ).toEqual({
        success: false,
        errorCode,
      })
    },
  )

  it.each([
    'http://mp.weixin.qq.com/s/ShortAbC_123?secret=candidate',
    'https://attacker.example/s/ShortAbC_123?secret=candidate',
    'https://mp.weixin.qq.com.attacker.example/s/ShortAbC_123?secret=candidate',
    'https://user:password@mp.weixin.qq.com/s/ShortAbC_123?secret=candidate',
    'https://mp.weixin.qq.com:444/s/ShortAbC_123?secret=candidate',
    'https://mp.weixin.qq.com/cgi-bin/appmsg?action=edit&appmsgid=9001',
    'https://mp.weixin.qq.com/s?__biz=MzA1AA&mid=777',
    'not-a-url-secret-candidate',
  ])(
    'rejects an invalid public candidate URL without leaking it: %s',
    (url) => {
      const result = validateWeixinPublicPageResponse(
        url,
        publicResponseMetadata(WEIXIN_SHORT_A),
      )
      expect(result).toEqual({
        success: false,
        errorCode: 'WEIXIN_PUBLIC_CANDIDATE_URL_INVALID',
      })
      expect(JSON.stringify(result)).not.toContain('secret')
      expect(JSON.stringify(result)).not.toContain('attacker.example')
    },
  )

  it.each([
    '',
    'http://mp.weixin.qq.com/s/ShortAbC_123?secret=response',
    'https://attacker.example/s/ShortAbC_123?secret=response',
    'https://mp.weixin.qq.com.attacker.example/s/ShortAbC_123?secret=response',
    'https://user:password@mp.weixin.qq.com/s/ShortAbC_123?secret=response',
    'https://mp.weixin.qq.com:444/s/ShortAbC_123?secret=response',
    'https://mp.weixin.qq.com/cgi-bin/appmsg?action=edit&appmsgid=9001',
    'https://mp.weixin.qq.com/s?__biz=MzA1AA&mid=777',
  ])('rejects an invalid final response URL without leaking it: %s', (url) => {
    const result = validateWeixinPublicPageResponse(
      WEIXIN_LONG_A,
      publicResponseMetadata(url),
    )
    expect(result).toEqual({
      success: false,
      errorCode: 'WEIXIN_PUBLIC_RESPONSE_URL_INVALID',
    })
    expect(JSON.stringify(result)).not.toContain('secret')
    expect(JSON.stringify(result)).not.toContain('attacker.example')
  })

  it.each([
    'text/html',
    'text/html; charset=UTF-8',
    'application/xhtml+xml',
    'application/xhtml+xml; charset=utf-8',
  ])('accepts the public HTML content type %s', (contentType) => {
    expect(
      validateWeixinPublicPageResponse(
        WEIXIN_LONG_A,
        publicResponseMetadata(WEIXIN_LONG_A, false, contentType),
      ),
    ).toEqual({ success: true, canonicalUrl: WEIXIN_LONG_A })
  })

  it.each([
    'application/json',
    'text/plain; charset=utf-8',
    'text/htmlx',
    null,
  ])('rejects the unexpected public content type %s', (contentType) => {
    expect(
      validateWeixinPublicPageResponse(
        WEIXIN_LONG_A,
        publicResponseMetadata(WEIXIN_LONG_A, false, contentType),
      ),
    ).toEqual({
      success: false,
      errorCode: 'WEIXIN_PUBLIC_UNEXPECTED_CONTENT_TYPE',
    })
  })

  it('extracts visible text and caps it at 50 KB', () => {
    const parsed = parseWeixinDraftHtml(`
      <h1 id="activity-name">  Updated   title </h1>
      <section id="js_content">
        <p>First paragraph</p><p>${'x'.repeat(WEIXIN_DRAFT_BODY_TEXT_LIMIT)}</p>
        <script>secret()</script>
      </section>
    `)
    expect(parsed).toMatchObject({
      success: true,
      title: 'Updated title',
      bodyTruncated: true,
    })
    if (parsed.success) {
      expect(parsed.bodyText).toHaveLength(WEIXIN_DRAFT_BODY_TEXT_LIMIT)
      expect(parsed.bodyText).not.toContain('secret')
    }
  })

  it('extracts bounded evidence from a verified public article page', () => {
    expect(
      parseWeixinPublicArticleHtml(
        '<h1 id="activity-name">Public title</h1>' +
          '<section id="js_content"><p>Public body</p></section>',
      ),
    ).toEqual({
      success: true,
      title: 'Public title',
      bodyText: 'Public body',
      bodyTruncated: false,
    })
  })

  it('rejects a changed temporary-page shape explicitly', () => {
    expect(parseWeixinDraftHtml('<main>new page structure</main>')).toEqual({
      success: false,
      errorCode: 'WEIXIN_DRAFT_HTML_INVALID',
      errorMessage:
        'The WeChat temporary page is missing its title or content container.',
    })
  })
})
