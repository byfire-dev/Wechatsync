import { describe, expect, it, vi } from 'vitest'

import type { RuntimeInterface } from '../../runtime/interface'
import {
  buildTrustedPublicationDraftUrl,
  openTrustedPublicationDraft,
} from '../publication-draft-open'

function runtimeWithTabs(
  create: (url: string, active?: boolean) => Promise<{ id: number }>,
  remove = vi.fn(),
): RuntimeInterface {
  return {
    type: 'extension',
    tabs: {
      query: vi.fn(),
      create: vi.fn(create),
      remove,
      waitForLoad: vi.fn(),
      executeScript: vi.fn(),
    },
  } as unknown as RuntimeInterface
}

describe('trusted publication draft opening', () => {
  it.each([
    [
      'zhihu' as const,
      '2067551877672219379',
      'zhihu-account',
      'https://zhuanlan.zhihu.com/p/2067551877672219379/edit',
    ],
    [
      'sohu' as const,
      '1058083143',
      '120219781',
      'https://mp.sohu.com/mpfe/v4/contentManagement/news/addarticle?spm=smmp.articlelist.0.0&contentStatus=2&id=1058083143&accountId=120219781',
    ],
    [
      'toutiao' as const,
      '7669620929504346651',
      '7390000000000000001',
      'https://mp.toutiao.com/profile_v4/graphic/publish?pgc_id=7669620929504346651',
    ],
  ])(
    'builds a trusted %s editor URL from canonical identities',
    (platform, postId, externalAccountId, expectedUrl) => {
      expect(
        buildTrustedPublicationDraftUrl(platform, postId, {
          externalAccountId,
          displayName: 'Bound account',
        }).href,
      ).toBe(expectedUrl)
    },
  )

  it.each(['0', '001', 'draft-1', '1&accountId=attacker'])(
    'rejects a non-canonical draft locator: %s',
    (platformPostId) => {
      expect(() =>
        buildTrustedPublicationDraftUrl('zhihu', platformPostId, {
          externalAccountId: 'zhihu-account',
          displayName: 'Zhihu account',
        }),
      ).toThrow('INVALID_DRAFT_POST_ID')
    },
  )

  it('binds a Sohu editor URL to the requested sub-account', async () => {
    const create = vi.fn().mockResolvedValue({ id: 42 })
    const probeAccounts = vi.fn()
    const runtime = runtimeWithTabs(create)
    const verifiedAccountProbe = {
      status: 'AUTHENTICATED' as const,
      accounts: [
        { externalAccountId: '120219780', displayName: 'Primary' },
        { externalAccountId: '120219781', displayName: 'Requested' },
      ],
    }

    await expect(
      openTrustedPublicationDraft({
        expectedPlatform: 'sohu',
        request: {
          requestId: 'open-sohu',
          platform: 'sohu',
          externalAccountId: '120219781',
          platformPostId: '1058083143',
        },
        runtime,
        probeAccounts,
        context: { verifiedAccountProbe },
      }),
    ).resolves.toEqual({ opened: true })

    expect(probeAccounts).not.toHaveBeenCalled()
    expect(create).toHaveBeenCalledWith(
      'https://mp.sohu.com/mpfe/v4/contentManagement/news/addarticle?spm=smmp.articlelist.0.0&contentStatus=2&id=1058083143&accountId=120219781',
      true,
    )
  })

  it('fails closed when the requested account is not in the current probe', async () => {
    const create = vi.fn()
    const runtime = runtimeWithTabs(create)

    await expect(
      openTrustedPublicationDraft({
        expectedPlatform: 'toutiao',
        request: {
          requestId: 'open-toutiao',
          platform: 'toutiao',
          externalAccountId: '7390000000000000002',
          platformPostId: '7669620929504346651',
        },
        runtime,
        probeAccounts: vi.fn().mockResolvedValue({
          status: 'AUTHENTICATED',
          accounts: [
            {
              externalAccountId: '7390000000000000001',
              displayName: 'Current account',
            },
          ],
        }),
      }),
    ).rejects.toThrow('ACCOUNT_MISMATCH')
    expect(create).not.toHaveBeenCalled()
  })

  it('removes a newly created tab when cancellation wins the race', async () => {
    const controller = new AbortController()
    const remove = vi.fn()
    const runtime = runtimeWithTabs(async () => {
      controller.abort()
      return { id: 99 }
    }, remove)

    await expect(
      openTrustedPublicationDraft({
        expectedPlatform: 'zhihu',
        request: {
          requestId: 'open-zhihu',
          platform: 'zhihu',
          externalAccountId: 'zhihu-account',
          platformPostId: '2067551877672219379',
        },
        runtime,
        probeAccounts: vi.fn().mockResolvedValue({
          status: 'AUTHENTICATED',
          accounts: [
            {
              externalAccountId: 'zhihu-account',
              displayName: 'Current account',
            },
          ],
        }),
        context: { signal: controller.signal },
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(remove).toHaveBeenCalledWith(99)
  })
})
