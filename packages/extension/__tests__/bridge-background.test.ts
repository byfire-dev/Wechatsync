import { describe, expect, it } from 'vitest'

import {
  buildSyncerAccountsV2,
  buildSyncerAccountsV2Detailed,
  createUnsupportedPublicationObservation,
  runOpenPublicationDraft,
  runPublicationInspection,
  validateBridgeMessageSender,
  validateGetAccountsV2Payload,
  validateInspectPublicationPayload,
  validateOpenPublicationDraftPayload,
  validateLegacyMutationMessageSender,
} from '../src/background/bridge-v2'

const EXTENSION_ID = 'a'.repeat(32)

function sender(
  overrides: Partial<chrome.runtime.MessageSender> = {},
): chrome.runtime.MessageSender {
  return {
    origin: 'http://localhost',
    url: 'http://localhost/workspaces/ws-001/articles/article-001',
    frameId: 0,
    tab: {
      id: 42,
      url: 'http://localhost/workspaces/ws-001/articles/article-001',
    } as chrome.tabs.Tab,
    ...overrides,
  }
}

const inspectPayload = {
  requestId: 'inspect-001',
  platform: 'toutiao',
  externalAccountId: 'account-001',
  draft: {
    platformPostId: 'draft-001',
    draftedAt: '2026-07-21T10:00:00+08:00',
  },
  articleHint: {
    title: 'Phase 0 publication verification',
    publishedAfter: '2026-07-21T10:00:00+08:00',
  },
  limit: 20,
}
const openDraftPayload = {
  requestId: 'open-weixin-001',
  platform: 'weixin',
  externalAccountId: 'account-weixin',
  platformPostId: '9001',
}

describe('Bridge v2 background sender boundary', () => {
  it('accepts only a tab-backed top-frame sender from http://localhost', () => {
    expect(validateBridgeMessageSender(sender())).toEqual({
      success: true,
      data: {
        origin: 'http://localhost',
        tabId: 42,
        url: 'http://localhost/workspaces/ws-001/articles/article-001',
      },
    })
  })

  it.each([
    sender({ origin: 'http://localhost:3000', url: 'http://localhost:3000' }),
    sender({
      origin: 'http://127.0.0.1',
      url: 'http://127.0.0.1',
      tab: { id: 42, url: 'http://127.0.0.1' } as chrome.tabs.Tab,
    }),
    sender({ frameId: 1 }),
    sender({ tab: undefined }),
    sender({ url: 'https://localhost/workspaces/ws-001' }),
    sender({
      tab: { id: 42, url: 'http://localhost:3000' } as chrome.tabs.Tab,
    }),
  ])('rejects a non-canonical, sub-frame, or tabless sender', (candidate) => {
    expect(validateBridgeMessageSender(candidate)).toEqual({
      success: false,
      code: 'SENDER_NOT_ALLOWED',
    })
  })
})

describe('Legacy mutation background sender boundary', () => {
  it('accepts the canonical VibeMarket content-script sender', () => {
    expect(
      validateLegacyMutationMessageSender(sender(), EXTENSION_ID),
    ).toMatchObject({
      success: true,
      data: {
        channel: 'bridge',
        origin: 'http://localhost',
        tabId: 42,
      },
    })
  })

  it('accepts a page owned by this extension', () => {
    expect(
      validateLegacyMutationMessageSender(
        {
          id: EXTENSION_ID,
          origin: `chrome-extension://${EXTENSION_ID}`,
          url: `chrome-extension://${EXTENSION_ID}/src/popup/index.html`,
          frameId: 0,
        },
        EXTENSION_ID,
      ),
    ).toEqual({
      success: true,
      data: {
        channel: 'extension',
        origin: `chrome-extension://${EXTENSION_ID}`,
        url: `chrome-extension://${EXTENSION_ID}/src/popup/index.html`,
      },
    })
  })

  it.each([
    sender({
      origin: 'https://attacker.example',
      url: 'https://attacker.example/article',
      tab: {
        id: 42,
        url: 'https://attacker.example/article',
      } as chrome.tabs.Tab,
    }),
    {
      id: 'b'.repeat(32),
      origin: `chrome-extension://${'b'.repeat(32)}`,
      url: `chrome-extension://${'b'.repeat(32)}/popup.html`,
      frameId: 0,
    },
    {
      id: EXTENSION_ID,
      origin: `chrome-extension://${EXTENSION_ID}`,
      url: `chrome-extension://${EXTENSION_ID}/popup.html`,
      frameId: 1,
    },
  ])('rejects an arbitrary web page or another extension', (candidate) => {
    expect(
      validateLegacyMutationMessageSender(candidate, EXTENSION_ID),
    ).toEqual({
      success: false,
      code: 'SENDER_NOT_ALLOWED',
    })
  })
})

describe('Bridge v2 background payload validation', () => {
  it('independently validates and normalizes getAccountsV2 payloads', () => {
    expect(
      validateGetAccountsV2Payload({
        platforms: ['toutiao', 'weixin'],
        forceRefresh: true,
      }),
    ).toEqual({
      success: true,
      data: {
        platforms: ['toutiao', 'weixin'],
        forceRefresh: true,
      },
    })
  })

  it.each([
    undefined,
    { platforms: ['toutiao', 'toutiao'] },
    { platforms: ['baijiahao'] },
    { forceRefresh: 'yes' },
    { forceRefresh: false, extra: true },
  ])('rejects an invalid getAccountsV2 payload', (payload) => {
    expect(validateGetAccountsV2Payload(payload)).toEqual({
      success: false,
      code: 'INVALID_PAYLOAD',
    })
  })

  it('independently validates inspectPublication and binds its request ID', () => {
    expect(
      validateInspectPublicationPayload(inspectPayload, 'inspect-001'),
    ).toEqual({ success: true, data: inspectPayload })

    expect(
      validateInspectPublicationPayload(inspectPayload, 'another-request'),
    ).toEqual({ success: false, code: 'INVALID_PAYLOAD' })
  })

  it('binds inspection payloads after normalizing both request IDs', () => {
    expect(
      validateInspectPublicationPayload(
        { ...inspectPayload, requestId: ' inspect-001 ' },
        ' inspect-001 ',
      ),
    ).toEqual({ success: true, data: inspectPayload })
  })

  it.each([
    { ...inspectPayload, limit: 21 },
    { ...inspectPayload, platform: 'baijiahao' },
    { ...inspectPayload, unexpected: true },
    {
      ...inspectPayload,
      draft: { ...inspectPayload.draft, unexpected: true },
    },
    {
      ...inspectPayload,
      articleHint: { ...inspectPayload.articleHint, unexpected: true },
    },
  ])('rejects an invalid inspectPublication payload', (payload) => {
    expect(validateInspectPublicationPayload(payload, 'inspect-001')).toEqual({
      success: false,
      code: 'INVALID_PAYLOAD',
    })
  })

  it('strictly validates and binds openPublicationDraft', () => {
    expect(
      validateOpenPublicationDraftPayload(
        openDraftPayload,
        openDraftPayload.requestId,
      ),
    ).toEqual({ success: true, data: openDraftPayload })

    for (const payload of [
      { ...openDraftPayload, platformPostId: '0' },
      { ...openDraftPayload, platformPostId: '09001' },
      { ...openDraftPayload, token: 'secret' },
    ]) {
      expect(
        validateOpenPublicationDraftPayload(
          payload,
          openDraftPayload.requestId,
        ),
      ).toEqual({
        success: false,
        code: 'INVALID_PAYLOAD',
      })
    }
    expect(
      validateOpenPublicationDraftPayload(openDraftPayload, 'another-id'),
    ).toEqual({
      success: false,
      code: 'INVALID_PAYLOAD',
    })
  })
})

describe('Bridge v2 account projection', () => {
  it('keeps only authenticated Phase 0 accounts with a stable user ID', () => {
    const accounts = buildSyncerAccountsV2([
      {
        id: 'toutiao',
        name: 'Toutiao',
        isAuthenticated: true,
        username: ' Creator A ',
        userId: ' account-toutiao ',
        avatar: 'https://cdn.example/avatar.png?token=secret#private',
        homepage: 'https://mp.toutiao.com/profile_v4/index',
      },
      {
        id: 'zhihu',
        name: 'Zhihu',
        isAuthenticated: true,
        username: 'Zhihu Creator',
        userId: 'account-zhihu',
      },
      {
        id: 'sohu',
        name: 'Sohu',
        isAuthenticated: true,
        username: 'No stable ID',
      },
      {
        id: 'sohu',
        name: 'Sohu',
        isAuthenticated: true,
        username: 'Sohu Creator',
        userId: '120000001',
      },
      {
        id: 'weixin',
        name: 'WeChat',
        isAuthenticated: true,
        userId: 'account-weixin',
        avatar: 'data:image/png;base64,secret',
        homepage: 'javascript:alert(1)',
      },
      {
        id: 'baijiahao',
        name: 'Out of scope',
        isAuthenticated: true,
        userId: 'account-baijiahao',
      },
    ])

    expect(accounts).toEqual([
      {
        platform: 'toutiao',
        externalAccountId: 'account-toutiao',
        displayName: 'Creator A',
        homepage: 'https://mp.toutiao.com/profile_v4/index',
        capabilities: ['account_identity', 'draft_open'],
      },
      {
        platform: 'zhihu',
        externalAccountId: 'account-zhihu',
        displayName: 'Zhihu Creator',
        capabilities: [
          'account_identity',
          'draft_open',
          'publication_inspect',
          'public_url',
        ],
      },
      {
        platform: 'sohu',
        externalAccountId: '120000001',
        displayName: 'Sohu Creator',
        capabilities: [
          'account_identity',
          'draft_open',
          'publication_inspect',
          'public_url',
        ],
      },
      {
        platform: 'weixin',
        externalAccountId: 'account-weixin',
        displayName: 'WeChat',
        capabilities: [
          'account_identity',
          'draft_open',
          'publication_inspect',
          'public_url',
        ],
      },
    ])
    expect(JSON.stringify(accounts)).not.toContain('secret')
  })

  it('applies the requested platform filter and emits one account per platform', () => {
    const accounts = buildSyncerAccountsV2(
      [
        {
          id: 'toutiao',
          isAuthenticated: true,
          userId: 'first',
          username: 'First',
        },
        {
          id: 'toutiao',
          isAuthenticated: true,
          userId: 'second',
          username: 'Second',
        },
        {
          id: 'zhihu',
          isAuthenticated: true,
          userId: 'zhihu-account',
          username: 'Zhihu',
        },
      ],
      ['toutiao'],
    )

    expect(accounts).toHaveLength(1)
    expect(accounts[0]).toMatchObject({
      platform: 'toutiao',
      externalAccountId: 'first',
      capabilities: ['account_identity', 'draft_open'],
    })
  })

  it('projects authenticated, logged-out and failed probes without leaking errors', () => {
    const detailed = buildSyncerAccountsV2Detailed(
      [
        {
          id: 'toutiao',
          isAuthenticated: true,
          userId: '7390000000000000001',
          username: 'Toutiao',
          probeStatus: 'AUTHENTICATED',
          probeSource: 'MAIN_WORLD',
          primaryProbeErrorCode: 'NETWORK_ERROR',
        },
        {
          id: 'zhihu',
          isAuthenticated: false,
          probeStatus: 'NOT_AUTHENTICATED',
          probeSource: 'EXTENSION',
        },
        {
          id: 'sohu',
          isAuthenticated: false,
          error: 'cookie=secret-token',
          probeStatus: 'PROBE_FAILED',
          probeSource: 'EXTENSION',
          probeErrorCode: 'HTTP_ERROR',
        },
        {
          id: 'weixin',
          isAuthenticated: false,
        },
      ],
      ['toutiao', 'zhihu', 'sohu', 'weixin'],
    )

    expect(detailed).toEqual({
      accounts: [
        {
          platform: 'toutiao',
          externalAccountId: '7390000000000000001',
          displayName: 'Toutiao',
          capabilities: ['account_identity', 'draft_open'],
        },
      ],
      probes: [
        {
          platform: 'toutiao',
          status: 'AUTHENTICATED',
          source: 'MAIN_WORLD',
          primaryErrorCode: 'NETWORK_ERROR',
        },
        {
          platform: 'zhihu',
          status: 'NOT_AUTHENTICATED',
          source: 'EXTENSION',
        },
        {
          platform: 'sohu',
          status: 'PROBE_FAILED',
          source: 'EXTENSION',
          errorCode: 'HTTP_ERROR',
        },
        {
          platform: 'weixin',
          status: 'PROBE_FAILED',
          source: 'EXTENSION',
          errorCode: 'UNKNOWN_ERROR',
        },
      ],
    })
    expect(JSON.stringify(detailed)).not.toContain('secret-token')
  })
})

describe('Bridge v2 authenticated draft opening', () => {
  it('fails closed when an adapter does not expose the draft-open capability', async () => {
    await expect(
      runOpenPublicationDraft(openDraftPayload, {
        probeAccounts: vi.fn(),
      }),
    ).rejects.toThrow('PUBLICATION_DRAFT_OPEN_NOT_SUPPORTED')
  })

  it('re-authenticates, binds the account, and returns only opened=true', async () => {
    const events: string[] = []
    const probeAccounts = vi.fn(async () => {
      events.push('probe')
      return {
        status: 'AUTHENTICATED' as const,
        accounts: [
          {
            externalAccountId: openDraftPayload.externalAccountId,
            displayName: 'Bound account',
          },
        ],
      }
    })
    const openPublicationDraft = vi.fn(async () => {
      events.push('open')
      return { opened: true as const }
    })

    await expect(
      runOpenPublicationDraft(openDraftPayload, {
        probeAccounts,
        openPublicationDraft,
      }),
    ).resolves.toEqual({ opened: true })
    expect(events).toEqual(['probe', 'open'])
    expect(openPublicationDraft).toHaveBeenCalledWith(
      openDraftPayload,
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        verifiedAccountProbe: expect.objectContaining({
          status: 'AUTHENTICATED',
        }),
      }),
    )
  })

  it('uses one end-to-end deadline for authentication and tab opening', async () => {
    vi.useFakeTimers()
    try {
      let probeSignal: AbortSignal | undefined
      let openSignal: AbortSignal | undefined
      const probeAccounts = vi.fn(async (context) => {
        probeSignal = context?.signal
        await new Promise((resolve) => setTimeout(resolve, 7))
        return {
          status: 'AUTHENTICATED' as const,
          accounts: [
            {
              externalAccountId: openDraftPayload.externalAccountId,
              displayName: 'Bound account',
            },
          ],
        }
      })
      const openPublicationDraft = vi.fn((_request, context) => {
        openSignal = context?.signal
        return new Promise((_resolve, reject) => {
          context?.signal?.addEventListener(
            'abort',
            () => reject(context.signal?.reason),
            { once: true },
          )
        })
      })
      const result = runOpenPublicationDraft(
        openDraftPayload,
        { probeAccounts, openPublicationDraft },
        10,
      )
      const rejection = expect(result).rejects.toThrow(
        'PUBLICATION_DRAFT_OPEN_FAILED',
      )

      await vi.advanceTimersByTimeAsync(7)
      expect(openPublicationDraft).toHaveBeenCalledTimes(1)
      expect(openSignal).toBe(probeSignal)

      await vi.advanceTimersByTimeAsync(3)
      await rejection
      expect(openSignal?.aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not open a draft for another active account', async () => {
    const openPublicationDraft = vi.fn()

    await expect(
      runOpenPublicationDraft(openDraftPayload, {
        probeAccounts: vi.fn().mockResolvedValue({
          status: 'AUTHENTICATED',
          accounts: [
            {
              externalAccountId: 'another-account',
              displayName: 'Another account',
            },
          ],
        }),
        openPublicationDraft,
      }),
    ).rejects.toThrow('ACCOUNT_MISMATCH')
    expect(openPublicationDraft).not.toHaveBeenCalled()
  })

  it('rejects over-broad results and redacts adapter exception details', async () => {
    const adapter = {
      probeAccounts: vi.fn().mockResolvedValue({
        status: 'AUTHENTICATED',
        accounts: [
          {
            externalAccountId: openDraftPayload.externalAccountId,
            displayName: 'Bound account',
          },
        ],
      }),
      openPublicationDraft: vi.fn(),
    }

    adapter.openPublicationDraft.mockResolvedValueOnce({
      opened: true,
      url: 'https://mp.weixin.qq.com/cgi-bin/appmsg?token=secret',
    })
    await expect(
      runOpenPublicationDraft(openDraftPayload, adapter),
    ).rejects.toThrow('INVALID_DRAFT_OPEN_RESULT')

    adapter.openPublicationDraft.mockRejectedValueOnce(
      new Error(
        'Cannot open https://mp.weixin.qq.com/cgi-bin/appmsg?token=secret',
      ),
    )
    await expect(
      runOpenPublicationDraft(openDraftPayload, adapter),
    ).rejects.toThrow('PUBLICATION_DRAFT_OPEN_FAILED')
  })
})

describe('Bridge v2 unsupported inspection prototype', () => {
  it('returns an explicit UNSUPPORTED observation instead of NOT_FOUND', () => {
    const request = validateInspectPublicationPayload(
      inspectPayload,
      'inspect-001',
    )
    expect(request.success).toBe(true)
    if (!request.success) return

    expect(
      createUnsupportedPublicationObservation(
        request.data,
        '2026-07-21T12:00:00.000Z',
      ),
    ).toEqual({
      observationKey: 'bridge-v2:inspect-001:toutiao:unsupported',
      platform: 'toutiao',
      externalAccountId: 'account-001',
      outcome: 'UNSUPPORTED',
      source: 'PLATFORM_DETAIL',
      observedAt: '2026-07-21T12:00:00.000Z',
      errorCode: 'PUBLICATION_INSPECTION_NOT_IMPLEMENTED',
      errorMessage:
        'Publication inspection is not implemented for toutiao in Phase 0.',
    })
  })

  it('does not execute an inspector for a paused platform', async () => {
    const request = validateInspectPublicationPayload(
      inspectPayload,
      'inspect-001',
    )
    expect(request.success).toBe(true)
    if (!request.success) return

    const inspectPublication = vi.fn().mockResolvedValue([])
    const provePublishedObservation = vi.fn()
    const observations = await runPublicationInspection(request.data, {
      inspectPublication,
      provePublishedObservation,
    })

    expect(inspectPublication).not.toHaveBeenCalled()
    expect(provePublishedObservation).not.toHaveBeenCalled()
    expect(observations).toHaveLength(1)
    expect(observations[0]).toMatchObject({
      platform: 'toutiao',
      outcome: 'UNSUPPORTED',
    })
  })
})

describe('Bridge v2 inspection execution boundary', () => {
  const request = {
    ...inspectPayload,
    platform: 'zhihu' as const,
    externalAccountId: 'zhihu-account',
    draft: {
      platformPostId: '42',
      draftedAt: inspectPayload.draft.draftedAt,
    },
  }

  it('accepts a valid adapter result and canonicalizes its public URL', async () => {
    await expect(
      runPublicationInspection(request, {
        inspectPublication: async () => [
          {
            observationKey: 'zhihu:42:published',
            platform: 'zhihu',
            externalAccountId: 'zhihu-account',
            outcome: 'PUBLISHED',
            source: 'PUBLIC_PAGE',
            platformPostId: '42',
            canonicalUrl: 'https://zhuanlan.zhihu.com/p/42?utm_source=test',
            publishedAt: '2026-07-21T11:55:00.000Z',
            publicAccess: {
              status: 'CONFIRMED',
              checkedUrl: 'https://zhuanlan.zhihu.com/p/42?utm_source=test',
              checkedPublicIdentityKey: 'zhihu:post:v1:42',
              checkedAt: '2026-07-21T11:59:00.000Z',
              httpStatus: 200,
            },
            observedAt: '2026-07-21T12:00:00.000Z',
          },
        ],
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        outcome: 'PUBLISHED',
        canonicalUrl: 'https://zhuanlan.zhihu.com/p/42',
        publicAccess: { status: 'CONFIRMED' },
      }),
    ])
  })

  it('accepts a published Zhihu result when only anonymous access is blocked', async () => {
    await expect(
      runPublicationInspection(request, {
        inspectPublication: async () => [
          {
            observationKey: 'zhihu:42:authenticated-published',
            platform: 'zhihu',
            externalAccountId: 'zhihu-account',
            outcome: 'PUBLISHED',
            source: 'AUTHENTICATED_PUBLIC_PAGE',
            platformPostId: '42',
            canonicalUrl: 'https://zhuanlan.zhihu.com/p/42',
            publishedAt: '2026-07-21T11:55:00.000Z',
            title: 'Verified authenticated article',
            bodyText: 'Verified authenticated article body',
            publicAccess: {
              status: 'BLOCKED_BY_PLATFORM',
              checkedUrl: 'https://zhuanlan.zhihu.com/p/42',
              checkedPublicIdentityKey: 'zhihu:post:v1:42',
              checkedAt: '2026-07-21T11:59:00.000Z',
              httpStatus: 403,
              reasonCode: 'ZHIHU_ANONYMOUS_HTTP_403',
            },
            observedAt: '2026-07-21T12:00:00.000Z',
          },
        ],
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        outcome: 'PUBLISHED',
        source: 'AUTHENTICATED_PUBLIC_PAGE',
        canonicalUrl: 'https://zhuanlan.zhihu.com/p/42',
        publicAccess: {
          status: 'BLOCKED_BY_PLATFORM',
          reasonCode: 'ZHIHU_ANONYMOUS_HTTP_403',
        },
      }),
    ])
  })

  it.each([
    [
      'an observed post ID different from the request',
      {
        platformPostId: '43',
        canonicalUrl: 'https://zhuanlan.zhihu.com/p/43',
      },
    ],
    [
      'a canonical URL for another post ID',
      {
        platformPostId: '42',
        canonicalUrl: 'https://zhuanlan.zhihu.com/p/43',
      },
    ],
    [
      'a missing canonical URL',
      {
        platformPostId: '42',
        canonicalUrl: undefined,
      },
    ],
    [
      'a missing publication time',
      {
        platformPostId: '42',
        canonicalUrl: 'https://zhuanlan.zhihu.com/p/42',
        publishedAt: undefined,
      },
    ],
    [
      'a legacy platform-detail publication source',
      {
        source: 'PLATFORM_DETAIL',
        platformPostId: '42',
        canonicalUrl: 'https://zhuanlan.zhihu.com/p/42',
      },
    ],
    [
      'an authenticated public page without a public access status',
      {
        source: 'AUTHENTICATED_PUBLIC_PAGE',
        platformPostId: '42',
        canonicalUrl: 'https://zhuanlan.zhihu.com/p/42',
      },
    ],
    [
      'an authenticated public page without a verified title',
      {
        source: 'AUTHENTICATED_PUBLIC_PAGE',
        platformPostId: '42',
        canonicalUrl: 'https://zhuanlan.zhihu.com/p/42',
        bodyText: 'Verified authenticated article body',
        publicAccess: {
          status: 'BLOCKED_BY_PLATFORM',
          reasonCode: 'ZHIHU_ANONYMOUS_HTTP_403',
        },
      },
    ],
    [
      'an authenticated public page without verified body text',
      {
        source: 'AUTHENTICATED_PUBLIC_PAGE',
        platformPostId: '42',
        canonicalUrl: 'https://zhuanlan.zhihu.com/p/42',
        title: 'Verified authenticated article',
        bodyText: '   ',
        publicAccess: {
          status: 'BLOCKED_BY_PLATFORM',
          reasonCode: 'ZHIHU_ANONYMOUS_HTTP_403',
        },
      },
    ],
  ])('rejects published Zhihu output with %s', async (_name, overrides) => {
    const observations = await runPublicationInspection(request, {
      inspectPublication: async () =>
        [
          {
            observationKey: 'zhihu:42:published-invalid',
            platform: 'zhihu',
            externalAccountId: 'zhihu-account',
            outcome: 'PUBLISHED',
            source: 'PUBLIC_PAGE',
            publishedAt: '2026-07-21T11:55:00.000Z',
            observedAt: '2026-07-21T12:00:00.000Z',
            ...overrides,
          },
        ] as never,
    })

    expect(observations[0]).toMatchObject({
      outcome: 'PARSE_ERROR',
      errorCode: 'INVALID_INSPECTION_RESULT',
    })
  })

  it('rejects a successful Zhihu draft observation for another post ID', async () => {
    const observations = await runPublicationInspection(request, {
      inspectPublication: async () => [
        {
          observationKey: 'zhihu:43:draft',
          platform: 'zhihu',
          externalAccountId: 'zhihu-account',
          outcome: 'DRAFT_PRESENT',
          source: 'DRAFT_DETAIL',
          platformPostId: '43',
          observedAt: '2026-07-21T12:00:00.000Z',
        },
      ],
    })

    expect(observations[0]).toMatchObject({
      outcome: 'PARSE_ERROR',
      errorCode: 'INVALID_INSPECTION_RESULT',
    })
  })

  it.each([
    [],
    [
      {
        observationKey: 'wrong-account',
        platform: 'zhihu',
        externalAccountId: 'another-account',
        outcome: 'NOT_FOUND',
        source: 'PUBLIC_PAGE',
        observedAt: '2026-07-21T12:00:00.000Z',
      },
    ],
  ])('turns invalid adapter output into PARSE_ERROR', async (value) => {
    const observations = await runPublicationInspection(request, {
      inspectPublication: async () => value as never,
    })
    expect(observations[0]).toMatchObject({
      outcome: 'PARSE_ERROR',
      errorCode: 'INVALID_INSPECTION_RESULT',
    })
  })

  it('turns adapter exceptions and timeouts into FETCH_ERROR', async () => {
    const failed = await runPublicationInspection(request, {
      inspectPublication: async () => {
        throw new Error('secret platform response')
      },
    })
    expect(failed[0]).toMatchObject({
      outcome: 'FETCH_ERROR',
      errorCode: 'PUBLICATION_INSPECTION_FAILED',
      errorMessage: 'The platform inspection failed.',
    })
    expect(JSON.stringify(failed)).not.toContain('secret platform response')

    let inspectionSignal: AbortSignal | undefined
    const timedOut = await runPublicationInspection(
      request,
      {
        inspectPublication: (_request, context) => {
          inspectionSignal = context?.signal
          return new Promise((_resolve, reject) => {
            context?.signal?.addEventListener(
              'abort',
              () => reject(context.signal?.reason),
              { once: true },
            )
          })
        },
      },
      1,
    )
    expect(timedOut[0]).toMatchObject({
      outcome: 'FETCH_ERROR',
      errorCode: 'PUBLICATION_INSPECTION_TIMEOUT',
    })
    expect(inspectionSignal?.aborted).toBe(true)
  })
})

describe('Bridge v2 Sohu inspection identity boundary', () => {
  const request = {
    ...inspectPayload,
    platform: 'sohu' as const,
    externalAccountId: '120000001',
    draft: {
      platformPostId: '1000000001',
      draftedAt: inspectPayload.draft.draftedAt,
    },
  }
  const canonicalUrl = 'https://www.sohu.com/a/1000000001_120000001'

  it('executes the Sohu inspector and accepts an exact published identity', async () => {
    const inspectPublication = vi.fn().mockResolvedValue([
      {
        observationKey: 'sohu:1000000001:published',
        platform: 'sohu',
        externalAccountId: '120000001',
        outcome: 'PUBLISHED',
        source: 'PUBLIC_PAGE',
        platformPostId: '1000000001',
        canonicalUrl: `${canonicalUrl}?spm=tracking`,
        publishedAt: '2026-07-21T11:55:00.000Z',
        publicAccess: {
          status: 'CONFIRMED',
          checkedUrl: `${canonicalUrl}?spm=tracking`,
          checkedPublicIdentityKey: 'sohu:post:v1:1000000001:120000001',
          checkedAt: '2026-07-21T11:59:00.000Z',
          httpStatus: 200,
        },
        observedAt: '2026-07-21T12:00:00.000Z',
      },
    ])

    const observations = await runPublicationInspection(request, {
      inspectPublication,
    })

    expect(inspectPublication).toHaveBeenCalledWith(
      request,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(observations).toEqual([
      expect.objectContaining({
        outcome: 'PUBLISHED',
        platformPostId: '1000000001',
        canonicalUrl,
      }),
    ])
  })

  it('resolves the exact post ID from a verified Sohu draft URL', async () => {
    const urlOnlyRequest = {
      ...request,
      draft: {
        draftUrl:
          'https://mp.sohu.com/mpfe/v4/contentManagement/news/addarticle?id=1000000001&accountId=120000001',
        draftedAt: inspectPayload.draft.draftedAt,
      },
    }

    const observations = await runPublicationInspection(urlOnlyRequest, {
      inspectPublication: async () => [
        {
          observationKey: 'sohu:1000000001:draft',
          platform: 'sohu',
          externalAccountId: '120000001',
          outcome: 'DRAFT_PRESENT',
          source: 'DRAFT_DETAIL',
          platformPostId: '1000000001',
          observedAt: '2026-07-21T12:00:00.000Z',
        },
      ],
    })

    expect(observations[0]).toMatchObject({
      outcome: 'DRAFT_PRESENT',
      platformPostId: '1000000001',
    })
  })

  it.each([
    [
      'a conflicting draft post ID',
      'https://mp.sohu.com/mpfe/v4/contentManagement/news/addarticle?id=1000000002&accountId=120000001',
    ],
    [
      'a draft URL bound to another account',
      'https://mp.sohu.com/mpfe/v4/contentManagement/news/addarticle?id=1000000001&accountId=120000002',
    ],
  ])(
    'rejects Sohu lifecycle output when the request has %s',
    async (_name, draftUrl) => {
      const observations = await runPublicationInspection(
        {
          ...request,
          draft: {
            ...request.draft,
            draftUrl,
          },
        },
        {
          inspectPublication: async () => [
            {
              observationKey: 'sohu:1000000001:draft-invalid-request',
              platform: 'sohu',
              externalAccountId: '120000001',
              outcome: 'DRAFT_PRESENT',
              source: 'DRAFT_DETAIL',
              platformPostId: '1000000001',
              observedAt: '2026-07-21T12:00:00.000Z',
            },
          ],
        },
      )

      expect(observations[0]).toMatchObject({
        outcome: 'PARSE_ERROR',
        errorCode: 'INVALID_INSPECTION_RESULT',
      })
    },
  )

  it.each([
    [
      'another observed post ID',
      {
        platformPostId: '1000000002',
        canonicalUrl: 'https://www.sohu.com/a/1000000002_120000001',
      },
    ],
    [
      'another canonical post ID',
      {
        platformPostId: '1000000001',
        canonicalUrl: 'https://www.sohu.com/a/1000000002_120000001',
      },
    ],
    [
      'another canonical account ID',
      {
        platformPostId: '1000000001',
        canonicalUrl: 'https://www.sohu.com/a/1000000001_120000002',
      },
    ],
    [
      'no canonical URL',
      {
        platformPostId: '1000000001',
        canonicalUrl: undefined,
      },
    ],
    [
      'no publication time',
      {
        platformPostId: '1000000001',
        canonicalUrl,
        publishedAt: undefined,
      },
    ],
    [
      'a non-public evidence source',
      {
        source: 'PLATFORM_DETAIL',
        platformPostId: '1000000001',
        canonicalUrl,
      },
    ],
  ])('rejects a published Sohu result with %s', async (_name, overrides) => {
    const observations = await runPublicationInspection(request, {
      inspectPublication: async () =>
        [
          {
            observationKey: 'sohu:1000000001:published-invalid',
            platform: 'sohu',
            externalAccountId: '120000001',
            outcome: 'PUBLISHED',
            source: 'PUBLIC_PAGE',
            publishedAt: '2026-07-21T11:55:00.000Z',
            observedAt: '2026-07-21T12:00:00.000Z',
            ...overrides,
          },
        ] as never,
    })

    expect(observations[0]).toMatchObject({
      outcome: 'PARSE_ERROR',
      errorCode: 'INVALID_INSPECTION_RESULT',
    })
  })

  it.each([
    'DRAFT_PRESENT',
    'PENDING_REVIEW',
    'REJECTED',
    'SCHEDULED',
    'NOT_FOUND',
    'DELETED',
  ] as const)('binds %s to the exact requested post ID', async (outcome) => {
    const exact = await runPublicationInspection(request, {
      inspectPublication: async () => [
        {
          observationKey: `sohu:1000000001:${outcome}`,
          platform: 'sohu',
          externalAccountId: '120000001',
          outcome,
          source: 'PLATFORM_DETAIL',
          platformPostId: '1000000001',
          observedAt: '2026-07-21T12:00:00.000Z',
        },
      ],
    })
    expect(exact[0]).toMatchObject({
      outcome,
      platformPostId: '1000000001',
    })

    const mismatched = await runPublicationInspection(request, {
      inspectPublication: async () => [
        {
          observationKey: `sohu:1000000002:${outcome}`,
          platform: 'sohu',
          externalAccountId: '120000001',
          outcome,
          source: 'PLATFORM_DETAIL',
          platformPostId: '1000000002',
          observedAt: '2026-07-21T12:00:00.000Z',
        },
      ],
    })
    expect(mismatched[0]).toMatchObject({
      outcome: 'PARSE_ERROR',
      errorCode: 'INVALID_INSPECTION_RESULT',
    })
  })
})

describe('Bridge v2 WeChat inspection identity boundary', () => {
  const request = {
    ...inspectPayload,
    platform: 'weixin' as const,
    externalAccountId: 'account-weixin',
    draft: {
      platformPostId: '9001',
      draftUrl:
        'https://mp.weixin.qq.com/cgi-bin/appmsg?action=edit&appmsgid=9001&token=old-token',
      draftedAt: inspectPayload.draft.draftedAt,
    },
  }

  it('returns a schema-valid unsupported result bound to the requested appMsgId', async () => {
    const observations = await runPublicationInspection(request, null)

    expect(observations).toEqual([
      expect.objectContaining({
        platform: 'weixin',
        outcome: 'UNSUPPORTED',
        source: 'DRAFT_DETAIL',
        platformPostId: '9001',
        errorCode: 'PUBLICATION_INSPECTION_NOT_IMPLEMENTED',
      }),
    ])
  })

  it('accepts DRAFT_PRESENT for the exact requested appMsgId', async () => {
    const inspectPublication = vi.fn().mockResolvedValue([
      {
        observationKey: 'weixin:9001:draft',
        platform: 'weixin',
        externalAccountId: 'account-weixin',
        outcome: 'DRAFT_PRESENT',
        source: 'DRAFT_DETAIL',
        platformPostId: '9001',
        title: 'Verified WeChat draft',
        bodyText: 'Verified WeChat draft body',
        bodyTruncated: false,
        observedAt: '2026-07-24T12:00:00.000Z',
      },
    ])

    const observations = await runPublicationInspection(request, {
      inspectPublication,
    })

    expect(inspectPublication).toHaveBeenCalledWith(
      request,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(observations).toEqual([
      expect.objectContaining({
        outcome: 'DRAFT_PRESENT',
        platformPostId: '9001',
      }),
    ])
  })

  it('rejects a WeChat review result for a different appMsgId', async () => {
    const observations = await runPublicationInspection(request, {
      inspectPublication: async () => [
        {
          observationKey: 'weixin:9002:review',
          platform: 'weixin',
          externalAccountId: 'account-weixin',
          outcome: 'REVIEW_REQUIRED',
          source: 'DRAFT_DETAIL',
          platformPostId: '9002',
          observedAt: '2026-07-24T12:00:00.000Z',
          errorCode: 'WEIXIN_DRAFT_STATE_REVIEW_REQUIRED',
          errorMessage: 'Manual review is required.',
        },
      ],
    })

    expect(observations[0]).toMatchObject({
      platform: 'weixin',
      outcome: 'PARSE_ERROR',
      source: 'DRAFT_DETAIL',
      platformPostId: '9001',
      errorCode: 'INVALID_INSPECTION_RESULT',
    })
  })

  it.each([
    [
      'a different observed appMsgId',
      request,
      {
        outcome: 'DRAFT_PRESENT',
        source: 'DRAFT_DETAIL',
        platformPostId: '9002',
      },
    ],
    [
      'a conflicting request locator',
      {
        ...request,
        draft: {
          ...request.draft,
          draftUrl:
            'https://mp.weixin.qq.com/cgi-bin/appmsg?action=edit&appmsgid=9002',
        },
      },
      {
        outcome: 'DRAFT_PRESENT',
        source: 'DRAFT_DETAIL',
        platformPostId: '9001',
      },
    ],
    [
      'an unverified NOT_FOUND lifecycle result',
      request,
      {
        outcome: 'NOT_FOUND',
        source: 'PLATFORM_DETAIL',
        platformPostId: '9001',
      },
    ],
  ] as const)(
    'rejects %s',
    async (_name, candidateRequest, observationOverrides) => {
      const observations = await runPublicationInspection(candidateRequest, {
        inspectPublication: async () =>
          [
            {
              observationKey: 'weixin:9001:invalid',
              platform: 'weixin',
              externalAccountId: 'account-weixin',
              observedAt: '2026-07-24T12:00:00.000Z',
              ...observationOverrides,
            },
          ] as never,
      })

      expect(observations[0]).toMatchObject({
        outcome: 'PARSE_ERROR',
        errorCode: 'INVALID_INSPECTION_RESULT',
      })
    },
  )

  it('accepts a verified public URL while preserving the original appMsgId', async () => {
    const observations = await runPublicationInspection(request, {
      inspectPublication: async () => [
        {
          observationKey: 'weixin:9001:published',
          platform: 'weixin',
          externalAccountId: 'account-weixin',
          outcome: 'PUBLISHED',
          source: 'PUBLIC_PAGE',
          platformPostId: '9001',
          canonicalUrl: 'https://mp.weixin.qq.com/s?__biz=MzA1AA&mid=1&idx=1',
          publishedAt: '2026-07-24T11:55:00.000Z',
          title: 'Verified public article',
          bodyText: 'Verified public body',
          bodyTruncated: false,
          publicAccess: {
            status: 'CONFIRMED',
            checkedUrl: 'https://mp.weixin.qq.com/s?__biz=MzA1AA&mid=1&idx=1',
            checkedPublicIdentityKey: 'weixin:article:v1:MzA1AA:1:1',
            checkedAt: '2026-07-24T11:59:00.000Z',
            httpStatus: 200,
          },
          observedAt: '2026-07-24T12:00:00.000Z',
        },
      ],
    })

    expect(observations).toEqual([
      expect.objectContaining({
        outcome: 'PUBLISHED',
        source: 'PUBLIC_PAGE',
        platformPostId: '9001',
        canonicalUrl: 'https://mp.weixin.qq.com/s?__biz=MzA1AA&mid=1&idx=1',
      }),
    ])
    expect(observations[0]?.publicAccess).toEqual({ status: 'CONFIRMED' })
  })

  it.each([
    {
      source: 'PUBLISHED_LIST',
      platformPostId: '9001',
      canonicalUrl:
        'https://mp.weixin.qq.com/s?__biz=MzA0000000000%3D%3D&mid=1&idx=1',
    },
    {
      source: 'PUBLIC_PAGE',
      platformPostId: '9002',
      canonicalUrl:
        'https://mp.weixin.qq.com/s?__biz=MzA0000000000%3D%3D&mid=1&idx=1',
    },
    {
      source: 'PUBLIC_PAGE',
      platformPostId: '9001',
      canonicalUrl: 'https://attacker.example/s?mid=1&idx=1',
    },
    {
      source: 'PUBLIC_PAGE',
      platformPostId: '9001',
      canonicalUrl:
        'https://mp.weixin.qq.com/s?__biz=MzA0000000000%3D%3D&mid=1&idx=1',
      bodyText: '',
    },
  ] as const)(
    'rejects a PUBLISHED result without the exact bridge proof boundary',
    async (overrides) => {
      const observations = await runPublicationInspection(request, {
        inspectPublication: async () =>
          [
            {
              observationKey: 'weixin:9001:published-invalid',
              platform: 'weixin',
              externalAccountId: 'account-weixin',
              outcome: 'PUBLISHED',
              publishedAt: '2026-07-24T11:55:00.000Z',
              title: 'Verified public article',
              bodyText: 'Verified public body',
              bodyTruncated: false,
              observedAt: '2026-07-24T12:00:00.000Z',
              ...overrides,
            },
          ] as never,
      })

      expect(observations[0]).toMatchObject({
        outcome: 'PARSE_ERROR',
        errorCode: 'INVALID_INSPECTION_RESULT',
      })
    },
  )
})
