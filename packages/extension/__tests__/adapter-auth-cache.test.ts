import { beforeEach, describe, expect, it, vi } from 'vitest'

const authTestState = vi.hoisted(() => ({
  checkAuth: vi.fn(),
  otherCheckAuth: vi.fn(),
  metas: [
    {
      id: 'zhihu',
      name: '知乎',
      icon: 'zhihu.svg',
      homepage: 'https://www.zhihu.com',
      capabilities: ['article', 'draft'],
    },
  ],
  sohuMeta: {
    id: 'sohu',
    name: '搜狐',
    icon: 'sohu.svg',
    homepage: 'https://mp.sohu.com',
    capabilities: ['article', 'draft'],
  },
}))

vi.mock('@wechatsync/core', () => {
  class DummyAdapter {
    meta = authTestState.metas[0]
  }

  return {
    adapterRegistry: {
      setRuntime: vi.fn(),
      register: vi.fn(),
      getAllMeta: vi.fn(() => authTestState.metas),
      get: vi.fn(async (platformId: string) => {
        const meta = authTestState.metas.find(
          (candidate) => candidate.id === platformId,
        )
        if (!meta) return null

        return {
          meta,
          checkAuth:
            platformId === 'sohu'
              ? authTestState.otherCheckAuth
              : authTestState.checkAuth,
        }
      }),
      getPreprocessConfig: vi.fn(),
      getPreprocessConfigs: vi.fn(),
    },
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

import { checkAllPlatformsAuth, clearAuthCache } from '../src/adapters/index.ts'

const completeAuthResult = {
  isAuthenticated: true,
  username: '测试账号',
  userId: 'stable-account-123',
  avatar: 'https://example.com/avatar.png',
}

describe('adapter auth cache', () => {
  beforeEach(async () => {
    authTestState.metas.splice(1)
    authTestState.checkAuth.mockReset()
    authTestState.checkAuth.mockResolvedValue(completeAuthResult)
    authTestState.otherCheckAuth.mockReset()
    authTestState.otherCheckAuth.mockResolvedValue({
      ...completeAuthResult,
      userId: 'stable-sohu-account-456',
    })
    await clearAuthCache()
  })

  it('preserves the stable account ID and avatar returned by checkAuth', async () => {
    const results = await checkAllPlatformsAuth(true)

    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject(completeAuthResult)

    const storage = await chrome.storage.local.get('authCache')
    expect(storage.authCache.zhihu).toMatchObject(completeAuthResult)
  })

  it('does not write the stable account ID or avatar URL to debug logs', async () => {
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {})

    try {
      await checkAllPlatformsAuth(true)

      const serializedLogs = JSON.stringify(consoleLog.mock.calls)
      expect(serializedLogs).not.toContain(completeAuthResult.userId)
      expect(serializedLogs).not.toContain(completeAuthResult.avatar)
      expect(serializedLogs).toContain('hasStableUserId')
    } finally {
      consoleLog.mockRestore()
    }
  })

  it('returns the stable account ID and avatar from a valid cache hit', async () => {
    await checkAllPlatformsAuth(true)
    authTestState.checkAuth.mockClear()

    const results = await checkAllPlatformsAuth()

    expect(authTestState.checkAuth).not.toHaveBeenCalled()
    expect(results[0]).toMatchObject(completeAuthResult)
  })

  it('fails closed when a legacy adapter returns false without explicit logout evidence', async () => {
    authTestState.checkAuth.mockResolvedValue({
      isAuthenticated: false,
    })

    const results = await checkAllPlatformsAuth(true)

    expect(results[0]).toMatchObject({
      isAuthenticated: false,
      probeStatus: 'PROBE_FAILED',
      probeSource: 'EXTENSION',
      probeErrorCode: 'UNKNOWN_ERROR',
    })
  })

  it('preserves an adapter-confirmed logout', async () => {
    authTestState.checkAuth.mockResolvedValue({
      isAuthenticated: false,
      probeStatus: 'NOT_AUTHENTICATED',
      probeSource: 'EXTENSION',
    })

    const results = await checkAllPlatformsAuth(true)

    expect(results[0]).toMatchObject({
      isAuthenticated: false,
      probeStatus: 'NOT_AUTHENTICATED',
      probeSource: 'EXTENSION',
    })
    expect(results[0].probeErrorCode).toBeUndefined()
  })

  it('checks only the requested platform and never invokes unrelated adapters', async () => {
    authTestState.metas.push(authTestState.sohuMeta)
    authTestState.otherCheckAuth.mockRejectedValue(
      new Error('unrelated platform must not be checked'),
    )

    const results = await checkAllPlatformsAuth(true, ['zhihu'])

    expect(results.map((result) => result.id)).toEqual(['zhihu'])
    expect(authTestState.checkAuth).toHaveBeenCalledTimes(1)
    expect(authTestState.otherCheckAuth).not.toHaveBeenCalled()
  })

  it('returns only the requested platform from cache without checking others', async () => {
    authTestState.metas.push(authTestState.sohuMeta)
    await checkAllPlatformsAuth(true)
    authTestState.checkAuth.mockClear()
    authTestState.otherCheckAuth.mockClear()

    const results = await checkAllPlatformsAuth(false, ['zhihu'])

    expect(results.map((result) => result.id)).toEqual(['zhihu'])
    expect(authTestState.checkAuth).not.toHaveBeenCalled()
    expect(authTestState.otherCheckAuth).not.toHaveBeenCalled()
  })

  it('keeps the legacy all-platform behavior when no target filter is supplied', async () => {
    authTestState.metas.push(authTestState.sohuMeta)

    const results = await checkAllPlatformsAuth(true)

    expect(results.map((result) => result.id)).toEqual(['zhihu', 'sohu'])
    expect(authTestState.checkAuth).toHaveBeenCalledTimes(1)
    expect(authTestState.otherCheckAuth).toHaveBeenCalledTimes(1)
  })
})
