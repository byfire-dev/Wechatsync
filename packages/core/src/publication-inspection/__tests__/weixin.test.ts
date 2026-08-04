import { describe, expect, it } from 'vitest'

import freePublishPublishedListFixture from '../__fixtures__/weixin-appmsgpublish-freepublish-success-sanitized.json'
import massSendPublishedListFixture from '../__fixtures__/weixin-appmsgpublish-masssend.json'
import { WEIXIN_APP_MSG_ID_MAX_LENGTH } from '../types'
import {
  WEIXIN_DRAFT_BODY_TEXT_LIMIT,
  buildWeixinDraftListRequest,
  buildWeixinPublishedListRequest,
  buildWeixinTempUrlRequest,
  classifyWeixinTempUrl,
  normalizeWeixinAppMsgId,
  normalizeWeixinLongPublicArticleUrl,
  normalizeWeixinPublicArticleUrl,
  parseWeixinDraftHtml,
  parseWeixinDraftListPayload,
  parseWeixinPublishedListPayload,
  parseWeixinPublicArticleHtml,
  parseWeixinPublicArticlePublishedAt,
  parseWeixinTempUrlPayload,
  resolveWeixinAppMsgId,
  resolveWeixinTempUrl,
  validateWeixinPublicPageResponse,
  validateWeixinTempUrl,
  WEIXIN_PUBLIC_PAGE_MAX_BYTES,
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

  it.each([10, 77] as const)(
    'builds the authenticated current-draft list_card request for type %s',
    (type) => {
      const url = new URL(buildWeixinDraftListRequest('fresh-token', type))
      expect(url.origin + url.pathname).toBe(
        'https://mp.weixin.qq.com/cgi-bin/appmsg',
      )
      expect(Object.fromEntries(url.searchParams)).toEqual({
        begin: '0',
        count: '20',
        type: String(type),
        action: 'list_card',
        token: 'fresh-token',
        lang: 'zh_CN',
        f: 'json',
        ajax: '1',
      })
    },
  )

  it.each([
    ['string app_id', '0009001'],
    ['numeric app_id', 9001],
    ['JSON-encoded item list', JSON.stringify([{ app_id: '9001' }])],
  ])('matches exact current-draft membership from a %s', (_name, item) => {
    expect(
      parseWeixinDraftListPayload(
        {
          base_resp: { ret: 0 },
          app_msg_info: {
            item:
              typeof item === 'string' && item.startsWith('[')
                ? item
                : [{ app_id: item }],
          },
        },
        '9001',
      ),
    ).toEqual({ success: true, match: 'DRAFT_PRESENT' })
  })

  it('does not confuse another current draft with the requested appMsgId', () => {
    expect(
      parseWeixinDraftListPayload(
        {
          base_resp: { ret: 0 },
          app_msg_info: { item: [{ app_id: '90010' }, { app_id: 8999 }] },
        },
        '9001',
      ),
    ).toEqual({ success: true, match: 'NOT_FOUND' })
  })

  it('fails closed on draft-list API and shape errors without leaking values', () => {
    expect(
      parseWeixinDraftListPayload(
        { base_resp: { ret: 200013, err_msg: 'secret-token' } },
        '9001',
      ),
    ).toEqual({
      success: false,
      errorCode: 'WEIXIN_DRAFT_LIST_API_ERROR',
    })

    const malformed = parseWeixinDraftListPayload(
      {
        base_resp: { ret: 0 },
        app_msg_info: { item: [{ app_id: 'secret-draft-id' }] },
      },
      '9001',
    )
    expect(malformed).toMatchObject({
      success: false,
      errorCode: 'WEIXIN_DRAFT_LIST_RECORD_INVALID',
    })
    expect(JSON.stringify(malformed)).not.toContain('secret-draft-id')
    expect(JSON.stringify(malformed)).not.toContain('secret-token')
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

  it('matches the schema-only sanitized free-publish fixture by exact draft ID', () => {
    expect(
      parseWeixinPublishedListPayload(
        freePublishPublishedListFixture,
        '900000001',
        0,
        10,
      ),
    ).toEqual({
      success: true,
      match: 'PUBLISHED',
      canonicalUrl:
        'https://mp.weixin.qq.com/s?__biz=MzA1AA&mid=777000001&idx=1',
      publishedAt: '2024-07-03T09:46:40.000Z',
    })
    expect(
      parseWeixinPublishedListPayload(
        freePublishPublishedListFixture,
        '900000002',
        0,
        10,
      ),
    ).toEqual({
      success: true,
      match: 'NOT_FOUND',
      hasMore: true,
      nextBegin: 1,
      totalCount: 1,
      newestPublishedAt: '2024-07-03T09:46:40.000Z',
      oldestPublishedAt: '2024-07-03T09:46:40.000Z',
    })
    expect(JSON.stringify(freePublishPublishedListFixture)).not.toMatch(
      /"(title|author|digest|content|token|ticket|user_name)"\s*:/i,
    )
  })

  it.each(['', '   '])(
    'uses an empty publish_info sentinel with exact inline free-publish evidence: %j',
    (publishInfo) => {
      expect(
        parseWeixinPublishedListPayload(
          {
            publish_page: {
              total_count: 1,
              publish_list: [
                {
                  publish_info: publishInfo,
                  draft_msgid: '900000001',
                  publish_status: 200,
                  create_time: 1_720_000_000,
                  appmsgex: [
                    {
                      itemidx: 1,
                      content_url: WEIXIN_LONG_A,
                    },
                  ],
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
        match: 'PUBLISHED',
        canonicalUrl: WEIXIN_LONG_A,
        publishedAt: '2024-07-03T09:46:40.000Z',
      })
    },
  )

  it.each(['', '   '])(
    'uses an empty nested publish_info sentinel with exact outer free-publish evidence: %j',
    (nestedPublishInfo) => {
      expect(
        parseWeixinPublishedListPayload(
          {
            publish_page: {
              total_count: 1,
              publish_list: [
                {
                  publish_info: {
                    publish_info: nestedPublishInfo,
                    draft_msgid: '900000001',
                    publish_status: 200,
                    create_time: 1_720_000_000,
                    appmsgex: [{ itemidx: 1, content_url: WEIXIN_LONG_A }],
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
        match: 'PUBLISHED',
        canonicalUrl: WEIXIN_LONG_A,
        publishedAt: '2024-07-03T09:46:40.000Z',
      })
    },
  )

  it('keeps exact outer identity with an empty nested sentinel and incomplete evidence in manual review', () => {
    expect(
      parseWeixinPublishedListPayload(
        {
          publish_page: {
            total_count: 1,
            publish_list: [
              {
                publish_info: {
                  publish_info: '',
                  draft_msgid: '900000001',
                  publish_status: 200,
                  create_time: 1_720_000_000,
                  appmsgex: [
                    {
                      itemidx: 1,
                      content_url: 'https://attacker.example/private-target',
                    },
                  ],
                },
              },
            ],
          },
        },
        '900000001',
        0,
        10,
      ),
    ).toEqual({ success: true, match: 'REVIEW_REQUIRED' })
  })

  it('does not match an empty nested sentinel without an outer identity', () => {
    expect(
      parseWeixinPublishedListPayload(
        {
          publish_page: {
            total_count: 1,
            publish_list: [
              {
                publish_info: {
                  publish_info: '',
                  publish_status: 200,
                  create_time: 1_720_000_000,
                  appmsgex: [{ itemidx: 1, content_url: WEIXIN_LONG_A }],
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
      hasMore: true,
      nextBegin: 1,
      totalCount: 1,
      newestPublishedAt: '2024-07-03T09:46:40.000Z',
      oldestPublishedAt: '2024-07-03T09:46:40.000Z',
    })
  })

  it('uses an empty publish_info sentinel with exact inline mass-send evidence', () => {
    expect(
      parseWeixinPublishedListPayload(
        {
          publish_page: {
            total_count: 1,
            publish_list: [
              {
                publish_info: '',
                copy_appmsg_id: '900000001',
                sent_result: { msg_status: 2 },
                sent_info: { time: 1_720_000_000 },
                appmsgex: [{ itemidx: 1, content_url: WEIXIN_LONG_A }],
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
      match: 'PUBLISHED',
      canonicalUrl: WEIXIN_LONG_A,
      publishedAt: '2024-07-03T09:46:40.000Z',
    })
  })

  it('keeps exact inline identity with incomplete evidence in manual review', () => {
    expect(
      parseWeixinPublishedListPayload(
        {
          publish_page: {
            total_count: 1,
            publish_list: [
              {
                publish_info: '',
                draft_msgid: '900000001',
                publish_status: 200,
                create_time: 1_720_000_000,
                appmsgex: [
                  {
                    itemidx: 1,
                    content_url: 'https://attacker.example/private-target',
                  },
                ],
              },
            ],
          },
        },
        '900000001',
        0,
        10,
      ),
    ).toEqual({ success: true, match: 'REVIEW_REQUIRED' })
  })

  it('treats an empty publish_info sentinel with another valid inline identity as non-matching', () => {
    expect(
      parseWeixinPublishedListPayload(
        {
          publish_page: {
            total_count: 1,
            publish_list: [
              {
                publish_info: '',
                draft_msgid: '900000002',
                publish_status: 200,
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
      hasMore: true,
      nextBegin: 1,
      totalCount: 1,
    })
  })

  it('skips an empty published-list placeholder without treating article IDs as draft identity', () => {
    expect(
      parseWeixinPublishedListPayload(
        {
          publish_page: {
            total_count: 1,
            publish_list: [
              {
                publish_info: '',
                appmsg_info: [{ itemidx: 1, appmsgid: '900000001' }],
                appmsgex: [{ itemidx: 1, content_url: WEIXIN_LONG_A }],
              },
            ],
          },
        },
        '900000001',
        0,
        10,
      ),
    ).toEqual({ success: true, match: 'NOT_FOUND', hasMore: false })
  })

  it('treats a full page of empty placeholders as the terminal page even when total_count remains larger', () => {
    expect(
      parseWeixinPublishedListPayload(
        {
          publish_page: {
            total_count: 11,
            publish_list: Array.from({ length: 10 }, () => ({
              publish_info: '',
            })),
          },
        },
        '900000001',
        0,
        10,
      ),
    ).toEqual({ success: true, match: 'NOT_FOUND', hasMore: false })
  })

  it('keeps pagination when a page mixes empty placeholders with materialized records', () => {
    expect(
      parseWeixinPublishedListPayload(
        {
          publish_page: {
            total_count: 3,
            publish_list: [
              { publish_info: '' },
              { publish_info: { draft_msgid: '900000002' } },
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
      hasMore: true,
      nextBegin: 1,
      totalCount: 3,
    })
  })

  it('lets a nonzero cursor terminate on a full placeholder page before advisory count checks', () => {
    expect(
      parseWeixinPublishedListPayload(
        {
          publish_page: {
            total_count: 10,
            publish_list: Array.from({ length: 10 }, () => ({
              publish_info: '',
            })),
          },
        },
        '900000001',
        10,
        10,
      ),
    ).toEqual({ success: true, match: 'NOT_FOUND', hasMore: false })
  })

  it.each(['before', 'after'] as const)(
    'continues scanning when an empty placeholder appears $position an exact record',
    (position) => {
      const placeholder = { publish_info: '' }
      const exactRecord = {
        publish_info: {
          publish_info: {
            draft_msgid: '900000001',
            publish_status: 200,
            create_time: 1_720_000_000,
          },
          appmsgex: [{ itemidx: 1, content_url: WEIXIN_LONG_A }],
        },
      }
      expect(
        parseWeixinPublishedListPayload(
          {
            publish_page: {
              total_count: 2,
              publish_list:
                position === 'before'
                  ? [placeholder, exactRecord]
                  : [exactRecord, placeholder],
            },
          },
          '900000001',
          0,
          10,
        ),
      ).toEqual({
        success: true,
        match: 'PUBLISHED',
        canonicalUrl: WEIXIN_LONG_A,
        publishedAt: '2024-07-03T09:46:40.000Z',
      })
    },
  )

  it('fails closed for an empty publish_info sentinel with an invalid identity', () => {
    const result = parseWeixinPublishedListPayload(
      {
        publish_page: {
          total_count: 1,
          publish_list: [{ publish_info: '', draft_msgid: 'secret-draft-id' }],
        },
      },
      '900000001',
      0,
      10,
    )

    expect(result).toEqual({
      success: false,
      errorCode: 'WEIXIN_PUBLISHED_LIST_PUBLISH_INFO_INVALID',
      shapeFingerprint:
        'wx-list-row:v2;publish_info=string:empty;inline_identity=invalid',
    })
    expect(JSON.stringify(result)).not.toMatch(/secret|900000001/i)
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
      hasMore: true,
      nextBegin: 1,
      totalCount: 1,
      newestPublishedAt: '2024-07-03T09:46:40.000Z',
      oldestPublishedAt: '2024-07-03T09:46:40.000Z',
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
              record(WEIXIN_LONG_A, 1_720_000_000),
              record(WEIXIN_LONG_B, 1_720_000_100),
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

  it('accepts a mass-send record with a canonical short public URL', () => {
    const result = parseWeixinPublishedListPayload(
      massSendPublishedListFixture,
      '900000001',
      0,
      10,
    )

    expect(result).toEqual({
      success: true,
      match: 'PUBLISHED',
      canonicalUrl: 'https://mp.weixin.qq.com/s/AbCdEfGh1234',
      publishedAt: '2024-07-03T09:46:40.000Z',
    })
  })

  it('accepts duplicate URL fields only when they normalize to one public identity', () => {
    expect(
      parseWeixinPublishedListPayload(
        {
          publish_page: {
            total_count: 1,
            publish_list: [
              {
                publish_info: {
                  draft_msgid: '900000001',
                  publish_status: 200,
                  create_time: 1_720_000_000,
                  appmsgex: [
                    {
                      itemidx: 1,
                      content_url: WEIXIN_SHORT_A,
                      link: `${WEIXIN_SHORT_A}?tracking=ignored`,
                    },
                  ],
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
      match: 'PUBLISHED',
      canonicalUrl: WEIXIN_SHORT_A,
      publishedAt: '2024-07-03T09:46:40.000Z',
    })
  })

  it.each([
    {
      name: 'two different short identities',
      first: WEIXIN_SHORT_A,
      second: 'https://mp.weixin.qq.com/s/Different_123',
    },
    {
      name: 'a short and a long identity',
      first: WEIXIN_SHORT_A,
      second: WEIXIN_LONG_A,
    },
  ])('requires review for $name in one article item', ({ first, second }) => {
    expect(
      parseWeixinPublishedListPayload(
        {
          publish_page: {
            total_count: 1,
            publish_list: [
              {
                publish_info: {
                  draft_msgid: '900000001',
                  publish_status: 200,
                  create_time: 1_720_000_000,
                  appmsgex: [{ itemidx: 1, content_url: first, link: second }],
                },
              },
            ],
          },
        },
        '900000001',
        0,
        10,
      ),
    ).toEqual({ success: true, match: 'REVIEW_REQUIRED' })
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
      nextBegin: 10,
      totalCount: 25,
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
      errorCode: 'WEIXIN_PUBLISHED_LIST_BASE_RET_INVALID',
      shapeFingerprint: 'wx-list-shape:v1;base_resp.ret=object',
    })
  })

  it('exposes a newest-first timestamp bound only for fully timestamped pages', () => {
    const result = parseWeixinPublishedListPayload(
      {
        publish_page: {
          total_count: 20,
          publish_list: [
            {
              publish_info: {
                draft_msgid: '8002',
                publish_status: 200,
                create_time: 1720000200,
              },
            },
            {
              publish_info: {
                draft_msgid: '8001',
                publish_status: 200,
                create_time: 1720000100,
              },
            },
          ],
        },
      },
      '900000001',
      0,
      10,
    )

    expect(result).toEqual({
      success: true,
      match: 'NOT_FOUND',
      hasMore: true,
      nextBegin: 2,
      totalCount: 20,
      newestPublishedAt: '2024-07-03T09:50:00.000Z',
      oldestPublishedAt: '2024-07-03T09:48:20.000Z',
    })

    expect(
      parseWeixinPublishedListPayload(
        {
          publish_page: {
            total_count: 20,
            publish_list: [
              {
                publish_info: {
                  draft_msgid: '8001',
                  publish_status: 200,
                  create_time: 1720000100,
                },
              },
              {
                publish_info: {
                  draft_msgid: '8002',
                  publish_status: 200,
                  create_time: 1720000200,
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
      hasMore: true,
      nextBegin: 2,
      totalCount: 20,
    })

    expect(
      parseWeixinPublishedListPayload(
        {
          publish_page: {
            total_count: 20,
            publish_list: [
              {
                publish_info: {
                  draft_msgid: '8002',
                  publish_status: 200,
                  create_time: 1720000200,
                },
              },
              {
                publish_info: {
                  draft_msgid: '8001',
                  publish_status: 200,
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
      hasMore: true,
      nextBegin: 2,
      totalCount: 20,
    })
  })

  it.each([
    {
      name: 'non-object response root',
      payload: null,
      errorCode: 'WEIXIN_PUBLISHED_LIST_ROOT_INVALID',
      shapeFingerprint: 'wx-list-shape:v1;root=null',
    },
    {
      name: 'non-object base response',
      payload: { base_resp: ['secret-account-title-url-token'] },
      errorCode: 'WEIXIN_PUBLISHED_LIST_BASE_RESPONSE_INVALID',
      shapeFingerprint: 'wx-list-shape:v1;base_resp=array',
    },
    {
      name: 'invalid base response ret',
      payload: { base_resp: { ret: {} } },
      errorCode: 'WEIXIN_PUBLISHED_LIST_BASE_RET_INVALID',
      shapeFingerprint: 'wx-list-shape:v1;base_resp.ret=object',
    },
    {
      name: 'missing publish page',
      payload: {},
      errorCode: 'WEIXIN_PUBLISHED_LIST_PUBLISH_PAGE_INVALID',
      shapeFingerprint: 'wx-list-shape:v1;publish_page=missing',
    },
    {
      name: 'unparseable publish page',
      payload: { publish_page: '{secret-account-title-url-token' },
      errorCode: 'WEIXIN_PUBLISHED_LIST_PUBLISH_PAGE_INVALID',
      shapeFingerprint: 'wx-list-shape:v1;publish_page=string:invalid-json',
    },
    {
      name: 'non-array publish list',
      payload: {
        publish_page: { publish_list: 'secret-account-title-url-token' },
      },
      errorCode: 'WEIXIN_PUBLISHED_LIST_PUBLISH_LIST_INVALID',
      shapeFingerprint:
        'wx-list-shape:v1;publish_page.publish_list=string:invalid-json',
    },
    {
      name: 'publish list over the requested bound',
      payload: {
        publish_page: { publish_list: Array.from({ length: 11 }, () => ({})) },
      },
      errorCode: 'WEIXIN_PUBLISHED_LIST_PUBLISH_LIST_INVALID',
      shapeFingerprint:
        'wx-list-shape:v1;publish_page.publish_list=array:exceeds-requested-count',
    },
    {
      name: 'non-object list row',
      payload: { publish_page: { total_count: 1, publish_list: [null] } },
      errorCode: 'WEIXIN_PUBLISHED_LIST_RECORD_INVALID',
      shapeFingerprint: 'wx-list-shape:v1;publish_page.publish_list.row=null',
    },
    {
      name: 'missing publish info',
      payload: { publish_page: { total_count: 1, publish_list: [{}] } },
      errorCode: 'WEIXIN_PUBLISHED_LIST_PUBLISH_INFO_INVALID',
      shapeFingerprint:
        'wx-list-row:v2;publish_info=missing;inline_identity=missing',
    },
    {
      name: 'unparseable publish info',
      payload: {
        publish_page: {
          total_count: 1,
          publish_list: [{ publish_info: '{secret-account-title-url-token' }],
        },
      },
      errorCode: 'WEIXIN_PUBLISHED_LIST_PUBLISH_INFO_INVALID',
      shapeFingerprint: 'wx-list-shape:v1;publish_info=string:invalid-json',
    },
    {
      name: 'unparseable nested publish info',
      payload: {
        publish_page: {
          total_count: 1,
          publish_list: [
            {
              publish_info: {
                publish_info: '{secret-account-title-url-token',
                appmsgex: [],
              },
            },
          ],
        },
      },
      errorCode: 'WEIXIN_PUBLISHED_LIST_NESTED_INFO_INVALID',
      shapeFingerprint:
        'wx-list-shape:v1;publish_info.publish_info=string:invalid-json',
    },
    {
      name: 'inconsistent total count',
      payload: {
        publish_page: {
          total_count: 0,
          publish_list: [{ publish_info: { draft_msgid: 'other' } }],
        },
      },
      errorCode: 'WEIXIN_PUBLISHED_LIST_PAGINATION_INVALID',
      shapeFingerprint:
        'wx-list-shape:v1;publish_page.total_count=less-than-materialized-page-bound',
    },
  ])(
    'returns a safe structural diagnostic for $name',
    ({ payload, errorCode, shapeFingerprint }) => {
      const result = parseWeixinPublishedListPayload(
        payload,
        '900000001',
        0,
        10,
      )
      expect(result).toEqual({ success: false, errorCode, shapeFingerprint })
      expect(JSON.stringify(result)).not.toContain(
        'secret-account-title-url-token',
      )
    },
  )

  it('produces the same structural fingerprint for different private values', () => {
    const resultFor = (privateValue: string) =>
      parseWeixinPublishedListPayload(
        {
          publish_page: {
            total_count: 1,
            publish_list: [{ publish_info: `{${privateValue}` }],
          },
        },
        '900000001',
        0,
        10,
      )

    const first = resultFor('private-account-title-url-token-one')
    const second = resultFor('different-private-data-two')

    expect(first).toEqual(second)
    expect(first).toEqual({
      success: false,
      errorCode: 'WEIXIN_PUBLISHED_LIST_PUBLISH_INFO_INVALID',
      shapeFingerprint: 'wx-list-shape:v1;publish_info=string:invalid-json',
    })
    expect(JSON.stringify(first)).not.toMatch(/private|account|title|token/i)
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

  it('accepts canonical short and long public-page request targets without redirects', () => {
    expect(normalizeWeixinPublicArticleUrl(WEIXIN_SHORT_A)).toBe(WEIXIN_SHORT_A)
    expect(normalizeWeixinLongPublicArticleUrl(WEIXIN_SHORT_A)).toBeNull()
    expect(normalizeWeixinLongPublicArticleUrl(WEIXIN_LONG_A)).toBe(
      WEIXIN_LONG_A,
    )
    expect(WEIXIN_PUBLIC_PAGE_MAX_BYTES).toBe(4 * 1024 * 1024)
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
      name: 'the same short URL',
      candidate: WEIXIN_SHORT_A,
      responseUrl: WEIXIN_SHORT_A,
      redirected: false,
      expectedCanonical: WEIXIN_SHORT_A,
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
    {
      name: 'a different short identity',
      candidate: WEIXIN_SHORT_A,
      responseUrl: 'https://mp.weixin.qq.com/s/Different_123',
      redirected: false,
      errorCode: 'WEIXIN_PUBLIC_RESPONSE_IDENTITY_MISMATCH',
    },
    {
      name: 'a short-to-long identity change',
      candidate: WEIXIN_SHORT_A,
      responseUrl: WEIXIN_LONG_A,
      redirected: false,
      errorCode: 'WEIXIN_PUBLIC_RESPONSE_IDENTITY_MISMATCH',
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

  it('accepts equal public-page ct and oriCreateTime assignments', () => {
    expect(
      parseWeixinPublicArticlePublishedAt(
        `<script>
          var ct = "1720000000";
          oriCreateTime = '1720000000';
        </script>`,
        '2026-08-04T00:00:00.000Z',
      ),
    ).toEqual({
      success: true,
      publishedAt: '2024-07-03T09:46:40.000Z',
    })
  })

  it.each([
    ['ct', '<script>var ct = "1784964127";</script>'],
    [
      'oriCreateTime',
      "<script>var oriCreateTime = '1784964127';</script>",
    ],
  ])(
    'ignores bundled-script ct locals when valid %s metadata is present',
    (_field, metadata) => {
      expect(
        parseWeixinPublicArticlePublishedAt(
          `<script>
            function inspect(value) {
              var ct = serialize(value);
              return ct;
            }
          </script>
          ${metadata}`,
          '2026-08-04T00:00:00.000Z',
        ),
      ).toEqual({
        success: true,
        publishedAt: '2026-07-25T07:22:07.000Z',
      })
    },
  )

  it.each([
    ['var ct = "1720000000";', 'ct'],
    ["oriCreateTime = '1720000000';", 'oriCreateTime'],
  ])('accepts one unique valid %s assignment', (assignment) => {
    expect(
      parseWeixinPublicArticlePublishedAt(
        `<script>${assignment}</script>`,
        '2026-08-04T00:00:00.000Z',
      ),
    ).toEqual({
      success: true,
      publishedAt: '2024-07-03T09:46:40.000Z',
    })
  })

  it('ignores publication-time lookalikes inside the article body', () => {
    expect(
      parseWeixinPublicArticlePublishedAt(
        `<section id="js_content">
          <script>var ct = "1720000001";</script>
        </section>
        <script>oriCreateTime = "1720000000";</script>`,
        '2026-08-04T00:00:00.000Z',
      ),
    ).toEqual({
      success: true,
      publishedAt: '2024-07-03T09:46:40.000Z',
    })
  })

  it.each([
    {
      name: 'missing assignments',
      html: '<script>window.notPublicationTime = 1720000000;</script>',
      errorCode: 'WEIXIN_PUBLIC_PUBLISHED_AT_MISSING',
    },
    {
      name: 'unquoted assignment',
      html: '<script>var ct = 1720000000;</script>',
      errorCode: 'WEIXIN_PUBLIC_PUBLISHED_AT_INVALID',
    },
    {
      name: 'wrong-length assignment',
      html: '<script>var ct = "1720000000000";</script>',
      errorCode: 'WEIXIN_PUBLIC_PUBLISHED_AT_INVALID',
    },
    {
      name: 'pre-2000 assignment',
      html: '<script>var ct = "0000000000";</script>',
      errorCode: 'WEIXIN_PUBLIC_PUBLISHED_AT_INVALID',
    },
    {
      name: 'future assignment',
      html: '<script>var ct = "1999999999";</script>',
      errorCode: 'WEIXIN_PUBLIC_PUBLISHED_AT_INVALID',
    },
    {
      name: 'ambiguous ct assignments',
      html: '<script>var ct = "1720000000";\nvar ct = "1720000001";</script>',
      errorCode: 'WEIXIN_PUBLIC_PUBLISHED_AT_AMBIGUOUS',
    },
    {
      name: 'conflicting ct and oriCreateTime assignments',
      html: '<script>var ct = "1720000000";\noriCreateTime = "1720000001";</script>',
      errorCode: 'WEIXIN_PUBLIC_PUBLISHED_AT_CONFLICT',
    },
  ])('fails closed for $name', ({ html, errorCode }) => {
    expect(
      parseWeixinPublicArticlePublishedAt(html, '2026-08-04T00:00:00.000Z'),
    ).toMatchObject({ success: false, errorCode })
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
