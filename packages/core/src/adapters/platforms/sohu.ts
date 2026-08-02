/**
 * 搜狐号适配器
 */
import { CodeAdapter, type ImageUploadResult } from '../code-adapter'
import type { Article, AuthResult, SyncResult, PlatformMeta } from '../../types'
import type {
  AdapterAccount,
  AdapterAccountProbe,
  PreprocessConfig,
  PublicationPublishedProof,
  PublishOptions,
} from '../types'
import {
  adapterAccountSelectionErrorMessage,
  normalizeAdapterAccountBinding,
  resolveAdapterAccountBinding,
} from '../account-binding'
import type {
  PublicationInspectionObservation as PublicationObservation,
  PublicationInspectionRequest as PublicationInspectRequest,
} from '../../publication-inspection/domain'
import { inspectSohuPublication } from '../../publication-inspection/sohu'
import { createLogger } from '../../lib/logger'

const logger = createLogger('Sohu')

/**
 * 生成设备 ID (dv-id)
 */
function generateDeviceId(): string {
  const chars = '0123456789abcdef'
  let result = ''
  for (let i = 0; i < 32; i++) {
    result += chars[Math.floor(Math.random() * chars.length)]
  }
  return result
}

function normalizeSafePositiveIntegerId(value: unknown): string | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? String(value) : null
  }

  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) {
    return null
  }

  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? value : null
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function normalizeDisplayName(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const normalized = value.trim()
  return normalized.length > 0 && normalized.length <= 500
    ? normalized
    : fallback
}

function normalizeAvatarUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  if (normalized.length === 0 || normalized.length > 2_000) return undefined
  try {
    const url = new URL(normalized)
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? url.href
      : undefined
  } catch {
    return undefined
  }
}

export class SohuAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'sohu',
    name: '搜狐号',
    icon: 'https://mp.sohu.com/favicon.ico',
    homepage: 'https://mp.sohu.com/mpfe/v3/main/first/page?newsType=1',
    capabilities: ['article', 'draft', 'image_upload', 'account_binding'],
  }

  /** 预处理配置: 搜狐号将表格整体转为 SVG 图片，避免平台清洗 HTML 表格样式 */
  readonly preprocessConfig: Partial<PreprocessConfig> = {
    outputFormat: 'html' as const,
    tableFormat: 'svg-image',
    boldHeadingLevels: [3],
  }

  private deviceId: string = generateDeviceId()
  private spCm: string = ''

  /** 搜狐号 API 需要的 Header 规则 */
  private readonly HEADER_RULES = [
    {
      urlFilter: '*://mp.sohu.com/*',
      headers: {
        Origin: 'https://mp.sohu.com',
        Referer: 'https://mp.sohu.com/',
      },
      resourceTypes: ['xmlhttprequest'],
    },
  ]

  /**
   * Atomically enumerate the complete authenticated Sohu sub-account set.
   * A malformed row invalidates the complete probe so it cannot be mistaken
   * for a safe single-account session.
   */
  async probeAccounts(): Promise<AdapterAccountProbe> {
    try {
      const response = await this.runtime.fetch(
        `https://mp.sohu.com/mpbp/bp/account/list?_=${Date.now()}`,
        {
          method: 'GET',
          credentials: 'include',
        },
      )
      if (!response.ok) {
        return {
          status: 'PROBE_FAILED',
          accounts: [],
          errorCode: 'HTTP_ERROR',
        }
      }

      const res: unknown = await response.json()
      if (
        !isPlainRecord(res) ||
        res.code !== 2000000 ||
        !isPlainRecord(res.data) ||
        !Array.isArray(res.data.data)
      ) {
        return {
          status: 'PROBE_FAILED',
          accounts: [],
          errorCode: 'RESPONSE_SCHEMA_MISMATCH',
        }
      }

      const accounts: AdapterAccount[] = []
      const seenAccountIds = new Set<string>()
      for (const group of res.data.data) {
        if (!isPlainRecord(group) || !Array.isArray(group.accounts)) {
          return {
            status: 'PROBE_FAILED',
            accounts: [],
            errorCode: 'RESPONSE_SCHEMA_MISMATCH',
          }
        }
        for (const candidate of group.accounts) {
          if (!isPlainRecord(candidate)) {
            return {
              status: 'PROBE_FAILED',
              accounts: [],
              errorCode: 'RESPONSE_SCHEMA_MISMATCH',
            }
          }
          const externalAccountId = normalizeSafePositiveIntegerId(candidate.id)
          if (!externalAccountId || seenAccountIds.has(externalAccountId)) {
            return {
              status: 'PROBE_FAILED',
              accounts: [],
              errorCode: 'ACCOUNT_ID_MISSING',
            }
          }
          seenAccountIds.add(externalAccountId)
          const avatarUrl = normalizeAvatarUrl(candidate.avatar)
          accounts.push({
            externalAccountId,
            displayName: normalizeDisplayName(
              candidate.nickName,
              externalAccountId,
            ),
            ...(avatarUrl ? { avatarUrl } : {}),
          })
        }
      }

      if (accounts.length === 0) {
        return { status: 'NOT_AUTHENTICATED', accounts: [] }
      }

      await this.fetchSpCm()
      logger.info('Authenticated Sohu account probe completed', {
        accountCount: accounts.length,
      })
      return { status: 'AUTHENTICATED', accounts }
    } catch {
      logger.debug('Sohu account probe failed')
      return {
        status: 'PROBE_FAILED',
        accounts: [],
        errorCode: 'UNKNOWN_ERROR',
      }
    }
  }

  /**
   * Frozen compatibility projection for legacy/v2 account discovery.
   */
  async checkAuth(): Promise<AuthResult> {
    const probe = await this.probeAccounts()
    if (probe.status === 'NOT_AUTHENTICATED') {
      return {
        isAuthenticated: false,
        probeStatus: 'NOT_AUTHENTICATED',
        probeSource: 'EXTENSION',
      }
    }
    if (probe.status !== 'AUTHENTICATED' || probe.accounts.length === 0) {
      return {
        isAuthenticated: false,
        probeStatus: 'PROBE_FAILED',
        probeSource: 'EXTENSION',
        probeErrorCode:
          probe.status === 'PROBE_FAILED'
            ? (probe.errorCode ?? 'UNKNOWN_ERROR')
            : 'UNKNOWN_ERROR',
      }
    }

    const primary = probe.accounts[0]
    return {
      isAuthenticated: true,
      probeStatus: 'AUTHENTICATED',
      probeSource: 'EXTENSION',
      userId: primary.externalAccountId,
      username:
        probe.accounts.length > 1
          ? `${primary.displayName} (共${probe.accounts.length}个子账号)`
          : primary.displayName,
      ...(primary.avatarUrl ? { avatar: primary.avatarUrl } : {}),
    }
  }

  private authResultFromProbe(probe: AdapterAccountProbe): AuthResult {
    if (probe.status === 'PROBE_FAILED') {
      return { isAuthenticated: false, error: 'Account probe failed' }
    }
    if (probe.status !== 'AUTHENTICATED' || probe.accounts.length === 0) {
      return { isAuthenticated: false }
    }
    const account = probe.accounts[0]
    return {
      isAuthenticated: true,
      userId: account.externalAccountId,
      username: account.displayName,
      ...(account.avatarUrl ? { avatar: account.avatarUrl } : {}),
    }
  }

  async inspectPublication(
    request: PublicationInspectRequest,
  ): Promise<PublicationObservation[]> {
    return this.withHeaderRules(this.HEADER_RULES, async () => {
      const probe = await this.probeAccounts()
      return inspectSohuPublication(request, {
        checkAuth: async () => this.authResultFromProbe(probe),
        hasAuthenticatedAccount: (externalAccountId) =>
          probe.status === 'AUTHENTICATED' &&
          probe.accounts.some(
            (account) => account.externalAccountId === externalAccountId,
          ),
        fetch: (url, options) => this.runtime.fetch(url, options),
        detailHeaders: () => ({
          'x-requested-with': 'XMLHttpRequest',
          'dv-id': this.deviceId,
          'sp-cm': this.spCm,
        }),
      })
    })
  }

  provePublishedObservation(
    request: PublicationInspectRequest,
    observation: PublicationObservation,
  ): PublicationPublishedProof | null {
    if (
      request.platform !== 'sohu' ||
      observation.platform !== 'sohu' ||
      observation.externalAccountId !== request.externalAccountId ||
      observation.outcome !== 'PUBLISHED' ||
      observation.source !== 'PUBLIC_PAGE' ||
      !observation.platformPostId ||
      !observation.canonicalUrl ||
      !observation.publishedAt ||
      !observation.title?.trim() ||
      !observation.bodyText?.trim() ||
      typeof observation.bodyTruncated !== 'boolean' ||
      observation.publicAccess?.status !== 'CONFIRMED' ||
      observation.errorCode !== undefined ||
      observation.errorMessage !== undefined
    ) {
      return null
    }

    // The inspector reaches PUBLISHED only after the anonymous canonical URL
    // proves both the stable post ID and the bound Sohu media ID.
    return {
      observedAuthorExternalAccountId: observation.externalAccountId,
      publicAccess: observation.publicAccess,
      bodyTruncated: observation.bodyTruncated,
    }
  }

  /**
   * 获取 sp-cm 值 (从 cookie 或生成)
   */
  private async fetchSpCm(): Promise<void> {
    try {
      // 尝试通过 runtime 获取 cookie（如果支持）
      if (this.runtime.getCookie) {
        const cookieValue = await this.runtime.getCookie('.sohu.com', 'mp-cv')
        if (cookieValue) {
          this.spCm = cookieValue
          logger.debug('Got sp-cm from cookie:', this.spCm)
          return
        }
      }
      // fallback: 生成一个
      this.spCm = `100-${Date.now()}-${generateDeviceId()}`
      logger.debug('Generated sp-cm:', this.spCm)
    } catch (error) {
      // fallback: 生成一个
      this.spCm = `100-${Date.now()}-${generateDeviceId()}`
      logger.debug('Fallback sp-cm:', this.spCm)
    }
  }

  async publish(
    article: Article,
    options?: PublishOptions,
  ): Promise<SyncResult> {
    const requestedBinding =
      options?.accountBinding === undefined
        ? undefined
        : normalizeAdapterAccountBinding(options.accountBinding)
    const requestedExternalAccountId = requestedBinding?.externalAccountId
    let operationExternalAccountId = requestedExternalAccountId
    let saveRequestStarted = false
    let terminalSaveResult: SyncResult | undefined

    const createUnknownSaveResult = (): SyncResult =>
      this.createResult(true, {
        ...(operationExternalAccountId
          ? { externalAccountId: operationExternalAccountId }
          : {}),
        outcome: 'OUTCOME_UNKNOWN',
        retryable: false,
        draftOnly: options?.draftOnly ?? true,
        errorCode: 'SOHU_DRAFT_SAVE_OUTCOME_UNKNOWN',
        error:
          '搜狐草稿保存请求已发出，但无法确认最终结果；请人工核验，勿重复提交',
      })

    return this.withHeaderRules(this.HEADER_RULES, async () => {
      logger.info('Starting publish...')

      const selection = resolveAdapterAccountBinding(
        await this.probeAccounts(),
        options?.accountBinding,
      )
      if (!selection.ok) {
        return this.createResult(false, {
          ...(requestedExternalAccountId
            ? { externalAccountId: requestedExternalAccountId }
            : {}),
          errorCode: selection.errorCode,
          error: adapterAccountSelectionErrorMessage(selection.errorCode),
        })
      }
      const account = selection.account
      operationExternalAccountId = account.externalAccountId

      await options?.beforeDispatch?.()

      // Use pre-processed HTML content directly
      let content = article.html || ''

      // Process images
      content = await this.processImages(
        content,
        (src) => this.uploadImageForAccount(src, account),
        {
          skipPatterns: ['sohu.com'],
          onProgress: options?.onImageProgress,
        },
      )

      // 4. 保存草稿 (v2 API - JSON 格式)
      const postData = {
        title: article.title,
        brief: '',
        content: content,
        channelId: 24,
        categoryId: -1,
        id: 0,
        userColumnId: 0,
        columnNewsIds: [],
        businessCode: 0,
        declareOriginal: false,
        cover: '',
        topicIds: [],
        isAd: 0,
        userLabels: '[]',
        reprint: false,
        customTags: '',
        infoResource: 0,
        sourceUrl: '',
        visibleToLoginedUsers: 0,
        attrIds: [],
        auto: true,
        accountId: Number(account.externalAccountId),
      }

      saveRequestStarted = true
      const response = await this.runtime.fetch(
        `https://mp.sohu.com/mpbp/bp/news/v4/news/draft/v2?accountId=${account.externalAccountId}`,
        {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
            'dv-id': this.deviceId,
            'sp-cm': this.spCm,
          },
          body: JSON.stringify(postData),
        },
      )

      const res = (await response.json()) as {
        success?: unknown
        data?: string | number
        msg?: string
      }

      logger.debug(' Save response:', res)

      if (res?.success === false) {
        terminalSaveResult = this.createResult(false, {
          externalAccountId: account.externalAccountId,
          errorCode: 'SOHU_DRAFT_SAVE_REJECTED',
          error: res.msg || '保存失败',
        })
        return terminalSaveResult
      }
      if (res?.success !== true) {
        terminalSaveResult = createUnknownSaveResult()
        return terminalSaveResult
      }

      const postId = normalizeSafePositiveIntegerId(res.data)
      if (!postId) {
        terminalSaveResult = createUnknownSaveResult()
        return terminalSaveResult
      }
      const draftUrl = `https://mp.sohu.com/mpfe/v4/contentManagement/news/addarticle?spm=smmp.articlelist.0.0&contentStatus=2&id=${postId}&accountId=${account.externalAccountId}`

      terminalSaveResult = this.createResult(true, {
        postId: String(postId),
        postUrl: draftUrl,
        externalAccountId: account.externalAccountId,
        draftOnly: options?.draftOnly ?? true,
      })
      return terminalSaveResult
    }).catch((error) => {
      if (terminalSaveResult) return terminalSaveResult
      if (saveRequestStarted) return createUnknownSaveResult()
      return this.createResult(false, {
        ...(operationExternalAccountId
          ? { externalAccountId: operationExternalAccountId }
          : {}),
        error: (error as Error).message,
      })
    })
  }

  /**
   * 通过 URL 上传图片
   */
  protected async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    const selection = resolveAdapterAccountBinding(await this.probeAccounts())
    if (!selection.ok) {
      throw new Error(adapterAccountSelectionErrorMessage(selection.errorCode))
    }
    return this.uploadImageForAccount(src, selection.account)
  }

  private async uploadImageForAccount(
    src: string,
    account: AdapterAccount,
  ): Promise<ImageUploadResult> {
    // 1. 下载图片
    const imageResponse = await fetch(src)
    if (!imageResponse.ok) {
      throw new Error('图片下载失败: ' + src)
    }
    const imageBlob = await imageResponse.blob()

    // 2. 上传到搜狐
    const formData = new FormData()
    const filename =
      imageBlob.type === 'image/svg+xml' ? 'table.svg' : 'image.jpg'
    formData.append('file', imageBlob, filename)
    formData.append('accountId', account.externalAccountId)

    const uploadResponse = await this.runtime.fetch(
      'https://mp.sohu.com/commons/front/outerUpload/image/file?accountId=' +
        account.externalAccountId,
      {
        method: 'POST',
        credentials: 'include',
        body: formData,
      },
    )

    const res = (await uploadResponse.json()) as {
      url?: string
      msg?: string
    }

    logger.debug(' Image upload response:', res)
    if (!res.url) {
      throw new Error('图片上传失败:' + res.msg)
    }

    return {
      url: res.url,
    }
  }
}
