/**
 * 适配器系统初始化
 */
import {
  adapterRegistry,
  normalizeAdapterAccountBinding,
  normalizeAdapterExternalAccountId,
  type PlatformAdapter,
  type AdapterAccountBinding,
  type PlatformAccountBinding,
  type PlatformMeta,
  type AuthProbeErrorCode,
  type AuthResult,
  type Article,
  type SyncResult,
} from '@wechatsync/core'
import { createExtensionRuntime } from '../runtime/extension'
import { createLogger } from '../lib/logger'
import { isConfirmedSyncSuccess } from '../lib/sync-outcome'
import {
  INVALID_ACCOUNT_BINDINGS,
  validatePlatformAccountBindings,
} from '../bridge/account-bindings'
import {
  trackSyncStart,
  trackPlatformSync,
  trackSyncComplete,
  inferErrorType,
  trackPlatformCombination,
  trackUsageTime,
  updateCumulativeStats,
  trackMilestone,
  trackAuthCheck,
} from '../lib/analytics'

// 导入代码适配器 - 从 core 包
import {
  DoubanAdapter,
  XueqiuAdapter,
  SohuAdapter,
  WoshipmAdapter,
  ZhihuAdapter,
  ToutiaoAdapter,
  JuejinAdapter,
  CSDNAdapter,
  WeiboAdapter,
  BilibiliAdapter,
  BaijiahaoAdapter,
  YuqueAdapter,
  WeixinAdapter,
  Cto51Adapter,
  ImoocAdapter,
  OschinaAdapter,
  SegmentfaultAdapter,
  CnblogsAdapter,
  ZipDownloadAdapter,
  EastmoneyAdapter,
} from '@wechatsync/core'
import {
  mergeAdapterClasses,
  type AdapterConstructor,
} from './adapter-classes'

// 私有适配器 - private/ 目录通过 git submodule 管理
const privateModules = import.meta.glob<Record<string, unknown>>(
  '@wechatsync/core/adapters/platforms/private/*.ts',
  { eager: true }
)

// 从 glob 结果中提取适配器类
function getPrivateAdapters(): AdapterConstructor[] {
  const adapters: AdapterConstructor[] = []
  for (const mod of Object.values(privateModules)) {
    for (const [name, exported] of Object.entries(mod as Record<string, unknown>)) {
      // 检查是否是类（函数）且名称以 Adapter 结尾
      if (typeof exported === 'function' && name.endsWith('Adapter')) {
        try {
          // 尝试实例化检查是否有 meta 属性
          const instance = new (exported as AdapterConstructor)()
          if (instance && (instance as unknown as { meta?: unknown }).meta) {
            adapters.push(exported as AdapterConstructor)
          }
        } catch {
          // 实例化失败，跳过（文件可能不存在或格式不对）
        }
      }
    }
  }
  return adapters
}

// 所有适配器类列表
const PUBLIC_ADAPTER_CLASSES: AdapterConstructor[] = [
  ZhihuAdapter,
  ToutiaoAdapter,
  JuejinAdapter,
  WeiboAdapter,
  BilibiliAdapter,
  BaijiahaoAdapter,
  CSDNAdapter,
  YuqueAdapter,
  DoubanAdapter,
  SohuAdapter,
  XueqiuAdapter,
  WeixinAdapter,
  WoshipmAdapter,
  Cto51Adapter,
  ImoocAdapter,
  OschinaAdapter,
  SegmentfaultAdapter,
  CnblogsAdapter,
  ZipDownloadAdapter,
  EastmoneyAdapter,
]

const ADAPTER_CLASSES = mergeAdapterClasses(
  PUBLIC_ADAPTER_CLASSES,
  getPrivateAdapters(),
  new Set(['toutiao']),
)

// 适配器注册条目 (类型安全)
interface AdapterEntry {
  meta: PlatformMeta
  factory: () => PlatformAdapter
  preprocessConfig?: Record<string, unknown>
}

// 生成适配器注册条目（包含 preprocessConfig）
const adapterEntries: AdapterEntry[] = ADAPTER_CLASSES.map(AdapterClass => {
  const instance = new AdapterClass()
  return {
    meta: instance.meta,
    factory: () => new AdapterClass(),
    preprocessConfig: (instance as unknown as { preprocessConfig?: Record<string, unknown> }).preprocessConfig,
  }
})

const logger = createLogger('WechatSync')

// 运行时实例
const runtime = createExtensionRuntime()

// 是否已初始化
let initialized = false

/**
 * 初始化适配器系统
 */
export async function initAdapters(): Promise<void> {
  if (initialized) return

  // 设置运行时
  adapterRegistry.setRuntime(runtime)

  // 注册所有适配器
  for (const entry of adapterEntries) {
    try {
      adapterRegistry.register(entry)
    } catch (error) {
      logger.error('Failed to register adapter:', error)
    }
  }

  initialized = true
}

/**
 * 获取适配器
 */
export async function getAdapter(platformId: string): Promise<PlatformAdapter | null> {
  await initAdapters()
  return adapterRegistry.get(platformId)
}

/**
 * 获取所有平台元信息
 */
export function getAllPlatformMetas() {
  return adapterRegistry.getAllMeta()
}

/**
 * 获取平台的预处理配置
 */
export function getPlatformPreprocessConfig(platformId: string) {
  return adapterRegistry.getPreprocessConfig(platformId)
}

/**
 * 获取多个平台的预处理配置
 */
export function getPlatformPreprocessConfigs(platformIds: string[]) {
  return adapterRegistry.getPreprocessConfigs(platformIds)
}

// 缓存配置
const AUTH_CACHE_KEY = 'authCache'
const AUTH_CACHE_TTL_AUTHENTICATED = 5 * 60 * 1000 // 已登录：5 分钟缓存
const AUTH_CACHE_TTL_UNAUTHENTICATED = 30 * 1000 // 未登录：30 秒缓存（用户可能随时登录）
const AUTH_CHECK_CONCURRENCY = 5 // 并行检查数量
const AUTH_CHECK_TIMEOUT = 10 * 1000 // 单个平台认证检查超时：10 秒
const PUBLISH_TIMEOUT = 10 * 60 * 1000 // 单个平台发布超时：10 分钟（包含图片上传）

export const ACCOUNT_BINDING_SYNC_ERROR_CODES = {
  UNSUPPORTED: 'ACCOUNT_BINDING_UNSUPPORTED',
  PROBE_UNAVAILABLE: 'ACCOUNT_BINDING_PROBE_UNAVAILABLE',
  RESULT_IDENTITY_MISSING: 'ACCOUNT_RESULT_IDENTITY_MISSING',
  RESULT_IDENTITY_MISMATCH: 'ACCOUNT_RESULT_IDENTITY_MISMATCH',
} as const

export const PUBLISH_SYNC_ERROR_CODES = {
  TIMEOUT_OUTCOME_UNKNOWN: 'PUBLISH_TIMEOUT_OUTCOME_UNKNOWN',
} as const

const PUBLISH_TIMEOUT_OUTCOME_UNKNOWN_MESSAGE =
  'The publish operation timed out after a platform write may have started. Verify the platform before any retry.'

class OperationTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OperationTimeoutError'
  }
}

/**
 * 带超时的 Promise 包装
 */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  errorMessage: string,
  onTimeout?: () => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout?.()
      reject(new OperationTimeoutError(errorMessage))
    }, ms)

    promise
      .then(result => {
        clearTimeout(timer)
        resolve(result)
      })
      .catch(error => {
        clearTimeout(timer)
        reject(error)
      })
  })
}

function normalizeAuthProbeResult(auth: AuthResult): AuthResult {
  const probeSource =
    auth.probeSource === 'MAIN_WORLD' ? 'MAIN_WORLD' : 'EXTENSION'

  if (auth.isAuthenticated) {
    return {
      ...auth,
      probeStatus: 'AUTHENTICATED',
      probeSource,
      probeErrorCode: undefined,
    }
  }

  if (auth.probeStatus === 'NOT_AUTHENTICATED' && !auth.error) {
    return {
      ...auth,
      probeStatus: 'NOT_AUTHENTICATED',
      probeSource,
      probeErrorCode: undefined,
    }
  }

  if (auth.probeStatus === 'PROBE_FAILED' || auth.error) {
    return {
      ...auth,
      probeStatus: 'PROBE_FAILED',
      probeSource,
      probeErrorCode: auth.probeErrorCode ?? 'UNKNOWN_ERROR',
    }
  }

  // A legacy adapter returning only `isAuthenticated: false` has not proven
  // logout. The same shape is also used for response drift, missing IDs and
  // platform rejection, so fail closed unless the adapter opts into the
  // explicit NOT_AUTHENTICATED contract.
  return {
    ...auth,
    probeStatus: 'PROBE_FAILED',
    probeSource,
    probeErrorCode: 'UNKNOWN_ERROR',
  }
}

function authFailureFromError(error: unknown): AuthResult {
  const probeErrorCode: AuthProbeErrorCode =
    error instanceof OperationTimeoutError ? 'TIMEOUT' : 'UNKNOWN_ERROR'
  return {
    isAuthenticated: false,
    error: error instanceof Error ? error.message : 'Account probe failed',
    probeStatus: 'PROBE_FAILED',
    probeSource: 'EXTENSION',
    probeErrorCode,
  }
}

/**
 * 检查平台登录状态
 */
export async function checkPlatformAuth(platformId: string) {
  const adapter = await getAdapter(platformId)
  if (!adapter) {
    return {
      isAuthenticated: false,
      error: 'Platform not found',
      probeStatus: 'PROBE_FAILED' as const,
      probeSource: 'EXTENSION' as const,
      probeErrorCode: 'PLATFORM_NOT_FOUND' as const,
    }
  }
  try {
    return normalizeAuthProbeResult(
      await withTimeout(
        adapter.checkAuth(),
        AUTH_CHECK_TIMEOUT,
        `认证检查超时（${AUTH_CHECK_TIMEOUT / 1000}秒）`
      )
    )
  } catch (error) {
    return authFailureFromError(error)
  }
}

interface AuthCacheItem extends AuthResult {
  timestamp: number
}

interface AuthCache {
  [platformId: string]: AuthCacheItem
}

/**
 * 获取缓存的认证状态
 */
async function getCachedAuth(): Promise<AuthCache> {
  try {
    const storage = await chrome.storage.local.get(AUTH_CACHE_KEY)
    return storage[AUTH_CACHE_KEY] || {}
  } catch {
    return {}
  }
}

/**
 * 保存认证状态到缓存
 */
async function setCachedAuth(cache: AuthCache): Promise<void> {
  await chrome.storage.local.set({ [AUTH_CACHE_KEY]: cache })
}

/**
 * 清除认证缓存
 */
export async function clearAuthCache(): Promise<void> {
  await chrome.storage.local.remove(AUTH_CACHE_KEY)
}

/**
 * 检查所有平台登录状态（带缓存，并行检查）
 */
export async function checkAllPlatformsAuth(
  forceRefresh = false,
  targetPlatformIds?: readonly string[],
) {
  await initAdapters()

  const targetPlatforms = targetPlatformIds
    ? new Set(targetPlatformIds)
    : null
  const metas = adapterRegistry
    .getAllMeta()
    .filter(meta => !targetPlatforms || targetPlatforms.has(meta.id))
  const cache = await getCachedAuth()
  const now = Date.now()
  const results: Array<PlatformMeta & AuthResult> = []
  const needsCheck: PlatformMeta[] = [] // 需要实际检查的平台

  logger.debug(' Checking auth for platforms:', metas.map(m => m.id), forceRefresh ? '(force refresh)' : '')

  // 第一步：分离缓存命中和需要检查的平台
  for (const meta of metas) {
    const cached = cache[meta.id]
    const cacheTTL = cached?.isAuthenticated ? AUTH_CACHE_TTL_AUTHENTICATED : AUTH_CACHE_TTL_UNAUTHENTICATED
    const cacheValid = cached && (now - cached.timestamp < cacheTTL) && !forceRefresh

    if (cacheValid) {
      logger.debug(` Using cached auth for ${meta.id} (TTL: ${cacheTTL / 1000}s)`)
      results.push({
        ...meta,
        isAuthenticated: cached.isAuthenticated,
        username: cached.username,
        userId: cached.userId,
        avatar: cached.avatar,
        error: cached.error,
        probeStatus: cached.probeStatus,
        probeSource: cached.probeSource,
        probeErrorCode: cached.probeErrorCode,
        primaryProbeErrorCode: cached.primaryProbeErrorCode,
      })
    } else {
      needsCheck.push(meta)
    }
  }

  // 第二步：并行检查需要刷新的平台（分批，每批 AUTH_CHECK_CONCURRENCY 个）
  if (needsCheck.length > 0) {
    logger.debug(` Need to check ${needsCheck.length} platforms in parallel`)

    for (let i = 0; i < needsCheck.length; i += AUTH_CHECK_CONCURRENCY) {
      const batch = needsCheck.slice(i, i + AUTH_CHECK_CONCURRENCY)
      const batchResults = await Promise.all(batch.map(async (meta) => {
        try {
          const adapter = await adapterRegistry.get(meta.id)
          if (adapter) {
            logger.debug(` Checking auth for ${meta.id}...`)
            const auth = normalizeAuthProbeResult(
              await withTimeout(
                adapter.checkAuth(),
                AUTH_CHECK_TIMEOUT,
                `认证检查超时（${AUTH_CHECK_TIMEOUT / 1000}秒）`
              )
            )
            logger.debug(` ${meta.id} auth result:`, {
              isAuthenticated: auth.isAuthenticated,
              hasStableUserId: Boolean(auth.userId),
              hasAvatar: Boolean(auth.avatar),
            })

            // 追踪认证检查
            trackAuthCheck(meta.id, auth.isAuthenticated).catch(() => {})

            // 更新缓存
            cache[meta.id] = {
              isAuthenticated: auth.isAuthenticated,
              username: auth.username,
              userId: auth.userId,
              avatar: auth.avatar,
              error: auth.error,
              probeStatus: auth.probeStatus,
              probeSource: auth.probeSource,
              probeErrorCode: auth.probeErrorCode,
              primaryProbeErrorCode: auth.primaryProbeErrorCode,
              timestamp: now,
            }

            return {
              ...meta,
              isAuthenticated: auth.isAuthenticated,
              username: auth.username,
              userId: auth.userId,
              avatar: auth.avatar,
              error: auth.error,
              probeStatus: auth.probeStatus,
              probeSource: auth.probeSource,
              probeErrorCode: auth.probeErrorCode,
              primaryProbeErrorCode: auth.primaryProbeErrorCode,
            }
          }
          return {
            ...meta,
            isAuthenticated: false,
            error: 'Adapter not found',
            probeStatus: 'PROBE_FAILED' as const,
            probeSource: 'EXTENSION' as const,
            probeErrorCode: 'PLATFORM_NOT_FOUND' as const,
          }
        } catch (error) {
          logger.error(`${meta.id} auth error:`, error)
          const failure = authFailureFromError(error)

          // 缓存错误状态
          cache[meta.id] = {
            ...failure,
            timestamp: now,
          }

          return {
            ...meta,
            ...failure,
          }
        }
      }))
      results.push(...batchResults)
    }
  }

  // 保存更新后的缓存
  await setCachedAuth(cache)

  // 追踪首次平台登录里程碑
  const hasLoggedIn = results.some(r => r.isAuthenticated)
  if (hasLoggedIn) {
    trackMilestone('first_platform_login').catch(() => {})
  }

  return results
}

/**
 * 图片进度回调类型
 */
export type ImageProgressCallback = (platform: string, current: number, total: number) => void

/**
 * 同步阶段类型
 */
export type SyncStage =
  | 'starting'
  | 'uploading_images'
  | 'saving'
  | 'completed'
  | 'review_required'
  | 'failed'

/**
 * 详细同步进度类型
 */
export interface SyncDetailProgress {
  platform: string
  platformName: string
  externalAccountId?: string
  stage: SyncStage
  // 图片上传进度（uploading_images 阶段）
  imageProgress?: { current: number; total: number }
  // 同步结果（completed/failed 阶段）
  result?: SyncResult
  // 错误信息（failed 阶段）
  error?: string
}

/**
 * 同步进度回调类型
 */
export interface SyncCallbacks {
  onResult?: (result: SyncResult) => void
  onImageProgress?: ImageProgressCallback
  // 新增：详细进度回调
  onDetailProgress?: (progress: SyncDetailProgress) => void
}

/**
 * 同步文章到平台
 */
export async function syncToPlatform(
  platformId: string,
  article: Article,
  options?: {
    draftOnly?: boolean
    accountBinding?: AdapterAccountBinding
    /** Persist the v3 write boundary after validation and before platform I/O. */
    beforeDispatch?: () => void | Promise<void>
  },
  onImageProgress?: ImageProgressCallback
): Promise<SyncResult> {
  const adapter = await getAdapter(platformId)
  if (!adapter) {
    return {
      platform: platformId,
      success: false,
      error: 'Platform not found',
      timestamp: Date.now(),
    }
  }

  const accountBinding =
    options?.accountBinding === undefined
      ? undefined
      : normalizeAdapterAccountBinding(options.accountBinding)
  if (options?.accountBinding !== undefined && !accountBinding) {
    return {
      platform: platformId,
      success: false,
      errorCode: 'INVALID_ACCOUNT_BINDING',
      error: 'Invalid account binding',
      timestamp: Date.now(),
    }
  }
  if (
    accountBinding &&
    !adapter.meta.capabilities.includes('account_binding')
  ) {
    return {
      platform: platformId,
      success: false,
      externalAccountId: accountBinding.externalAccountId,
      errorCode: ACCOUNT_BINDING_SYNC_ERROR_CODES.UNSUPPORTED,
      error: 'Platform does not support exact account binding',
      timestamp: Date.now(),
    }
  }
  if (accountBinding && typeof adapter.probeAccounts !== 'function') {
    return {
      platform: platformId,
      success: false,
      externalAccountId: accountBinding.externalAccountId,
      errorCode: ACCOUNT_BINDING_SYNC_ERROR_CODES.PROBE_UNAVAILABLE,
      error: 'Platform account binding probe is unavailable',
      timestamp: Date.now(),
    }
  }

  try {
    // 使用平台特定的预处理内容（如果有）
    let platformArticle = article
    const platformContents = (article as any).platformContents as Record<string, { html: string; markdown: string }> | undefined
    if (platformContents?.[platformId]) {
      const content = platformContents[platformId]
      platformArticle = {
        ...article,
        html: content.html,
        markdown: content.markdown,
      }
    }

    // 默认只保存草稿，带超时保护
    const publishController = new AbortController()
    const guardedBeforeDispatch = options?.beforeDispatch
      ? async () => {
          // A timed-out adapter may still finish its asynchronous preflight.
          // Never let that stale promise cross the first-write boundary.
          if (publishController.signal.aborted) {
            throw new OperationTimeoutError(
              `发布超时（${PUBLISH_TIMEOUT / 60000}分钟）`,
            )
          }
          await options.beforeDispatch?.()
          if (publishController.signal.aborted) {
            throw new OperationTimeoutError(
              `发布超时（${PUBLISH_TIMEOUT / 60000}分钟）`,
            )
          }
        }
      : undefined
    const result = await withTimeout(
      adapter.publish(platformArticle, {
        draftOnly: options?.draftOnly ?? true,
        ...(accountBinding ? { accountBinding } : {}),
        ...(guardedBeforeDispatch
          ? { beforeDispatch: guardedBeforeDispatch }
          : {}),
        onImageProgress: onImageProgress
          ? (current: number, total: number) => onImageProgress(platformId, current, total)
          : undefined,
      }),
      PUBLISH_TIMEOUT,
      `发布超时（${PUBLISH_TIMEOUT / 60000}分钟）`,
      () => publishController.abort(),
    )
    const normalizedResultExternalAccountId =
      normalizeAdapterExternalAccountId(result.externalAccountId)
    const {
      externalAccountId: _untrustedResultExternalAccountId,
      ...resultWithoutExternalAccountId
    } = result
    const normalizedResult: SyncResult = normalizedResultExternalAccountId
      ? {
          ...resultWithoutExternalAccountId,
          externalAccountId: normalizedResultExternalAccountId,
        }
      : resultWithoutExternalAccountId
    if (
      accountBinding &&
      normalizedResult.success &&
      !normalizedResultExternalAccountId
    ) {
      return {
        ...normalizedResult,
        outcome: 'OUTCOME_UNKNOWN',
        retryable: false,
        requestedExternalAccountId: accountBinding.externalAccountId,
        errorCode: ACCOUNT_BINDING_SYNC_ERROR_CODES.RESULT_IDENTITY_MISSING,
        error:
          'Platform reported a successful write, but the bound account identity could not be confirmed. Do not retry automatically.',
      }
    }
    if (
      accountBinding &&
      normalizedResult.success &&
      normalizedResultExternalAccountId !== null &&
      normalizedResultExternalAccountId !== accountBinding.externalAccountId
    ) {
      return {
        ...normalizedResult,
        outcome: 'OUTCOME_UNKNOWN',
        retryable: false,
        requestedExternalAccountId: accountBinding.externalAccountId,
        observedExternalAccountId: normalizedResultExternalAccountId,
        errorCode: ACCOUNT_BINDING_SYNC_ERROR_CODES.RESULT_IDENTITY_MISMATCH,
        error:
          'Platform reported a successful write, but the observed account identity did not match the requested binding. Do not retry automatically.',
      }
    }
    return normalizedResult
  } catch (error) {
    if (error instanceof OperationTimeoutError) {
      return {
        platform: platformId,
        success: true,
        outcome: 'OUTCOME_UNKNOWN',
        retryable: false,
        ...(accountBinding
          ? {
              externalAccountId: accountBinding.externalAccountId,
              requestedExternalAccountId: accountBinding.externalAccountId,
            }
          : {}),
        errorCode: PUBLISH_SYNC_ERROR_CODES.TIMEOUT_OUTCOME_UNKNOWN,
        error: PUBLISH_TIMEOUT_OUTCOME_UNKNOWN_MESSAGE,
        timestamp: Date.now(),
      }
    }
    return {
      platform: platformId,
      success: false,
      ...(accountBinding
        ? { externalAccountId: accountBinding.externalAccountId }
        : {}),
      error: (error as Error).message,
      timestamp: Date.now(),
    }
  }
}

// 并发数量限制
const CONCURRENCY_LIMIT = 3

// 同步取消控制
let syncAbortController: AbortController | null = null

/**
 * 取消正在进行的同步
 */
export function cancelSync(): boolean {
  if (syncAbortController) {
    syncAbortController.abort()
    syncAbortController = null
    return true
  }
  return false
}

/**
 * 检查同步是否正在进行
 */
export function isSyncing(): boolean {
  return syncAbortController !== null
}

/**
 * 同步文章到多个平台（并行，最多同时 3 个，支持取消）
 */
export async function syncToMultiplePlatforms(
  platformIds: string[],
  article: Article,
  callbacks?: SyncCallbacks,
  source = 'popup', // 来源：popup, weixin, weixin-editor, mcp 等
  options?: {
    accountBindings?: readonly PlatformAccountBinding[]
  },
): Promise<SyncResult[]> {
  let accountBindings: PlatformAccountBinding[] = []
  if (options?.accountBindings !== undefined) {
    const validatedBindings = validatePlatformAccountBindings(
      platformIds,
      options.accountBindings,
    )
    if (!validatedBindings.success) {
      throw new Error(INVALID_ACCOUNT_BINDINGS)
    }
    accountBindings = validatedBindings.accountBindings
  }
  const accountBindingByPlatform = new Map(
    accountBindings.map((binding) => [
      binding.platform,
      { externalAccountId: binding.externalAccountId },
    ]),
  )

  // 创建新的取消控制器
  syncAbortController = new AbortController()
  const signal = syncAbortController.signal

  const results: SyncResult[] = []
  const startTime = Date.now()

  // 追踪同步开始
  trackSyncStart(source, platformIds).catch(() => {})

  // 追踪使用时段
  trackUsageTime().catch(() => {})

  // 追踪平台组合
  trackPlatformCombination(platformIds).catch(() => {})

  // 追踪首次同步尝试里程碑
  trackMilestone('first_sync_attempt').catch(() => {})

  // 获取平台名称的辅助函数
  const getPlatformName = (platformId: string): string => {
    const meta = getAllPlatformMetas().find(p => p.id === platformId)
    return meta?.name || platformId
  }

  // 同步单个平台并追踪
  const syncOne = async (platformId: string): Promise<SyncResult> => {
    const platformName = getPlatformName(platformId)
    const accountBinding = accountBindingByPlatform.get(platformId)

    // 检查是否已取消
    if (signal.aborted) {
      const cancelledResult: SyncResult = {
        platform: platformId,
        ...(accountBinding
          ? { externalAccountId: accountBinding.externalAccountId }
          : {}),
        success: false,
        error: '已取消',
        timestamp: Date.now(),
      }
      callbacks?.onDetailProgress?.({
        platform: platformId,
        platformName,
        ...(accountBinding
          ? { externalAccountId: accountBinding.externalAccountId }
          : {}),
        stage: 'failed',
        result: cancelledResult,
        error: '已取消',
      })
      return cancelledResult
    }

    // 通知开始同步
    callbacks?.onDetailProgress?.({
      platform: platformId,
      platformName,
      ...(accountBinding
        ? { externalAccountId: accountBinding.externalAccountId }
        : {}),
      stage: 'starting',
    })

    const platformStartTime = Date.now()

    // 包装图片进度回调，同时触发 onDetailProgress
    const wrappedImageProgress: ImageProgressCallback | undefined = callbacks?.onImageProgress || callbacks?.onDetailProgress
      ? (platform, current, total) => {
          callbacks?.onImageProgress?.(platform, current, total)
          callbacks?.onDetailProgress?.({
            platform: platformId,
            platformName,
            ...(accountBinding
              ? { externalAccountId: accountBinding.externalAccountId }
              : {}),
            stage: 'uploading_images',
            imageProgress: { current, total },
          })
          // 图片上传完成后，切换到 saving 阶段
          if (current === total && total > 0) {
            callbacks?.onDetailProgress?.({
              platform: platformId,
              platformName,
              ...(accountBinding
                ? { externalAccountId: accountBinding.externalAccountId }
                : {}),
              stage: 'saving',
            })
          }
        }
      : undefined

    const result = await syncToPlatform(
      platformId,
      article,
      accountBinding ? { accountBinding } : undefined,
      wrappedImageProgress
    )

    const terminalStage: SyncStage =
      result.outcome === 'OUTCOME_UNKNOWN'
        ? 'review_required'
        : result.success
          ? 'completed'
          : 'failed'

    // 通知完成/待核验/失败
    callbacks?.onDetailProgress?.({
      platform: platformId,
      platformName,
      ...(accountBinding
        ? { externalAccountId: accountBinding.externalAccountId }
        : {}),
      stage: terminalStage,
      result,
      error: result.error,
    })

    callbacks?.onResult?.(result)

    // 追踪单个平台同步结果
    const platformDuration = Date.now() - platformStartTime
    const confirmedSuccess = isConfirmedSyncSuccess(result)
    trackPlatformSync(source, platformId, confirmedSuccess, {
      draftOnly: result.draftOnly,
      errorType: result.error ? inferErrorType(result.error) : undefined,
      duration: platformDuration,
      outcome:
        result.outcome ?? (result.success ? 'SUCCEEDED' : 'FAILED'),
    }).catch(() => {})

    return result
  }

  // 分批并行执行（每批最多 CONCURRENCY_LIMIT 个）
  for (let i = 0; i < platformIds.length; i += CONCURRENCY_LIMIT) {
    // 每批前检查是否取消
    if (signal.aborted) {
      // 剩余平台标记为已取消
      const remaining = platformIds.slice(i)
      for (const platformId of remaining) {
        const platformName = getPlatformName(platformId)
        const accountBinding = accountBindingByPlatform.get(platformId)
        const cancelledResult: SyncResult = {
          platform: platformId,
          ...(accountBinding
            ? { externalAccountId: accountBinding.externalAccountId }
            : {}),
          success: false,
          error: '已取消',
          timestamp: Date.now(),
        }
        results.push(cancelledResult)
        callbacks?.onDetailProgress?.({
          platform: platformId,
          platformName,
          ...(accountBinding
            ? { externalAccountId: accountBinding.externalAccountId }
            : {}),
          stage: 'failed',
          result: cancelledResult,
          error: '已取消',
        })
        callbacks?.onResult?.(cancelledResult)
      }
      break
    }

    const batch = platformIds.slice(i, i + CONCURRENCY_LIMIT)
    const batchResults = await Promise.all(batch.map(syncOne))
    results.push(...batchResults)
  }

  // 清除控制器
  syncAbortController = null

  // 追踪同步完成
  const successCount = results.filter(isConfirmedSyncSuccess).length
  const reviewRequiredCount = results.filter(
    r => r.outcome === 'OUTCOME_UNKNOWN'
  ).length
  const cancelledCount = results.filter(r => r.error === '已取消').length
  trackSyncComplete({
    source,
    total: results.length,
    success: successCount,
    failed:
      results.length -
      successCount -
      reviewRequiredCount -
      cancelledCount,
    reviewRequired: reviewRequiredCount,
    platforms: platformIds,
    duration: Date.now() - startTime,
  }).catch(() => {})

  // 追踪首次同步成功里程碑
  if (successCount > 0) {
    trackMilestone('first_sync_success').catch(() => {})
  }

  // 更新累计统计（会自动触发里程碑检查）
  updateCumulativeStats(platformIds).catch(() => {})

  return results
}
