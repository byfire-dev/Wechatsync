import { describe, expect, it } from 'vitest'
import {
  OpenPublicationDraftRequestSchema,
  OpenPublicationDraftResultSchema,
  PublicationInspectRequestSchema,
  PublicationObservationSchema,
  SYNCER_BRIDGE_REQUEST_ID_MAX_LENGTH,
  SyncerAccountProbeV2Schema,
  SyncerAccountV2Schema,
  SyncerAccountsV2DetailedSchema,
} from '../types'

describe('publication inspection contracts', () => {
  it('strictly validates a canonical WeChat draft-open contract', () => {
    const request = {
      requestId: 'open-weixin-1',
      platform: 'weixin',
      externalAccountId: 'gh_account',
      platformPostId: '9001',
    }

    expect(OpenPublicationDraftRequestSchema.parse(request)).toEqual(request)
    expect(
      OpenPublicationDraftRequestSchema.safeParse({
        ...request,
        platformPostId: '09001',
      }).success,
    ).toBe(false)
    expect(
      OpenPublicationDraftRequestSchema.safeParse({
        ...request,
        unexpected: true,
      }).success,
    ).toBe(false)
    expect(OpenPublicationDraftResultSchema.parse({ opened: true })).toEqual({
      opened: true,
    })
    expect(
      OpenPublicationDraftResultSchema.safeParse({
        opened: true,
        url: 'https://mp.weixin.qq.com/cgi-bin/appmsg?token=secret',
      }).success,
    ).toBe(false)
  })

  it('accepts one stable account identity for a supported platform', () => {
    expect(
      SyncerAccountV2Schema.parse({
        platform: 'sohu',
        externalAccountId: 'account-1',
        displayName: '示例账号',
        capabilities: ['account_identity', 'publication_inspect'],
      }),
    ).toMatchObject({ externalAccountId: 'account-1' })
  })

  it('strictly validates detailed account probe invariants', () => {
    const account = {
      platform: 'toutiao',
      externalAccountId: '7390000000000000001',
      displayName: '头条账号',
      capabilities: ['account_identity'],
    }
    const result = {
      accounts: [account],
      probes: [
        {
          platform: 'toutiao',
          status: 'AUTHENTICATED',
          source: 'MAIN_WORLD',
          primaryErrorCode: 'NETWORK_ERROR',
        },
      ],
    }

    expect(SyncerAccountsV2DetailedSchema.parse(result)).toEqual(result)
    expect(
      SyncerAccountProbeV2Schema.safeParse({
        platform: 'toutiao',
        status: 'PROBE_FAILED',
        source: 'EXTENSION',
      }).success,
    ).toBe(false)
    expect(
      SyncerAccountProbeV2Schema.safeParse({
        platform: 'toutiao',
        status: 'NOT_AUTHENTICATED',
        source: 'EXTENSION',
        errorCode: 'NETWORK_ERROR',
      }).success,
    ).toBe(false)
    expect(
      SyncerAccountsV2DetailedSchema.safeParse({
        accounts: [account],
        probes: [
          {
            platform: 'toutiao',
            status: 'PROBE_FAILED',
            source: 'EXTENSION',
            errorCode: 'NETWORK_ERROR',
          },
        ],
      }).success,
    ).toBe(false)
  })

  it('limits one inspection to at most 20 candidates', () => {
    const result = PublicationInspectRequestSchema.safeParse({
      requestId: 'request-1',
      platform: 'zhihu',
      externalAccountId: 'account-1',
      draft: {
        platformPostId: 'post-1',
        draftedAt: '2026-07-21T12:00:00+08:00',
      },
      articleHint: { title: '示例文章' },
      limit: 21,
    })

    expect(result.success).toBe(false)
  })

  it('normalizes request IDs before enforcing the 128-character limit', () => {
    const requestId = 'r'.repeat(SYNCER_BRIDGE_REQUEST_ID_MAX_LENGTH)
    const baseRequest = {
      platform: 'zhihu',
      externalAccountId: 'account-1',
      draft: {
        platformPostId: 'post-1',
        draftedAt: '2026-07-21T12:00:00+08:00',
      },
      articleHint: { title: '示例文章' },
      limit: 20,
    }

    expect(
      PublicationInspectRequestSchema.parse({
        ...baseRequest,
        requestId: ` ${requestId} `,
      }).requestId,
    ).toBe(requestId)
    expect(
      PublicationInspectRequestSchema.safeParse({
        ...baseRequest,
        requestId: `${requestId}x`,
      }).success,
    ).toBe(false)
  })

  it('requires an explicit errorCode for adapter failures', () => {
    const result = PublicationObservationSchema.safeParse({
      observationKey: 'observation-1',
      platform: 'toutiao',
      externalAccountId: 'account-1',
      outcome: 'PARSE_ERROR',
      source: 'PUBLISHED_LIST',
      observedAt: '2026-07-21T12:00:00+08:00',
    })

    expect(result.success).toBe(false)
  })

  it.each(['ACCOUNT_MISMATCH', 'REVIEW_REQUIRED'])(
    'requires an explicit errorCode for %s',
    (outcome) => {
      const result = PublicationObservationSchema.safeParse({
        observationKey: 'observation-1',
        platform: 'sohu',
        externalAccountId: 'account-1',
        outcome,
        source: 'PLATFORM_DETAIL',
        observedAt: '2026-07-21T12:00:00+08:00',
      })

      expect(result.success).toBe(false)
    },
  )

  it.each(['PENDING_REVIEW', 'REJECTED', 'SCHEDULED'])(
    'accepts the explicit platform lifecycle state %s',
    (outcome) => {
      const result = PublicationObservationSchema.safeParse({
        observationKey: 'observation-1',
        platform: 'sohu',
        externalAccountId: 'account-1',
        outcome,
        source: 'PLATFORM_DETAIL',
        platformPostId: 'post-1',
        observedAt: '2026-07-21T12:00:00+08:00',
      })

      expect(result.success).toBe(true)
    },
  )

  it('does not accept a published observation without a stable anchor', () => {
    const result = PublicationObservationSchema.safeParse({
      observationKey: 'observation-1',
      platform: 'weixin',
      externalAccountId: 'account-1',
      outcome: 'PUBLISHED',
      source: 'PUBLISHED_LIST',
      title: '只有标题不够',
      observedAt: '2026-07-21T12:00:00+08:00',
    })

    expect(result.success).toBe(false)
  })

  it('requires a post ID for successful Zhihu article observations', () => {
    const result = PublicationObservationSchema.safeParse({
      observationKey: 'observation-zhihu-draft',
      platform: 'zhihu',
      externalAccountId: 'account-1',
      outcome: 'DRAFT_PRESENT',
      source: 'DRAFT_DETAIL',
      observedAt: '2026-07-21T12:00:00+08:00',
    })

    expect(result.success).toBe(false)
  })

  it('requires post ID, canonical URL, and publication time for published Zhihu observations', () => {
    const base = {
      observationKey: 'observation-zhihu-published',
      platform: 'zhihu' as const,
      externalAccountId: 'account-1',
      outcome: 'PUBLISHED' as const,
      source: 'PUBLIC_PAGE' as const,
      platformPostId: '42',
      observedAt: '2026-07-21T12:00:00+08:00',
    }

    expect(PublicationObservationSchema.safeParse(base).success).toBe(false)
    expect(
      PublicationObservationSchema.safeParse({
        ...base,
        canonicalUrl: 'https://zhuanlan.zhihu.com/p/42',
      }).success,
    ).toBe(false)
    expect(
      PublicationObservationSchema.safeParse({
        ...base,
        canonicalUrl: 'https://zhuanlan.zhihu.com/p/42',
        publishedAt: '2026-07-21T11:55:00+08:00',
      }).success,
    ).toBe(true)
  })

  it('models publication and public access as separate strict dimensions', () => {
    const published = {
      observationKey: 'observation-zhihu-published-access',
      platform: 'zhihu' as const,
      externalAccountId: 'account-1',
      outcome: 'PUBLISHED' as const,
      platformPostId: '42',
      canonicalUrl: 'https://zhuanlan.zhihu.com/p/42',
      publishedAt: '2026-07-21T11:55:00+08:00',
      title: 'Verified authenticated article',
      bodyText: 'Verified authenticated article body',
      observedAt: '2026-07-21T12:00:00+08:00',
    }

    expect(
      PublicationObservationSchema.safeParse({
        ...published,
        source: 'PUBLIC_PAGE',
        publicAccess: { status: 'CONFIRMED' },
      }).success,
    ).toBe(true)
    expect(
      PublicationObservationSchema.safeParse({
        ...published,
        source: 'PUBLIC_PAGE',
      }).success,
    ).toBe(true)
    expect(
      PublicationObservationSchema.safeParse({
        ...published,
        source: 'AUTHENTICATED_PUBLIC_PAGE',
        publicAccess: {
          status: 'BLOCKED_BY_PLATFORM',
          reasonCode: 'ZHIHU_ANONYMOUS_HTTP_403',
        },
      }).success,
    ).toBe(true)

    for (const invalid of [
      {
        ...published,
        source: 'PLATFORM_DETAIL',
      },
      {
        ...published,
        source: 'PUBLISHED_LIST',
      },
      {
        ...published,
        source: 'AUTHENTICATED_PUBLIC_PAGE',
      },
      {
        ...published,
        source: 'AUTHENTICATED_PUBLIC_PAGE',
        publicAccess: { status: 'CONFIRMED' },
      },
      {
        ...published,
        source: 'PUBLIC_PAGE',
        publicAccess: {
          status: 'BLOCKED_BY_PLATFORM',
          reasonCode: 'ZHIHU_ANONYMOUS_HTTP_403',
        },
      },
      {
        ...published,
        source: 'AUTHENTICATED_PUBLIC_PAGE',
        publicAccess: {
          status: 'BLOCKED_BY_PLATFORM',
          reasonCode: 'UNKNOWN_ACCESS_BLOCK',
        },
      },
      {
        ...published,
        source: 'AUTHENTICATED_PUBLIC_PAGE',
        title: undefined,
        publicAccess: {
          status: 'BLOCKED_BY_PLATFORM',
          reasonCode: 'ZHIHU_ANONYMOUS_HTTP_403',
        },
      },
      {
        ...published,
        source: 'AUTHENTICATED_PUBLIC_PAGE',
        bodyText: '   ',
        publicAccess: {
          status: 'BLOCKED_BY_PLATFORM',
          reasonCode: 'ZHIHU_ANONYMOUS_HTTP_403',
        },
      },
      {
        ...published,
        source: 'AUTHENTICATED_PUBLIC_PAGE',
        publicAccess: {
          status: 'BLOCKED_BY_PLATFORM',
          reasonCode: 'ZHIHU_ANONYMOUS_HTTP_403',
        },
        errorCode: 'ZHIHU_PUBLIC_ACCESS_UNVERIFIED',
      },
      {
        ...published,
        outcome: 'DRAFT_PRESENT',
        source: 'DRAFT_DETAIL',
        publicAccess: { status: 'CONFIRMED' },
      },
      {
        ...published,
        platform: 'sohu',
        source: 'AUTHENTICATED_PUBLIC_PAGE',
        publicAccess: {
          status: 'BLOCKED_BY_PLATFORM',
          reasonCode: 'ZHIHU_ANONYMOUS_HTTP_403',
        },
      },
    ]) {
      expect(PublicationObservationSchema.safeParse(invalid).success).toBe(
        false,
      )
    }
  })

  it.each([
    ['zhihu', '42', 'https://zhuanlan.zhihu.com/p/42', {}],
    ['sohu', '1054312481', 'https://www.sohu.com/a/1054312481_120219780', {}],
    [
      'weixin',
      '900000001',
      'https://mp.weixin.qq.com/s?__biz=MzA1AA&mid=1&idx=1',
      {
        title: 'Verified public article',
        bodyText: 'Verified public body',
        bodyTruncated: false,
      },
    ],
  ] as const)(
    'limits published %s article evidence to supported public-page sources',
    (platform, platformPostId, canonicalUrl, platformFacts) => {
      const published = {
        observationKey: `observation-${platform}-published-source`,
        platform,
        externalAccountId: platform === 'sohu' ? '120219780' : 'account-1',
        outcome: 'PUBLISHED' as const,
        platformPostId,
        canonicalUrl,
        publishedAt: '2026-07-21T11:55:00+08:00',
        observedAt: '2026-07-21T12:00:00+08:00',
        ...platformFacts,
      }

      expect(
        PublicationObservationSchema.safeParse({
          ...published,
          source: 'PUBLIC_PAGE',
        }).success,
      ).toBe(true)
      expect(
        PublicationObservationSchema.safeParse({
          ...published,
          source: 'PUBLISHED_LIST',
        }).success,
      ).toBe(false)
      expect(
        PublicationObservationSchema.safeParse({
          ...published,
          source: 'PLATFORM_DETAIL',
        }).success,
      ).toBe(false)
    },
  )

  it('requires a post ID for successful Sohu lifecycle observations', () => {
    const result = PublicationObservationSchema.safeParse({
      observationKey: 'observation-sohu-draft',
      platform: 'sohu',
      externalAccountId: '120219780',
      outcome: 'DRAFT_PRESENT',
      source: 'PLATFORM_DETAIL',
      observedAt: '2026-07-24T16:40:00+08:00',
    })

    expect(result.success).toBe(false)
  })

  it('requires post ID, canonical URL, and publication time for published Sohu observations', () => {
    const base = {
      observationKey: 'observation-sohu-published',
      platform: 'sohu' as const,
      externalAccountId: '120219780',
      outcome: 'PUBLISHED' as const,
      source: 'PUBLIC_PAGE' as const,
      platformPostId: '1054312481',
      observedAt: '2026-07-24T16:41:00+08:00',
    }

    expect(PublicationObservationSchema.safeParse(base).success).toBe(false)
    expect(
      PublicationObservationSchema.safeParse({
        ...base,
        canonicalUrl: 'https://www.sohu.com/a/1054312481_120219780',
      }).success,
    ).toBe(false)
    expect(
      PublicationObservationSchema.safeParse({
        ...base,
        canonicalUrl: 'https://www.sohu.com/a/1054312481_120219780',
        publishedAt: '2026-07-24T16:40:14+08:00',
      }).success,
    ).toBe(true)
  })

  it('requires a post ID for successful WeChat lifecycle observations', () => {
    const result = PublicationObservationSchema.safeParse({
      observationKey: 'observation-weixin-draft',
      platform: 'weixin',
      externalAccountId: 'gh_account_001',
      outcome: 'DRAFT_PRESENT',
      source: 'DRAFT_DETAIL',
      observedAt: '2026-07-24T19:10:00+08:00',
    })

    expect(result.success).toBe(false)
  })

  it('requires complete draft evidence for WeChat DRAFT_PRESENT observations', () => {
    const base = {
      observationKey: 'observation-weixin-draft',
      platform: 'weixin' as const,
      externalAccountId: 'gh_account_001',
      outcome: 'DRAFT_PRESENT' as const,
      source: 'DRAFT_DETAIL' as const,
      platformPostId: '900000001',
      observedAt: '2026-07-24T19:10:00+08:00',
    }

    expect(PublicationObservationSchema.safeParse(base).success).toBe(false)
    expect(
      PublicationObservationSchema.safeParse({
        ...base,
        title: 'Verified draft',
        bodyText: 'Verified draft body',
        bodyTruncated: false,
      }).success,
    ).toBe(true)
    expect(
      PublicationObservationSchema.safeParse({
        ...base,
        title: 'Verified draft',
        bodyText: 'Verified draft body',
        bodyTruncated: false,
        canonicalUrl: 'https://mp.weixin.qq.com/s/AbCdEfGh1234',
      }).success,
    ).toBe(false)
  })

  it('requires exact identity and evidence-only facts for WeChat review results', () => {
    const valid = {
      observationKey: 'observation-weixin-review',
      platform: 'weixin' as const,
      externalAccountId: 'gh_account_001',
      outcome: 'REVIEW_REQUIRED' as const,
      source: 'PUBLISHED_LIST' as const,
      platformPostId: '900000001',
      observedAt: '2026-07-24T19:10:00+08:00',
      errorCode: 'WEIXIN_PUBLISHED_SCAN_INCOMPLETE',
      errorMessage: 'The published-list scan was incomplete.',
    }

    expect(PublicationObservationSchema.safeParse(valid).success).toBe(true)
    expect(
      PublicationObservationSchema.safeParse({
        ...valid,
        platformPostId: undefined,
      }).success,
    ).toBe(false)
    expect(
      PublicationObservationSchema.safeParse({
        ...valid,
        canonicalUrl: 'https://mp.weixin.qq.com/s/AbCdEfGh1234',
      }).success,
    ).toBe(false)
  })

  it('requires post ID, canonical URL, source, and publication time for published WeChat observations', () => {
    const base = {
      observationKey: 'observation-weixin-published',
      platform: 'weixin' as const,
      externalAccountId: 'gh_account_001',
      outcome: 'PUBLISHED' as const,
      source: 'PUBLIC_PAGE' as const,
      platformPostId: '900000001',
      observedAt: '2026-07-24T19:10:00+08:00',
    }

    expect(PublicationObservationSchema.safeParse(base).success).toBe(false)
    expect(
      PublicationObservationSchema.safeParse({
        ...base,
        canonicalUrl: 'https://mp.weixin.qq.com/s?__biz=MzA1AA&mid=1&idx=1',
      }).success,
    ).toBe(false)
    expect(
      PublicationObservationSchema.safeParse({
        ...base,
        canonicalUrl: 'https://mp.weixin.qq.com/s?__biz=MzA1AA&mid=1&idx=1',
        publishedAt: '2026-07-24T19:00:00+08:00',
      }).success,
    ).toBe(false)
    expect(
      PublicationObservationSchema.safeParse({
        ...base,
        canonicalUrl: 'https://mp.weixin.qq.com/s?__biz=MzA1AA&mid=1&idx=1',
        publishedAt: '2026-07-24T19:00:00+08:00',
        title: 'Verified public article',
        bodyText: 'Verified public body',
        bodyTruncated: false,
      }).success,
    ).toBe(true)
    expect(
      PublicationObservationSchema.safeParse({
        ...base,
        source: 'PUBLISHED_LIST',
        canonicalUrl: 'https://mp.weixin.qq.com/s?__biz=MzA1AA&mid=1&idx=1',
        publishedAt: '2026-07-24T19:00:00+08:00',
        title: 'Unverified list title',
        bodyText: 'Unverified list body',
        bodyTruncated: false,
      }).success,
    ).toBe(false)
  })
})
