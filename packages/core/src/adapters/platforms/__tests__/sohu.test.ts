import { describe, expect, it, vi } from 'vitest'

import type { RuntimeInterface } from '../../../runtime/interface'
import { SohuAdapter } from '../sohu'

const ACCOUNT_ID = '120219780'
const SECOND_ACCOUNT_ID = '120219781'
const UNKNOWN_ACCOUNT_ID = '120219799'
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

function jsonResponseAt(
  payload: unknown,
  url: string,
  status = 200,
): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    url,
    headers: new Headers({ 'Content-Type': 'application/json' }),
    json: async () => payload,
  } as Response
}

function accountPayload(groups: Array<{ accounts: unknown[] }>) {
  return {
    code: 2000000,
    data: { data: groups },
  }
}

describe('SohuAdapter', () => {
  it('declares exact account binding as an internal capability', () => {
    expect(new SohuAdapter().meta.capabilities).toContain('account_binding')
  })

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
      probeStatus: 'AUTHENTICATED',
      probeSource: 'EXTENSION',
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
      probeStatus: 'PROBE_FAILED',
      probeSource: 'EXTENSION',
      probeErrorCode: 'ACCOUNT_ID_MISSING',
    })
  })

  it('preserves confirmed logout probe metadata for an empty account set', async () => {
    const runtime = createRuntime({
      fetch: vi.fn().mockResolvedValue(
        jsonResponse(accountPayload([{ accounts: [] }])),
      ),
    })
    const adapter = new SohuAdapter()
    await adapter.init(runtime)

    await expect(adapter.checkAuth()).resolves.toEqual({
      isAuthenticated: false,
      probeStatus: 'NOT_AUTHENTICATED',
      probeSource: 'EXTENSION',
    })
  })

  it.each([
    [
      'one malformed row after a valid row',
      [
        { id: ACCOUNT_ID, nickName: 'Valid account', avatar: '' },
        {
          id: '9007199254740992',
          nickName: 'Unsafe account',
          avatar: '',
        },
      ],
    ],
    [
      'a duplicate stable account ID',
      [
        { id: ACCOUNT_ID, nickName: 'First account', avatar: '' },
        { id: ACCOUNT_ID, nickName: 'Duplicate account', avatar: '' },
      ],
    ],
  ])('fails the complete account probe for %s', async (_label, accounts) => {
    const runtime = createRuntime({
      fetch: vi.fn().mockResolvedValue(
        jsonResponse(accountPayload([{ accounts }])),
      ),
    })
    const adapter = new SohuAdapter()
    await adapter.init(runtime)

    await expect(adapter.probeAccounts()).resolves.toEqual({
      status: 'PROBE_FAILED',
      accounts: [],
      errorCode: 'ACCOUNT_ID_MISSING',
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
        externalAccountId: ACCOUNT_ID,
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
  ])('requires review for a successful save with a %s draft ID', async (_label, data) => {
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
      success: true,
      outcome: 'OUTCOME_UNKNOWN',
      retryable: false,
      externalAccountId: ACCOUNT_ID,
      errorCode: 'SOHU_DRAFT_SAVE_OUTCOME_UNKNOWN',
      error: '搜狐草稿保存请求已发出，但无法确认最终结果；请人工核验，勿重复提交',
    })
  })

  it('keeps an explicit platform rejection as a confirmed failure', async () => {
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
        jsonResponse({ success: false, msg: '平台拒绝保存' }),
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
      success: false,
      externalAccountId: ACCOUNT_ID,
      errorCode: 'SOHU_DRAFT_SAVE_REJECTED',
      error: '平台拒绝保存',
    })
  })

  it.each([
    [
      'transport failure',
      () => Promise.reject(new Error('request may already have arrived')),
    ],
    [
      'JSON failure',
      () =>
        Promise.resolve({
          json: vi.fn().mockRejectedValue(new Error('invalid JSON')),
        } as unknown as Response),
    ],
  ])('keeps a post-write %s outcome unknown and non-retryable', async (_label, saveFetch) => {
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
      .mockImplementationOnce(saveFetch)
    const adapter = new SohuAdapter()
    await adapter.init(
      createRuntime({
        fetch,
        getCookie: vi.fn().mockResolvedValue('test-sp-cm'),
      }),
    )

    const result = await adapter.publish({
      title: '搜狐草稿',
      markdown: '正文',
      html: '<p>正文</p>',
    })

    expect(result).toMatchObject({
      platform: 'sohu',
      success: true,
      outcome: 'OUTCOME_UNKNOWN',
      retryable: false,
      externalAccountId: ACCOUNT_ID,
      errorCode: 'SOHU_DRAFT_SAVE_OUTCOME_UNKNOWN',
    })
    expect(result.error).not.toContain('request may already have arrived')
    expect(result.error).not.toContain('invalid JSON')
  })

  it('does not overwrite confirmed save evidence when header cleanup fails', async () => {
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
        jsonResponse({ success: true, data: POST_ID }),
      )
    const adapter = new SohuAdapter()
    await adapter.init(
      createRuntime({
        fetch,
        getCookie: vi.fn().mockResolvedValue('test-sp-cm'),
        headerRules: {
          add: vi.fn(async (_rule) => 'sohu-rule'),
          remove: vi.fn(async (_ruleId) => {
            throw new Error('cleanup failed')
          }),
          clear: vi.fn(async () => {}),
        },
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
      externalAccountId: ACCOUNT_ID,
      draftOnly: true,
    })
  })

  it('uses the exact bound second account for image upload, draft save, and result identity', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          accountPayload([
            {
              accounts: [
                {
                  id: ACCOUNT_ID,
                  nickName: 'First account',
                  avatar: '',
                },
                {
                  id: SECOND_ACCOUNT_ID,
                  nickName: 'Second account',
                  avatar: '',
                },
              ],
            },
          ]),
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse({ url: 'https://img.mp.sohu.com/uploaded.png' }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: POST_ID,
        }),
      )
    const downloadImage = vi.fn().mockResolvedValue(
      new Response('<svg xmlns="http://www.w3.org/2000/svg"></svg>', {
        status: 200,
        headers: { 'Content-Type': 'image/svg+xml' },
      }),
    )
    vi.stubGlobal('fetch', downloadImage)

    try {
      const adapter = new SohuAdapter()
      await adapter.init(
        createRuntime({
          fetch,
          getCookie: vi.fn().mockResolvedValue('test-sp-cm'),
        }),
      )

      const result = await adapter.publish(
        {
          title: 'Exact account draft',
          markdown: 'Body',
          html: '<p>Body</p><img src="https://source.example/table.svg">',
        },
        {
          accountBinding: { externalAccountId: SECOND_ACCOUNT_ID },
        },
      )

      expect(result).toMatchObject({
        platform: 'sohu',
        success: true,
        postId: POST_ID,
        externalAccountId: SECOND_ACCOUNT_ID,
      })
      expect(result.postUrl).toContain(`accountId=${SECOND_ACCOUNT_ID}`)
      expect(downloadImage).toHaveBeenCalledWith(
        'https://source.example/table.svg',
      )

      const [uploadUrl, uploadInit] = fetch.mock.calls[1] as [
        string,
        RequestInit,
      ]
      expect(uploadUrl).toContain(`accountId=${SECOND_ACCOUNT_ID}`)
      expect(uploadInit.body).toBeInstanceOf(FormData)
      expect((uploadInit.body as FormData).get('accountId')).toBe(
        SECOND_ACCOUNT_ID,
      )

      const [saveUrl, saveInit] = fetch.mock.calls[2] as [
        string,
        RequestInit,
      ]
      expect(saveUrl).toContain(`accountId=${SECOND_ACCOUNT_ID}`)
      expect(JSON.parse(String(saveInit.body))).toMatchObject({
        accountId: Number(SECOND_ACCOUNT_ID),
        content: '<p>Body</p><img src="https://img.mp.sohu.com/uploaded.png" />',
      })
      expect(JSON.stringify(fetch.mock.calls.slice(1))).not.toContain(
        `accountId=${ACCOUNT_ID}`,
      )
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('fails closed before writes when multiple accounts have no binding', async () => {
    const fetch = vi.fn().mockResolvedValue(
      jsonResponse(
        accountPayload([
          {
            accounts: [
              { id: ACCOUNT_ID, nickName: 'First account', avatar: '' },
              {
                id: SECOND_ACCOUNT_ID,
                nickName: 'Second account',
                avatar: '',
              },
            ],
          },
        ]),
      ),
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
        title: 'Ambiguous draft',
        markdown: 'Body',
        html: '<p>Body</p>',
      }),
    ).resolves.toMatchObject({
      platform: 'sohu',
      success: false,
      errorCode: 'ACCOUNT_BINDING_REQUIRED',
    })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('never falls back to a real account for an unknown publish binding', async () => {
    const fetch = vi.fn().mockResolvedValue(
      jsonResponse(
        accountPayload([
          {
            accounts: [
              { id: ACCOUNT_ID, nickName: 'First account', avatar: '' },
              {
                id: SECOND_ACCOUNT_ID,
                nickName: 'Second account',
                avatar: '',
              },
            ],
          },
        ]),
      ),
    )
    const adapter = new SohuAdapter()
    await adapter.init(
      createRuntime({
        fetch,
        getCookie: vi.fn().mockResolvedValue('test-sp-cm'),
      }),
    )

    await expect(
      adapter.publish(
        {
          title: 'Unknown account draft',
          markdown: 'Body',
          html: '<p>Body</p>',
        },
        {
          accountBinding: { externalAccountId: UNKNOWN_ACCOUNT_ID },
        },
      ),
    ).resolves.toMatchObject({
      platform: 'sohu',
      success: false,
      externalAccountId: UNKNOWN_ACCOUNT_ID,
      errorCode: 'ACCOUNT_BINDING_NOT_FOUND',
    })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('inspects the exact bound second account', async () => {
    const detailUrl =
      `https://mp.sohu.com/mpbp/bp/news/v4/article` +
      `?newsId=${POST_ID}&accountId=${SECOND_ACCOUNT_ID}`
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          accountPayload([
            {
              accounts: [
                { id: ACCOUNT_ID, nickName: 'First account', avatar: '' },
                {
                  id: SECOND_ACCOUNT_ID,
                  nickName: 'Second account',
                  avatar: '',
                },
              ],
            },
          ]),
        ),
      )
      .mockResolvedValueOnce(
        jsonResponseAt(
          {
            code: 2_000_000,
            data: {
              news: {
                id: Number(POST_ID),
                userId: Number(SECOND_ACCOUNT_ID),
                status: 1,
                title: 'Second account draft',
                content: '<p>Body</p>',
              },
            },
          },
          detailUrl,
        ),
      )
    const adapter = new SohuAdapter()
    await adapter.init(
      createRuntime({
        fetch,
        getCookie: vi.fn().mockResolvedValue('test-sp-cm'),
      }),
    )

    const observations = await adapter.inspectPublication({
      requestId: 'inspect-second-account',
      platform: 'sohu',
      externalAccountId: SECOND_ACCOUNT_ID,
      draft: {
        platformPostId: POST_ID,
        draftUrl:
          `https://mp.sohu.com/mpfe/v4/contentManagement/news/addarticle` +
          `?id=${POST_ID}&accountId=${SECOND_ACCOUNT_ID}`,
        draftedAt: '2026-07-30T10:00:00+08:00',
      },
    })

    expect(observations).toHaveLength(1)
    expect(observations[0]).toMatchObject({
      externalAccountId: SECOND_ACCOUNT_ID,
      outcome: 'DRAFT_PRESENT',
      platformPostId: POST_ID,
    })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch.mock.calls[1]?.[0]).toBe(detailUrl)
  })

  it('returns account mismatch without inspecting through another account', async () => {
    const fetch = vi.fn().mockResolvedValue(
      jsonResponse(
        accountPayload([
          {
            accounts: [
              { id: ACCOUNT_ID, nickName: 'First account', avatar: '' },
              {
                id: SECOND_ACCOUNT_ID,
                nickName: 'Second account',
                avatar: '',
              },
            ],
          },
        ]),
      ),
    )
    const adapter = new SohuAdapter()
    await adapter.init(
      createRuntime({
        fetch,
        getCookie: vi.fn().mockResolvedValue('test-sp-cm'),
      }),
    )

    const observations = await adapter.inspectPublication({
      requestId: 'inspect-unknown-account',
      platform: 'sohu',
      externalAccountId: UNKNOWN_ACCOUNT_ID,
      draft: {
        platformPostId: POST_ID,
        draftUrl:
          `https://mp.sohu.com/mpfe/v4/contentManagement/news/addarticle` +
          `?id=${POST_ID}&accountId=${UNKNOWN_ACCOUNT_ID}`,
        draftedAt: '2026-07-30T10:00:00+08:00',
      },
    })

    expect(observations).toHaveLength(1)
    expect(observations[0]).toMatchObject({
      externalAccountId: UNKNOWN_ACCOUNT_ID,
      outcome: 'ACCOUNT_MISMATCH',
      errorCode: 'ACCOUNT_MISMATCH',
    })
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
