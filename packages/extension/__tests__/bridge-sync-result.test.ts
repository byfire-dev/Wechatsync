import { describe, expect, it } from 'vitest'

import {
  getLegacySyncResultRoutingAccountId,
  LEGACY_OUTCOME_UNKNOWN_MESSAGE,
  toLegacyEditResponse,
  toLegacySyncAccountUpdate,
} from '../src/bridge/sync-result'

describe('toLegacyEditResponse', () => {
  it('keeps the WeChat post ID without exposing its token URL', () => {
    const result = toLegacyEditResponse({
      platform: 'weixin',
      success: true,
      postId: '9001',
      postUrl:
        'https://mp.weixin.qq.com/cgi-bin/appmsg?appmsgid=9001&token=secret',
    })

    expect(result).toEqual({ postId: '9001' })
    expect(JSON.stringify(result)).not.toContain('secret')
  })

  it('keeps only a canonical WeChat post ID within the shared 128-digit boundary', () => {
    expect(
      toLegacyEditResponse({
        platform: 'weixin',
        success: true,
        postId: '0009001',
      }),
    ).toEqual({ postId: '9001' })
    expect(
      toLegacyEditResponse({
        platform: 'weixin',
        success: true,
        postId: '1'.repeat(129),
      }),
    ).toEqual({})
  })

  it('sanitizes another platform URL and preserves its post ID', () => {
    expect(
      toLegacyEditResponse({
        platform: 'zhihu',
        success: true,
        postId: '42',
        postUrl:
          'https://zhuanlan.zhihu.com/p/42/edit?token=secret&source=sync#draft',
      }),
    ).toEqual({
      draftLink: 'https://zhuanlan.zhihu.com/p/42/edit?source=sync',
      postId: '42',
    })
  })

  it('returns null for failures and rejects malformed post IDs', () => {
    expect(toLegacyEditResponse({ success: false, postId: '42' })).toBeNull()
    expect(
      toLegacyEditResponse({
        platform: 'sohu',
        success: true,
        postId: 'x'.repeat(501),
      }),
    ).toEqual({})
  })

  it('preserves successful-write evidence while routing review to the requested account', () => {
    const result = {
      platform: 'sohu',
      success: true,
      outcome: 'OUTCOME_UNKNOWN' as const,
      retryable: false,
      requestedExternalAccountId: '120219781',
      observedExternalAccountId: '120000002',
      externalAccountId: '120000002',
      postId: '991',
      postUrl: 'https://www.sohu.com/a/991_120000002',
      errorCode: 'ACCOUNT_RESULT_IDENTITY_MISMATCH',
      error:
        'Platform reported a successful write, but the observed account identity did not match the requested binding. Do not retry automatically.',
      timestamp: 1,
    }

    expect(getLegacySyncResultRoutingAccountId(result)).toBe('120219781')
    expect(toLegacySyncAccountUpdate(result)).toEqual({
      status: 'done',
      msg: LEGACY_OUTCOME_UNKNOWN_MESSAGE,
      error: result.error,
      editResp: {
        draftLink: 'https://www.sohu.com/a/991_120000002',
        postId: '991',
      },
      outcome: 'OUTCOME_UNKNOWN',
      retryable: false,
      requestedExternalAccountId: '120219781',
      observedExternalAccountId: '120000002',
    })
  })

  it('drops unsafe account identities at the page projection boundary', () => {
    const result = {
      platform: 'sohu',
      success: true,
      outcome: 'OUTCOME_UNKNOWN' as const,
      retryable: false,
      requestedExternalAccountId: 'unsafe\u0000requested',
      observedExternalAccountId: 'unsafe\u0000observed',
      externalAccountId: '120000002',
      timestamp: 1,
    }

    expect(getLegacySyncResultRoutingAccountId(result)).toBeUndefined()
    expect(toLegacySyncAccountUpdate(result)).toEqual({
      status: 'done',
      msg: LEGACY_OUTCOME_UNKNOWN_MESSAGE,
      editResp: {},
      outcome: 'OUTCOME_UNKNOWN',
      retryable: false,
    })
    expect(JSON.stringify(toLegacySyncAccountUpdate(result))).not.toContain(
      'unsafe',
    )
  })
})
