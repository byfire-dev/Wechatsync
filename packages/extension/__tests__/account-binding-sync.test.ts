import { beforeEach, describe, expect, it, vi } from 'vitest'

const syncTestState = vi.hoisted(() => ({
  publish: vi.fn(),
  probeAccounts: vi.fn(),
  exposeProbe: true,
  metas: [
    {
      id: 'sohu',
      name: 'Sohu',
      icon: 'sohu.svg',
      homepage: 'https://mp.sohu.com',
      capabilities: ['article', 'draft', 'account_binding'],
    },
  ] as Array<{
    id: string
    name: string
    icon: string
    homepage: string
    capabilities: string[]
  }>,
}))

const syncAnalyticsState = vi.hoisted(() => ({
  trackPlatformSync: vi.fn(async () => {}),
  trackSyncComplete: vi.fn(async () => {}),
}))

vi.mock('../src/lib/analytics', () => ({
  trackSyncStart: vi.fn(async () => {}),
  trackPlatformSync: syncAnalyticsState.trackPlatformSync,
  trackSyncComplete: syncAnalyticsState.trackSyncComplete,
  inferErrorType: vi.fn(() => 'unknown'),
  trackPlatformCombination: vi.fn(async () => {}),
  trackUsageTime: vi.fn(async () => {}),
  updateCumulativeStats: vi.fn(async () => {}),
  trackMilestone: vi.fn(async () => {}),
  trackAuthCheck: vi.fn(async () => {}),
}))

vi.mock('@wechatsync/core', () => {
  class DummyAdapter {
    meta = syncTestState.metas[0]
  }

  const normalizeAdapterAccountBinding = (value: unknown) => {
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value) ||
      Object.keys(value).length !== 1 ||
      !Object.prototype.hasOwnProperty.call(value, 'externalAccountId')
    ) {
      return null
    }
    const externalAccountId = (
      value as { externalAccountId?: unknown }
    ).externalAccountId
    if (typeof externalAccountId !== 'string') return null
    const normalized = externalAccountId.trim()
    return normalized ? { externalAccountId: normalized } : null
  }

  const normalizeAdapterExternalAccountId = (value: unknown) => {
    if (typeof value !== 'string') return null
    const normalized = value.trim()
    if (
      normalized.length === 0 ||
      normalized.length > 500 ||
      /[\u0000-\u001f\u007f]/.test(normalized)
    ) {
      return null
    }
    return normalized
  }

  return {
    adapterRegistry: {
      setRuntime: vi.fn(),
      register: vi.fn(),
      getAllMeta: vi.fn(() => syncTestState.metas),
      get: vi.fn(async (platformId: string) => {
        const meta = syncTestState.metas.find(
          (candidate) => candidate.id === platformId,
        )
        if (!meta) return null
        return {
          meta,
          publish: (article: unknown, options: unknown) =>
            syncTestState.publish(platformId, article, options),
          ...(syncTestState.exposeProbe
            ? { probeAccounts: syncTestState.probeAccounts }
            : {}),
        }
      }),
      getPreprocessConfig: vi.fn(),
      getPreprocessConfigs: vi.fn(),
    },
    normalizeAdapterAccountBinding,
    normalizeAdapterExternalAccountId,
    ZhihuAdapter: DummyAdapter,
    ToutiaoAdapter: DummyAdapter,
    JuejinAdapter: DummyAdapter,
    WeiboAdapter: DummyAdapter,
    BilibiliAdapter: DummyAdapter,
    BaijiahaoAdapter: DummyAdapter,
    CSDNAdapter: DummyAdapter,
    YuqueAdapter: DummyAdapter,
    DoubanAdapter: DummyAdapter,
    SohuAdapter: DummyAdapter,
    XueqiuAdapter: DummyAdapter,
    WeixinAdapter: DummyAdapter,
    WoshipmAdapter: DummyAdapter,
    Cto51Adapter: DummyAdapter,
    ImoocAdapter: DummyAdapter,
    OschinaAdapter: DummyAdapter,
    SegmentfaultAdapter: DummyAdapter,
    CnblogsAdapter: DummyAdapter,
    ZipDownloadAdapter: DummyAdapter,
    EastmoneyAdapter: DummyAdapter,
  }
})

import {
  ACCOUNT_BINDING_SYNC_ERROR_CODES,
  cancelSync,
  PUBLISH_SYNC_ERROR_CODES,
  syncToMultiplePlatforms,
  syncToPlatform,
} from '../src/adapters/index'

const article = {
  title: 'Bound Sohu draft',
  markdown: 'Body',
  html: '<p>Body</p>',
}

describe('account binding sync propagation', () => {
  beforeEach(() => {
    syncTestState.metas.splice(0, syncTestState.metas.length, {
      id: 'sohu',
      name: 'Sohu',
      icon: 'sohu.svg',
      homepage: 'https://mp.sohu.com',
      capabilities: ['article', 'draft', 'account_binding'],
    })
    syncTestState.exposeProbe = true
    syncTestState.probeAccounts.mockReset()
    syncTestState.publish.mockReset()
    syncAnalyticsState.trackPlatformSync.mockClear()
    syncAnalyticsState.trackSyncComplete.mockClear()
    syncTestState.publish.mockImplementation(
      async (
        platform: string,
        _article: unknown,
        options: { accountBinding?: { externalAccountId: string } },
      ) => ({
        platform,
        success: true,
        externalAccountId: options.accountBinding?.externalAccountId,
        timestamp: Date.now(),
      }),
    )
  })

  it('passes the exact binding through helpers and progress callbacks', async () => {
    const onDetailProgress = vi.fn()

    const results = await syncToMultiplePlatforms(
      ['sohu'],
      article,
      { onDetailProgress },
      'bridge',
      {
        accountBindings: [
          { platform: 'sohu', externalAccountId: '120219781' },
        ],
      },
    )

    expect(syncTestState.publish).toHaveBeenCalledTimes(1)
    expect(syncTestState.publish.mock.calls[0]?.[2]).toMatchObject({
      draftOnly: true,
      accountBinding: { externalAccountId: '120219781' },
    })
    expect(results).toMatchObject([
      {
        platform: 'sohu',
        success: true,
        externalAccountId: '120219781',
      },
    ])
    expect(onDetailProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        platform: 'sohu',
        externalAccountId: '120219781',
        stage: 'starting',
      }),
    )
    expect(onDetailProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        platform: 'sohu',
        externalAccountId: '120219781',
        stage: 'completed',
      }),
    )
  })

  it('rejects malformed bindings before an adapter write', async () => {
    await expect(
      syncToMultiplePlatforms(
        ['sohu'],
        article,
        undefined,
        'bridge',
        {
          accountBindings: [
            {
              platform: 'sohu',
              externalAccountId: '120219781',
              token: 'must-not-cross',
            } as never,
          ],
        },
      ),
    ).rejects.toThrow('INVALID_ACCOUNT_BINDINGS')

    expect(syncTestState.publish).not.toHaveBeenCalled()
  })

  it('rejects an unsupported binding before adapter publish', async () => {
    syncTestState.metas[0].capabilities = ['article', 'draft']

    await expect(
      syncToPlatform('sohu', article, {
        accountBinding: { externalAccountId: '120219781' },
      }),
    ).resolves.toMatchObject({
      platform: 'sohu',
      success: false,
      externalAccountId: '120219781',
      errorCode: ACCOUNT_BINDING_SYNC_ERROR_CODES.UNSUPPORTED,
    })
    expect(syncTestState.publish).not.toHaveBeenCalled()
  })

  it('rejects a binding when the capable adapter has no account probe', async () => {
    syncTestState.exposeProbe = false

    await expect(
      syncToPlatform('sohu', article, {
        accountBinding: { externalAccountId: '120219781' },
      }),
    ).resolves.toMatchObject({
      platform: 'sohu',
      success: false,
      externalAccountId: '120219781',
      errorCode: ACCOUNT_BINDING_SYNC_ERROR_CODES.PROBE_UNAVAILABLE,
    })
    expect(syncTestState.publish).not.toHaveBeenCalled()
  })

  it.each([
    [
      'missing',
      undefined,
      ACCOUNT_BINDING_SYNC_ERROR_CODES.RESULT_IDENTITY_MISSING,
    ],
    [
      'mismatched',
      'another-account',
      ACCOUNT_BINDING_SYNC_ERROR_CODES.RESULT_IDENTITY_MISMATCH,
    ],
  ])(
    'turns a successful write with %s identity into a non-retryable review result',
    async (_label, returnedExternalAccountId, errorCode) => {
      syncTestState.publish.mockResolvedValue({
        platform: 'sohu',
        success: true,
        postId: '991',
        postUrl: 'https://www.sohu.com/a/991_120219781',
        ...(returnedExternalAccountId
          ? { externalAccountId: returnedExternalAccountId }
          : {}),
        timestamp: Date.now(),
      })
      const onDetailProgress = vi.fn()

      const results = await syncToMultiplePlatforms(
        ['sohu'],
        article,
        { onDetailProgress },
        'bridge',
        {
          accountBindings: [
            { platform: 'sohu', externalAccountId: '120219781' },
          ],
        },
      )

      expect(results).toMatchObject([
        {
          platform: 'sohu',
          success: true,
          outcome: 'OUTCOME_UNKNOWN',
          retryable: false,
          requestedExternalAccountId: '120219781',
          ...(returnedExternalAccountId
            ? {
                externalAccountId: returnedExternalAccountId,
                observedExternalAccountId: returnedExternalAccountId,
              }
            : {}),
          postId: '991',
          postUrl: 'https://www.sohu.com/a/991_120219781',
          errorCode,
        },
      ])
      expect(onDetailProgress).toHaveBeenCalledWith(
        expect.objectContaining({
          platform: 'sohu',
          externalAccountId: '120219781',
          stage: 'review_required',
          result: expect.objectContaining({
            success: true,
            outcome: 'OUTCOME_UNKNOWN',
            retryable: false,
            requestedExternalAccountId: '120219781',
            postId: '991',
            postUrl: 'https://www.sohu.com/a/991_120219781',
            errorCode,
          }),
        }),
      )
      expect(onDetailProgress).not.toHaveBeenCalledWith(
        expect.objectContaining({
          stage: 'completed',
        }),
      )
      expect(onDetailProgress).not.toHaveBeenCalledWith(
        expect.objectContaining({
          stage: 'failed',
        }),
      )
      expect(syncAnalyticsState.trackPlatformSync).toHaveBeenCalledWith(
        'bridge',
        'sohu',
        false,
        expect.objectContaining({ outcome: 'OUTCOME_UNKNOWN' }),
      )
      expect(syncAnalyticsState.trackSyncComplete).toHaveBeenCalledWith(
        expect.objectContaining({
          total: 1,
          success: 0,
          failed: 0,
          reviewRequired: 1,
        }),
      )
    },
  )

  it('drops an unsafe adapter identity and treats it as missing', async () => {
    syncTestState.publish.mockResolvedValue({
      platform: 'sohu',
      success: true,
      externalAccountId: 'unsafe\u0000identity',
      postId: '991',
      timestamp: Date.now(),
    })

    const [result] = await syncToMultiplePlatforms(
      ['sohu'],
      article,
      undefined,
      'bridge',
      {
        accountBindings: [
          { platform: 'sohu', externalAccountId: '120219781' },
        ],
      },
    )

    expect(result).toMatchObject({
      success: true,
      outcome: 'OUTCOME_UNKNOWN',
      retryable: false,
      requestedExternalAccountId: '120219781',
      errorCode: ACCOUNT_BINDING_SYNC_ERROR_CODES.RESULT_IDENTITY_MISSING,
      postId: '991',
    })
    expect(result?.externalAccountId).toBeUndefined()
    expect(result?.observedExternalAccountId).toBeUndefined()
    expect(JSON.stringify(result)).not.toContain('unsafe')
  })

  it('treats an outer publish timeout as non-retryable unknown outcome', async () => {
    vi.useFakeTimers()
    try {
      syncTestState.publish.mockImplementation(
        () => new Promise(() => undefined),
      )
      const onDetailProgress = vi.fn()
      const resultPromise = syncToMultiplePlatforms(
        ['sohu'],
        article,
        { onDetailProgress },
        'bridge',
        {
          accountBindings: [
            { platform: 'sohu', externalAccountId: '120219781' },
          ],
        },
      )

      await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
      const results = await resultPromise

      expect(results).toMatchObject([
        {
          platform: 'sohu',
          success: true,
          outcome: 'OUTCOME_UNKNOWN',
          retryable: false,
          externalAccountId: '120219781',
          requestedExternalAccountId: '120219781',
          errorCode: PUBLISH_SYNC_ERROR_CODES.TIMEOUT_OUTCOME_UNKNOWN,
        },
      ])
      expect(onDetailProgress).toHaveBeenCalledWith(
        expect.objectContaining({
          platform: 'sohu',
          externalAccountId: '120219781',
          stage: 'review_required',
        }),
      )
      expect(onDetailProgress).not.toHaveBeenCalledWith(
        expect.objectContaining({ stage: 'failed' }),
      )
      expect(syncAnalyticsState.trackPlatformSync).toHaveBeenCalledWith(
        'bridge',
        'sohu',
        false,
        expect.objectContaining({ outcome: 'OUTCOME_UNKNOWN' }),
      )
      expect(syncAnalyticsState.trackSyncComplete).toHaveBeenCalledWith(
        expect.objectContaining({
          total: 1,
          success: 0,
          failed: 0,
          reviewRequired: 1,
        }),
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('prevents a delayed adapter from crossing the write boundary after timeout', async () => {
    vi.useFakeTimers()
    try {
      let releasePreflight: (() => void) | undefined
      const beforeDispatch = vi.fn(async () => {})
      const platformWrite = vi.fn()
      syncTestState.publish.mockImplementation(
        async (
          platform: string,
          _article: unknown,
          options: {
            accountBinding?: { externalAccountId: string }
            beforeDispatch?: () => void | Promise<void>
          },
        ) => {
          await new Promise<void>((resolve) => {
            releasePreflight = resolve
          })
          await options.beforeDispatch?.()
          platformWrite()
          return {
            platform,
            success: true,
            externalAccountId: options.accountBinding?.externalAccountId,
            timestamp: Date.now(),
          }
        },
      )

      const resultPromise = syncToPlatform('sohu', article, {
        accountBinding: { externalAccountId: '120219781' },
        beforeDispatch,
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(releasePreflight).toBeTypeOf('function')

      await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
      await expect(resultPromise).resolves.toMatchObject({
        success: true,
        outcome: 'OUTCOME_UNKNOWN',
        retryable: false,
        errorCode: PUBLISH_SYNC_ERROR_CODES.TIMEOUT_OUTCOME_UNKNOWN,
      })

      releasePreflight?.()
      await vi.runAllTicks()
      await Promise.resolve()

      expect(beforeDispatch).not.toHaveBeenCalled()
      expect(platformWrite).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('preserves binding identity for platforms cancelled between batches', async () => {
    syncTestState.metas.splice(
      0,
      syncTestState.metas.length,
      ...['platform-1', 'platform-2', 'platform-3', 'platform-4'].map(
        (id) => ({
          id,
          name: id,
          icon: `${id}.svg`,
          homepage: `https://${id}.example`,
          capabilities: ['article', 'draft', 'account_binding'],
        }),
      ),
    )
    const onDetailProgress = vi.fn()
    let cancellationRequested = false

    const results = await syncToMultiplePlatforms(
      syncTestState.metas.map((meta) => meta.id),
      article,
      {
        onResult: () => {
          if (!cancellationRequested) {
            cancellationRequested = true
            expect(cancelSync()).toBe(true)
          }
        },
        onDetailProgress,
      },
      'bridge',
      {
        accountBindings: syncTestState.metas.map((meta, index) => ({
          platform: meta.id,
          externalAccountId: `account-${index + 1}`,
        })),
      },
    )

    expect(syncTestState.publish).toHaveBeenCalledTimes(3)
    expect(results[3]).toMatchObject({
      platform: 'platform-4',
      success: false,
      externalAccountId: 'account-4',
      error: '已取消',
    })
    expect(onDetailProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        platform: 'platform-4',
        externalAccountId: 'account-4',
        stage: 'failed',
        result: expect.objectContaining({
          externalAccountId: 'account-4',
          error: '已取消',
        }),
      }),
    )
  })
})
