import { describe, expect, it, vi } from 'vitest'

import type { RuntimeInterface } from '../../../runtime/interface'
import { ZhihuAdapter } from '../zhihu'

const ACCOUNT_ID = 'zhihu-account-001'
const ARTICLE = {
  title: 'Zhihu draft',
  markdown: 'Body',
  html: '<p>Body</p>',
}

function jsonResponse(value: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value), {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
}

function createRuntime(
  fetchImpl: (url: string, options?: RequestInit) => Promise<Response>,
): RuntimeInterface {
  return {
    type: 'extension',
    fetch: vi.fn(fetchImpl),
    cookies: {},
    storage: {},
    session: {},
    dom: {},
  } as unknown as RuntimeInterface
}

describe('ZhihuAdapter account binding', () => {
  it('probes one stable authenticated account', async () => {
    const runtime = createRuntime(async () =>
      jsonResponse({
        id: ` ${ACCOUNT_ID} `,
        name: '  Test   account  ',
        avatar_url: 'https://pic.example/avatar.png',
      }),
    )
    const adapter = new ZhihuAdapter()
    await adapter.init(runtime)

    await expect(adapter.probeAccounts()).resolves.toEqual({
      status: 'AUTHENTICATED',
      accounts: [
        {
          externalAccountId: ACCOUNT_ID,
          displayName: 'Test account',
          avatarUrl: 'https://pic.example/avatar.png',
        },
      ],
    })
    expect(adapter.meta.capabilities).toContain('account_binding')
  })

  it('rejects a stale binding before the first platform write', async () => {
    const runtime = createRuntime(async (url) => {
      expect(url).toBe('https://www.zhihu.com/api/v4/me')
      return jsonResponse({ id: ACCOUNT_ID, name: 'Test account' })
    })
    const adapter = new ZhihuAdapter()
    await adapter.init(runtime)

    await expect(
      adapter.publish(ARTICLE, {
        accountBinding: { externalAccountId: 'zhihu-account-other' },
      }),
    ).resolves.toMatchObject({
      platform: 'zhihu',
      success: false,
      externalAccountId: 'zhihu-account-other',
      errorCode: 'ACCOUNT_BINDING_NOT_FOUND',
    })
    expect(runtime.fetch).toHaveBeenCalledTimes(1)
  })

  it('attests the exact account on a successful draft result', async () => {
    const calls: Array<{ url: string; method?: string }> = []
    const runtime = createRuntime(async (url, options) => {
      calls.push({ url, method: options?.method })
      if (url === 'https://www.zhihu.com/api/v4/me') {
        return jsonResponse({ id: ACCOUNT_ID, name: 'Test account' })
      }
      if (url === 'https://zhuanlan.zhihu.com/api/articles/drafts') {
        return jsonResponse({ id: '123456' })
      }
      if (url === 'https://zhuanlan.zhihu.com/api/articles/123456/draft') {
        return new Response(null, { status: 204 })
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    const adapter = new ZhihuAdapter()
    await adapter.init(runtime)

    await expect(
      adapter.publish(ARTICLE, {
        accountBinding: { externalAccountId: ACCOUNT_ID },
      }),
    ).resolves.toMatchObject({
      platform: 'zhihu',
      success: true,
      postId: '123456',
      externalAccountId: ACCOUNT_ID,
      draftOnly: true,
    })
    expect(calls).toEqual([
      { url: 'https://www.zhihu.com/api/v4/me', method: 'GET' },
      {
        url: 'https://zhuanlan.zhihu.com/api/articles/drafts',
        method: 'POST',
      },
      {
        url: 'https://zhuanlan.zhihu.com/api/articles/123456/draft',
        method: 'PATCH',
      },
    ])
  })
})
