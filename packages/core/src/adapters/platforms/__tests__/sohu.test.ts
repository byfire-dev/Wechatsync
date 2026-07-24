import { describe, expect, it, vi } from 'vitest'

import type { RuntimeInterface } from '../../../runtime/interface'
import { SohuAdapter } from '../sohu'

const ACCOUNT_ID = '120219780'
const POST_ID = '1054312481'

function createRuntime(
  overrides: Partial<RuntimeInterface> = {},
): RuntimeInterface {
  return {
    type: 'extension',
    fetch: vi.fn(),
    cookies: {
      get: vi.fn(),
      set: vi.fn(),
      remove: vi.fn(),
    },
    storage: {
      get: vi.fn(),
      set: vi.fn(),
      remove: vi.fn(),
    },
    session: {
      get: vi.fn(),
      set: vi.fn(),
    },
    dom: {
      parseHTML: vi.fn(),
      querySelector: vi.fn(),
      querySelectorAll: vi.fn(),
      getTextContent: vi.fn(),
      getInnerHTML: vi.fn(),
    },
    ...overrides,
  } as RuntimeInterface
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function accountPayload(groups: Array<{ accounts: unknown[] }>) {
  return {
    code: 2000000,
    data: { data: groups },
  }
}

describe('SohuAdapter', () => {
  it('finds a usable account when the first account group is empty', async () => {
    const runtime = createRuntime({
      fetch: vi.fn().mockResolvedValue(
        jsonResponse(
          accountPayload([
            { accounts: [] },
            {
              accounts: [
                {
                  id: ACCOUNT_ID,
                  nickName: '快商通AI',
                  avatar: 'https://example.com/avatar.png',
                },
              ],
            },
          ]),
        ),
      ),
      getCookie: vi.fn().mockResolvedValue('test-sp-cm'),
    })
    const adapter = new SohuAdapter()
    await adapter.init(runtime)

    await expect(adapter.checkAuth()).resolves.toEqual({
      isAuthenticated: true,
      userId: ACCOUNT_ID,
      username: '快商通AI',
      avatar: 'https://example.com/avatar.png',
    })
  })

  it('does not bind an account ID that cannot be converted to JSON safely', async () => {
    const runtime = createRuntime({
      fetch: vi.fn().mockResolvedValue(
        jsonResponse(
          accountPayload([
            {
              accounts: [
                {
                  id: '9007199254740992',
                  nickName: 'Unsafe account',
                  avatar: '',
                },
              ],
            },
          ]),
        ),
      ),
    })
    const adapter = new SohuAdapter()
    await adapter.init(runtime)

    await expect(adapter.checkAuth()).resolves.toEqual({
      isAuthenticated: false,
    })
  })

  it.each([
    ['string', POST_ID],
    ['number', Number(POST_ID)],
  ])(
    'preserves a safe positive draft ID returned as a %s',
    async (_type, data) => {
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse(
            accountPayload([
              {
                accounts: [
                  {
                    id: ACCOUNT_ID,
                    nickName: '快商通AI',
                    avatar: '',
                  },
                ],
              },
            ]),
          ),
        )
        .mockResolvedValueOnce(
          jsonResponse({
            success: true,
            data,
          }),
        )
      const adapter = new SohuAdapter()
      await adapter.init(
        createRuntime({
          fetch,
          getCookie: vi.fn().mockResolvedValue('test-sp-cm'),
        }),
      )

      await expect(
        adapter.publish({
          title: '搜狐草稿',
          markdown: '正文',
          html: '<p>正文</p>',
        }),
      ).resolves.toMatchObject({
        platform: 'sohu',
        success: true,
        postId: POST_ID,
        postUrl:
          `https://mp.sohu.com/mpfe/v4/contentManagement/news/addarticle` +
          `?spm=smmp.articlelist.0.0&contentStatus=2&id=${POST_ID}` +
          `&accountId=${ACCOUNT_ID}`,
        draftOnly: true,
      })
    },
  )

  it.each([
    ['missing', undefined],
    ['zero', 0],
    ['fractional', 1.5],
    ['unsafe', Number.MAX_SAFE_INTEGER + 1],
    ['malformed string', '1054312481x'],
  ])('rejects a %s draft ID response', async (_label, data) => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          accountPayload([
            {
              accounts: [
                {
                  id: ACCOUNT_ID,
                  nickName: '快商通AI',
                  avatar: '',
                },
              ],
            },
          ]),
        ),
      )
      .mockResolvedValueOnce(jsonResponse({ success: true, data }))
    const adapter = new SohuAdapter()
    await adapter.init(
      createRuntime({
        fetch,
        getCookie: vi.fn().mockResolvedValue('test-sp-cm'),
      }),
    )

    await expect(
      adapter.publish({
        title: '搜狐草稿',
        markdown: '正文',
        html: '<p>正文</p>',
      }),
    ).resolves.toMatchObject({
      platform: 'sohu',
      success: false,
      error: '保存失败: 响应中的文章 ID 无效',
    })
  })
})
