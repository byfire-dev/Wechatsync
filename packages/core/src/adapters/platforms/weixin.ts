/**
 * 微信公众号适配器
 */
import { CodeAdapter, type ImageUploadResult } from '../code-adapter'
import type { Article, AuthResult, SyncResult, PlatformMeta } from '../../types'
import type {
  AdapterAccountProbe,
  AdapterOperationContext,
  PublicationPublishedProof,
  PublishOptions,
} from '../types'
import {
  adapterAccountSelectionErrorMessage,
  normalizeAdapterAccountBinding,
  normalizeAdapterExternalAccountId,
  resolveAdapterAccountBinding,
} from '../account-binding'
import type {
  OpenPublicationDraftRequest,
  OpenPublicationDraftResult,
} from '../../publication-inspection/types'
import {
  PublicationInspectionObservationSchema,
  type PublicationInspectionObservation as PublicationObservation,
  type PublicationInspectionRequest as PublicationInspectRequest,
} from '../../publication-inspection/domain'
import { derivePublicationPublicIdentity } from '../../publication-inspection/url'
import {
  buildWeixinPublishedListRequest,
  buildWeixinTempUrlRequest,
  normalizeWeixinAppMsgId,
  parseWeixinDraftHtml,
  parseWeixinPublishedListPayload,
  parseWeixinPublicArticleHtml,
  parseWeixinTempUrlPayload,
  normalizeWeixinLongPublicArticleUrl,
  resolveWeixinAppMsgId,
  resolveWeixinTempUrl,
  validateWeixinPublicPageResponse,
  WEIXIN_PUBLISHED_LIST_MAX_PAGES,
  WEIXIN_PUBLISHED_LIST_PAGE_SIZE,
  WEIXIN_PUBLIC_PAGE_MAX_BYTES,
} from '../../publication-inspection/weixin'
import { createLogger } from '../../lib/logger'
import {
  discardResponseBody,
  fetchWithValidatedNoRedirects,
  readBoundedResponseText,
  type BoundedResponseTextErrorCode,
  type SafeNoRedirectFetchErrorCode,
} from '../../lib/safe-http'
import juice from 'juice'

const logger = createLogger('Weixin')

function normalizeAccountDisplayName(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length > 0 &&
    normalized.length <= 500 &&
    !/[\u0000-\u001f\u007f]/.test(normalized)
    ? normalized
    : fallback
}

function normalizeAccountAvatarUrl(value: unknown): string | undefined {
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

interface WeixinMeta {
  token: string
  userName: string
  nickName: string
  ticket: string
  svrTime: number
  avatar: string
}

type WeixinPublishedLookup =
  | { kind: 'PUBLISHED'; observation: PublicationObservation }
  | { kind: 'REVIEW_REQUIRED'; observation: PublicationObservation }
  | { kind: 'FALLBACK_TO_DRAFT' }

type WeixinPublicPageFetchResult =
  | {
      success: true
      canonicalUrl: string
      checkedUrl: string
      checkedPublicIdentityKey: string
      checkedAt: string
      httpStatus: number
      html: string
    }
  | {
      success: false
      errorCode: string
      errorMessage: string
    }

function mapWeixinPublicFetchError(
  errorCode: SafeNoRedirectFetchErrorCode,
): string {
  switch (errorCode) {
    case 'SAFE_FETCH_INITIAL_URL_INVALID':
      return 'WEIXIN_PUBLIC_CANDIDATE_URL_INVALID'
    case 'SAFE_FETCH_REQUEST_FAILED':
      return 'WEIXIN_PUBLIC_PAGE_FETCH_ERROR'
    case 'SAFE_FETCH_REDIRECT_REJECTED':
      return 'WEIXIN_PUBLIC_REDIRECT_NOT_ALLOWED'
    case 'SAFE_FETCH_RESPONSE_URL_INVALID':
      return 'WEIXIN_PUBLIC_RESPONSE_URL_INVALID'
  }
}

function mapWeixinBodyReadError(
  errorCode: BoundedResponseTextErrorCode,
): string {
  return errorCode === 'SAFE_RESPONSE_BODY_TOO_LARGE'
    ? 'WEIXIN_PUBLIC_BODY_TOO_LARGE'
    : 'WEIXIN_PUBLIC_BODY_READ_ERROR'
}

// 微信公众号的默认 CSS 样式
const WEIXIN_CSS = `
p {
  color: rgb(51, 51, 51);
  font-size: 15px;
  line-height: 1.75em;
  margin: 0 0 1em 0;
}
h1, h2, h3, h4, h5, h6 {
  font-weight: bold;
}
h1 { font-size: 1.25em; line-height: 1.4em; margin: 1em 0 0.5em 0; }
h2 { font-size: 1.125em; margin: 1em 0 0.5em 0; }
h3 { font-size: 1.05em; margin: 0.8em 0 0.4em 0; }
h4, h5, h6 { font-size: 1em; margin: 0.8em 0 0.4em 0; }
li p { margin: 0; }
ul, ol { margin: 1em 0; padding-left: 2em; }
li { margin-bottom: 0.4em; }
pre, tt, code, kbd, samp { font-family: monospace; }
pre { white-space: pre; margin: 1em 0; }
blockquote { border-left: 4px solid #ddd; padding-left: 1em; margin: 1em 0; color: #666; }
hr { border: none; border-top: 1px solid #ddd; margin: 1.5em 0; }
i, cite, em, var, address { font-style: italic; }
b, strong { font-weight: bolder; }
`

export class WeixinAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'weixin',
    name: '微信公众号',
    icon: 'https://mp.weixin.qq.com/favicon.ico',
    homepage: 'https://mp.weixin.qq.com',
    capabilities: ['article', 'draft', 'image_upload', 'account_binding'],
  }

  /** 预处理配置: 微信公众号使用 HTML 格式，移除非微信域名链接，压缩标签间空白避免 ProseMirror 产生空节点 */
  readonly preprocessConfig = {
    outputFormat: 'html' as const,
    removeLinks: true,
    keepLinkDomains: ['mp.weixin.qq.com', 'weixin.qq.com'],
    compactHtml: true,
  }

  private weixinMeta: WeixinMeta | null = null

  /** 微信公众号 API 需要的 Header 规则 */
  private readonly HEADER_RULES = [
    {
      urlFilter: '*://mp.weixin.qq.com/cgi-bin/*',
      headers: {
        Origin: 'https://mp.weixin.qq.com',
        Referer: 'https://mp.weixin.qq.com/',
      },
      resourceTypes: ['xmlhttprequest'],
    },
  ]

  private async fetchPublicArticlePage(
    candidateUrl: string,
    signal?: AbortSignal,
  ): Promise<WeixinPublicPageFetchResult> {
    signal?.throwIfAborted()
    const fetched = await fetchWithValidatedNoRedirects({
      fetch: (url, options) => this.runtime.fetch(url, options),
      initialUrl: candidateUrl,
      validateUrl: normalizeWeixinLongPublicArticleUrl,
      request: {
        method: 'GET',
        credentials: 'omit',
        cache: 'no-store',
        signal,
        headers: {
          Accept: 'text/html,application/xhtml+xml',
        },
      },
    })
    signal?.throwIfAborted()

    if (!fetched.success) {
      return {
        success: false,
        errorCode: mapWeixinPublicFetchError(fetched.errorCode),
        errorMessage:
          'The matched WeChat public article request could not be verified.',
      }
    }

    const { response } = fetched
    if (!response.ok) {
      await discardResponseBody(response)
      return {
        success: false,
        errorCode: 'WEIXIN_PUBLIC_PAGE_HTTP_ERROR',
        errorMessage:
          'The matched WeChat public article returned an unexpected HTTP status.',
      }
    }

    const resolution = validateWeixinPublicPageResponse(candidateUrl, {
      url: response.url,
      redirected: response.redirected,
      headers: response.headers,
    })
    if (!resolution.success) {
      await discardResponseBody(response)
      return {
        success: false,
        errorCode: resolution.errorCode,
        errorMessage:
          'The matched WeChat public article response could not be verified.',
      }
    }

    const body = await readBoundedResponseText(
      response,
      WEIXIN_PUBLIC_PAGE_MAX_BYTES,
    )
    signal?.throwIfAborted()
    if (!body.success) {
      return {
        success: false,
        errorCode: mapWeixinBodyReadError(body.errorCode),
        errorMessage:
          'The matched WeChat public article body could not be read safely.',
      }
    }

    const publicIdentity = derivePublicationPublicIdentity(
      'weixin',
      response.url,
    )
    if (!publicIdentity) {
      return {
        success: false,
        errorCode: 'WEIXIN_PUBLIC_IDENTITY_INVALID',
        errorMessage:
          'The matched WeChat public article did not expose a stable identity.',
      }
    }

    return {
      success: true,
      canonicalUrl: publicIdentity.canonicalUrl,
      checkedUrl: response.url,
      checkedPublicIdentityKey: publicIdentity.key,
      checkedAt: new Date().toISOString(),
      httpStatus: response.status,
      html: body.text,
    }
  }

  async checkAuth(context?: AdapterOperationContext): Promise<AuthResult> {
    const signal = context?.signal
    signal?.throwIfAborted()
    // Never retain an earlier token when a refresh fails or the user signs out.
    this.weixinMeta = null
    try {
      const response = await this.runtime.fetch('https://mp.weixin.qq.com/', {
        method: 'GET',
        credentials: 'include',
        signal,
      })

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }

      const html = await response.text()

      const tokenMatch = html.match(/data:\s*\{[\s\S]*?t:\s*["']([^"']+)["']/)
      if (!tokenMatch) {
        logger.debug(' No token found')
        return { isAuthenticated: false }
      }

      const ticketMatch = html.match(/ticket:\s*["']([^"']+)["']/)
      const userNameMatch = html.match(/user_name:\s*["']([^"']+)["']/)
      const nickNameMatch = html.match(/nick_name:\s*["']([^"']+)["']/)
      const timeMatch = html.match(/time:\s*["'](\d+)["']/)
      const headImgMatch = html.match(/head_img:\s*['"]([^'"]+)['"]/)

      const avatarMatch = html.match(
        /class="weui-desktop-account__thumb"[^>]*src="([^"]+)"/,
      )
      let avatar = avatarMatch
        ? avatarMatch[1]
        : headImgMatch
          ? headImgMatch[1]
          : ''
      if (avatar.startsWith('http://')) {
        avatar = avatar.replace('http://', 'https://')
      }

      this.weixinMeta = {
        token: tokenMatch[1],
        userName: userNameMatch ? userNameMatch[1] : '',
        nickName: nickNameMatch ? nickNameMatch[1] : '',
        ticket: ticketMatch ? ticketMatch[1] : '',
        svrTime: timeMatch ? Number(timeMatch[1]) : Date.now() / 1000,
        avatar,
      }

      logger.debug(' Auth info:', {
        userName: this.weixinMeta.userName,
        nickName: this.weixinMeta.nickName,
        hasToken: !!this.weixinMeta.token,
      })

      return {
        isAuthenticated: true,
        userId: this.weixinMeta.userName,
        username: this.weixinMeta.nickName,
        avatar: this.weixinMeta.avatar,
      }
    } catch (error) {
      signal?.throwIfAborted()
      logger.debug('checkAuth: not logged in -', error)
      return { isAuthenticated: false, error: (error as Error).message }
    }
  }

  async probeAccounts(
    context?: AdapterOperationContext,
  ): Promise<AdapterAccountProbe> {
    const auth = await this.checkAuth(context)
    if (!auth.isAuthenticated) {
      return auth.error
        ? {
            status: 'PROBE_FAILED',
            accounts: [],
            errorCode: 'UNKNOWN_ERROR',
          }
        : { status: 'NOT_AUTHENTICATED', accounts: [] }
    }

    const externalAccountId = normalizeAdapterExternalAccountId(auth.userId)
    if (!externalAccountId) {
      return {
        status: 'PROBE_FAILED',
        accounts: [],
        errorCode: 'ACCOUNT_ID_MISSING',
      }
    }

    const avatarUrl = normalizeAccountAvatarUrl(auth.avatar)
    return {
      status: 'AUTHENTICATED',
      accounts: [
        {
          externalAccountId,
          displayName: normalizeAccountDisplayName(
            auth.username,
            externalAccountId,
          ),
          ...(avatarUrl ? { avatarUrl } : {}),
        },
      ],
    }
  }

  private async inspectPublishedRecords(
    request: PublicationInspectRequest,
    appMsgId: string,
    token: string,
    signal?: AbortSignal,
  ): Promise<WeixinPublishedLookup> {
    signal?.throwIfAborted()
    for (let page = 0; page < WEIXIN_PUBLISHED_LIST_MAX_PAGES; page += 1) {
      const begin = page * WEIXIN_PUBLISHED_LIST_PAGE_SIZE
      let listResponse: Response
      try {
        listResponse = await this.runtime.fetch(
          buildWeixinPublishedListRequest(
            token,
            begin,
            WEIXIN_PUBLISHED_LIST_PAGE_SIZE,
          ),
          {
            method: 'GET',
            credentials: 'include',
            redirect: 'error',
            signal,
            headers: {
              Accept: 'application/json, text/javascript, */*; q=0.01',
              'X-Requested-With': 'XMLHttpRequest',
            },
          },
        )
      } catch {
        signal?.throwIfAborted()
        return this.createPublishedListReview(
          request,
          appMsgId,
          'WEIXIN_PUBLISHED_LIST_FETCH_ERROR',
          'The WeChat published-list request failed.',
        )
      }

      if (!listResponse.ok) {
        return this.createPublishedListReview(
          request,
          appMsgId,
          'WEIXIN_PUBLISHED_LIST_FETCH_ERROR',
          'The WeChat published-list request failed.',
        )
      }

      let listPayload: unknown
      try {
        listPayload = await listResponse.json()
      } catch {
        signal?.throwIfAborted()
        return this.createPublishedListReview(
          request,
          appMsgId,
          'WEIXIN_PUBLISHED_LIST_PARSE_ERROR',
          'The WeChat published-list response could not be parsed.',
        )
      }

      const lookup = parseWeixinPublishedListPayload(
        listPayload,
        appMsgId,
        begin,
        WEIXIN_PUBLISHED_LIST_PAGE_SIZE,
      )
      if (!lookup.success) {
        return this.createPublishedListReview(
          request,
          appMsgId,
          lookup.errorCode === 'WEIXIN_PUBLISHED_LIST_API_ERROR'
            ? 'WEIXIN_PUBLISHED_LIST_FETCH_ERROR'
            : 'WEIXIN_PUBLISHED_LIST_PARSE_ERROR',
          lookup.errorCode === 'WEIXIN_PUBLISHED_LIST_API_ERROR'
            ? 'The WeChat published-list request failed.'
            : 'The WeChat published-list response could not be parsed.',
        )
      }
      if (lookup.match === 'REVIEW_REQUIRED') {
        return this.createPublishedListReview(
          request,
          appMsgId,
          'WEIXIN_PUBLISHED_EVIDENCE_INCOMPLETE',
          'The WeChat published record matched this draft but did not contain complete publication evidence.',
        )
      }
      if (lookup.match === 'NOT_FOUND') {
        if (!lookup.hasMore) return { kind: 'FALLBACK_TO_DRAFT' }
        continue
      }

      const publicPage = await this.fetchPublicArticlePage(
        lookup.canonicalUrl,
        signal,
      )
      if (!publicPage.success) {
        return {
          kind: 'REVIEW_REQUIRED',
          observation: this.createInspectionError(
            request,
            'REVIEW_REQUIRED',
            publicPage.errorCode,
            publicPage.errorMessage,
            appMsgId,
            'PUBLIC_PAGE',
          ),
        }
      }

      const article = parseWeixinPublicArticleHtml(publicPage.html)
      if (!article.success) {
        return {
          kind: 'REVIEW_REQUIRED',
          observation: this.createInspectionError(
            request,
            'REVIEW_REQUIRED',
            'WEIXIN_PUBLIC_PAGE_CONTENT_INVALID',
            'The matched WeChat public article could not be verified.',
            appMsgId,
            'PUBLIC_PAGE',
          ),
        }
      }

      return {
        kind: 'PUBLISHED',
        observation: PublicationInspectionObservationSchema.parse({
          observationKey: `weixin:${request.requestId}:public-page`,
          platform: 'weixin',
          externalAccountId: request.externalAccountId,
          outcome: 'PUBLISHED',
          source: 'PUBLIC_PAGE',
          platformPostId: appMsgId,
          canonicalUrl: publicPage.canonicalUrl,
          title: article.title,
          publishedAt: lookup.publishedAt,
          bodyText: article.bodyText,
          bodyTruncated: article.bodyTruncated,
          publicAccess: {
            status: 'CONFIRMED',
            checkedUrl: publicPage.checkedUrl,
            checkedPublicIdentityKey: publicPage.checkedPublicIdentityKey,
            checkedAt: publicPage.checkedAt,
            httpStatus: publicPage.httpStatus,
          },
          observedAt: new Date().toISOString(),
        }),
      }
    }

    return this.createPublishedListReview(
      request,
      appMsgId,
      'WEIXIN_PUBLISHED_SCAN_INCOMPLETE',
      'The WeChat published-list scan reached its page limit before all records were checked.',
    )
  }

  async inspectPublication(
    request: PublicationInspectRequest,
    context?: AdapterOperationContext,
  ): Promise<PublicationObservation[]> {
    const signal = context?.signal
    signal?.throwIfAborted()
    if (request.platform !== 'weixin') {
      return [
        this.createInspectionError(
          request,
          'UNSUPPORTED',
          'WEIXIN_PLATFORM_REQUIRED',
          'This inspector only supports WeChat Official Accounts.',
        ),
      ]
    }

    // Resolve the stable identity before touching the authenticated session.
    const resolvedId = resolveWeixinAppMsgId(
      request.draft.platformPostId,
      request.draft.draftUrl,
    )
    if (!resolvedId.success) {
      const explicitAppMsgId = normalizeWeixinAppMsgId(
        request.draft.platformPostId,
      )
      return [
        this.createInspectionError(
          request,
          resolvedId.outcome,
          resolvedId.errorCode,
          resolvedId.errorMessage,
          explicitAppMsgId ?? undefined,
        ),
      ]
    }
    const appMsgId = resolvedId.appMsgId

    // Always refresh the session. Inspection must never reuse the token left by
    // publish(), a prior auth check, or an earlier inspection.
    const auth = await this.checkAuth(context)
    if (!auth.isAuthenticated) {
      return [
        this.createInspectionError(
          request,
          auth.error ? 'FETCH_ERROR' : 'LOGIN_REQUIRED',
          auth.error ? 'WEIXIN_AUTH_FETCH_ERROR' : 'WEIXIN_LOGIN_REQUIRED',
          auth.error
            ? 'The WeChat authentication check failed.'
            : 'Log in to WeChat Official Accounts before inspecting this draft.',
          appMsgId,
        ),
      ]
    }

    if (!auth.userId || !this.weixinMeta?.token) {
      return [
        this.createInspectionError(
          request,
          'PARSE_ERROR',
          'WEIXIN_AUTH_RESPONSE_INVALID',
          'The WeChat authentication response is missing stable account data.',
          appMsgId,
        ),
      ]
    }

    if (auth.userId !== request.externalAccountId) {
      return [
        this.createInspectionError(
          request,
          'ACCOUNT_MISMATCH',
          'WEIXIN_ACCOUNT_MISMATCH',
          'The active WeChat account does not match the bound account.',
          appMsgId,
        ),
      ]
    }

    const token = this.weixinMeta.token

    try {
      return await this.withHeaderRules(this.HEADER_RULES, async () => {
        const publishedLookup = await this.inspectPublishedRecords(
          request,
          appMsgId,
          token,
          signal,
        )
        if (publishedLookup.kind !== 'FALLBACK_TO_DRAFT') {
          return [publishedLookup.observation]
        }

        let detailResponse: Response
        try {
          detailResponse = await this.runtime.fetch(
            buildWeixinTempUrlRequest(appMsgId, token),
            {
              method: 'GET',
              credentials: 'include',
              redirect: 'error',
              signal,
            },
          )
        } catch {
          signal?.throwIfAborted()
          return [
            this.createInspectionError(
              request,
              'FETCH_ERROR',
              'WEIXIN_DRAFT_DETAIL_FETCH_ERROR',
              'The WeChat draft-detail request failed.',
              appMsgId,
            ),
          ]
        }

        if (!detailResponse.ok) {
          return [
            this.createInspectionError(
              request,
              'FETCH_ERROR',
              'WEIXIN_DRAFT_DETAIL_HTTP_ERROR',
              `The WeChat draft-detail request returned HTTP ${detailResponse.status}.`,
              appMsgId,
            ),
          ]
        }

        let detailPayload: unknown
        try {
          detailPayload = await detailResponse.json()
        } catch {
          signal?.throwIfAborted()
          return [
            this.createInspectionError(
              request,
              'PARSE_ERROR',
              'WEIXIN_DRAFT_DETAIL_JSON_INVALID',
              'The WeChat draft-detail response is not valid JSON.',
              appMsgId,
            ),
          ]
        }

        const parsedPayload = parseWeixinTempUrlPayload(detailPayload)
        if (!parsedPayload.success) {
          return [
            this.createInspectionError(
              request,
              parsedPayload.outcome,
              parsedPayload.errorCode,
              parsedPayload.errorMessage,
              appMsgId,
            ),
          ]
        }

        const resolvedTempUrl = resolveWeixinTempUrl(parsedPayload.tempUrl)
        if (!resolvedTempUrl.success) {
          return [
            this.createInspectionError(
              request,
              'PARSE_ERROR',
              resolvedTempUrl.errorCode,
              'The WeChat draft-detail response returned a temporary URL with an unsupported shape.',
              appMsgId,
            ),
          ]
        }

        let pageResponse: Response
        try {
          pageResponse = await this.runtime.fetch(resolvedTempUrl.url, {
            method: 'GET',
            credentials: 'include',
            redirect: 'error',
            signal,
          })
        } catch {
          signal?.throwIfAborted()
          return [
            this.createInspectionError(
              request,
              'FETCH_ERROR',
              'WEIXIN_TEMP_PAGE_FETCH_ERROR',
              'The WeChat temporary page request failed.',
              appMsgId,
            ),
          ]
        }

        if (!pageResponse.ok) {
          return [
            this.createInspectionError(
              request,
              'FETCH_ERROR',
              'WEIXIN_TEMP_PAGE_HTTP_ERROR',
              `The WeChat temporary page returned HTTP ${pageResponse.status}.`,
              appMsgId,
            ),
          ]
        }

        let pageHtml: string
        try {
          pageHtml = await pageResponse.text()
        } catch {
          signal?.throwIfAborted()
          return [
            this.createInspectionError(
              request,
              'FETCH_ERROR',
              'WEIXIN_TEMP_PAGE_READ_ERROR',
              'The WeChat temporary page could not be read.',
              appMsgId,
            ),
          ]
        }

        const parsedPage = parseWeixinDraftHtml(pageHtml)
        if (!parsedPage.success) {
          return [
            this.createInspectionError(
              request,
              'REVIEW_REQUIRED',
              'WEIXIN_DRAFT_STATE_REVIEW_REQUIRED',
              'The WeChat draft preview is no longer readable; confirm its publication state manually.',
              appMsgId,
            ),
          ]
        }

        return [
          PublicationInspectionObservationSchema.parse({
            observationKey: `weixin:${request.requestId}:draft-detail`,
            platform: 'weixin',
            externalAccountId: request.externalAccountId,
            outcome: 'DRAFT_PRESENT',
            source: 'DRAFT_DETAIL',
            platformPostId: appMsgId,
            title: parsedPage.title,
            bodyText: parsedPage.bodyText,
            bodyTruncated: parsedPage.bodyTruncated,
            observedAt: new Date().toISOString(),
          }),
        ]
      })
    } catch {
      signal?.throwIfAborted()
      return [
        this.createInspectionError(
          request,
          'FETCH_ERROR',
          'WEIXIN_INSPECTION_RUNTIME_ERROR',
          'The WeChat draft inspection could not complete.',
          appMsgId,
        ),
      ]
    }
  }

  provePublishedObservation(
    request: PublicationInspectRequest,
    observation: PublicationObservation,
  ): PublicationPublishedProof | null {
    const appMsgIdResolution = resolveWeixinAppMsgId(
      request.draft.platformPostId,
      request.draft.draftUrl,
    )
    const normalizedCanonicalUrl = observation.canonicalUrl
      ? normalizeWeixinLongPublicArticleUrl(observation.canonicalUrl)
      : null
    if (
      request.platform !== 'weixin' ||
      observation.platform !== 'weixin' ||
      observation.externalAccountId !== request.externalAccountId ||
      observation.outcome !== 'PUBLISHED' ||
      observation.source !== 'PUBLIC_PAGE' ||
      !appMsgIdResolution.success ||
      !observation.platformPostId ||
      observation.platformPostId !== appMsgIdResolution.appMsgId ||
      !observation.canonicalUrl ||
      normalizedCanonicalUrl !== observation.canonicalUrl ||
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

    // The inspector binds the active account and exact appMsgId before it
    // accepts the anonymous public page as publication evidence.
    return {
      observedAuthorExternalAccountId: observation.externalAccountId,
      publicAccess: observation.publicAccess,
      bodyTruncated: observation.bodyTruncated,
    }
  }

  private createInspectionError(
    request: PublicationInspectRequest,
    outcome:
      | 'ACCOUNT_MISMATCH'
      | 'LOGIN_REQUIRED'
      | 'UNSUPPORTED'
      | 'FETCH_ERROR'
      | 'PARSE_ERROR'
      | 'REVIEW_REQUIRED',
    errorCode: string,
    errorMessage: string,
    platformPostId?: string,
    source: PublicationObservation['source'] = 'DRAFT_DETAIL',
  ): PublicationObservation {
    const observationSource =
      source === 'DRAFT_DETAIL'
        ? 'draft-detail'
        : source.toLowerCase().replace(/_/g, '-')
    return PublicationInspectionObservationSchema.parse({
      observationKey: `weixin:${request.requestId}:${observationSource}`,
      platform: 'weixin',
      externalAccountId: request.externalAccountId,
      outcome,
      source,
      ...(platformPostId ? { platformPostId } : {}),
      observedAt: new Date().toISOString(),
      errorCode,
      errorMessage,
    })
  }

  private createPublishedListReview(
    request: PublicationInspectRequest,
    appMsgId: string,
    errorCode: string,
    errorMessage: string,
  ): WeixinPublishedLookup {
    return {
      kind: 'REVIEW_REQUIRED',
      observation: this.createInspectionError(
        request,
        'REVIEW_REQUIRED',
        errorCode,
        errorMessage,
        appMsgId,
        'PUBLISHED_LIST',
      ),
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
    let operationExternalAccountId = requestedBinding?.externalAccountId

    return this.withHeaderRules(this.HEADER_RULES, async () => {
      logger.info('Starting publish...')

      const selection = resolveAdapterAccountBinding(
        await this.probeAccounts(),
        options?.accountBinding,
      )
      if (!selection.ok) {
        return this.createResult(false, {
          ...(operationExternalAccountId
            ? { externalAccountId: operationExternalAccountId }
            : {}),
          errorCode: selection.errorCode,
          error: adapterAccountSelectionErrorMessage(selection.errorCode),
        })
      }
      operationExternalAccountId = selection.account.externalAccountId

      await options?.beforeDispatch?.()

      // 微信到微信：使用原始 HTML，跳过所有处理
      let content =
        article.source?.platform === 'weixin' && (article as any).rawHtml
          ? (article as any).rawHtml
          : article.html || ''

      if (article.source?.platform === 'weixin') {
        logger.info(
          'Source is WeChat, using raw HTML, skipping content processing',
        )
      } else {
        content = this.processLatex(content)
        content = this.stripExternalLinks(content)
        content = await this.processImages(
          content,
          (src) => this.uploadImageByUrl(src),
          {
            skipPatterns: ['mmbiz.qpic.cn', 'mmbiz.qlogo.cn'],
            onProgress: options?.onImageProgress,
          },
        )
        content = this.processContent(content)
      }

      const formData = new URLSearchParams({
        token: this.weixinMeta!.token,
        lang: 'zh_CN',
        f: 'json',
        ajax: '1',
        random: String(Math.random()),
        AppMsgId: '',
        count: '1',
        data_seq: '0',
        operate_from: 'Chrome',
        isnew: '0',
        ad_video_transition0: '',
        can_reward0: '0',
        related_video0: '',
        is_video_recommend0: '-1',
        title0: article.title,
        author0: '',
        writerid0: '0',
        fileid0: '',
        digest0: '',
        auto_gen_digest0: '1',
        content0: content,
        sourceurl0: '',
        need_open_comment0: '1',
        only_fans_can_comment0: '0',
        cdn_url0: '',
        cdn_235_1_url0: '',
        cdn_1_1_url0: '',
        cdn_url_back0: '',
        crop_list0: '',
        music_id0: '',
        video_id0: '',
        voteid0: '',
        voteismlt0: '',
        supervoteid0: '',
        cardid0: '',
        cardquantity0: '',
        cardlimit0: '',
        vid_type0: '',
        show_cover_pic0: '0',
        shortvideofileid0: '',
        copyright_type0: '0',
        releasefirst0: '',
        platform0: '',
        reprint_permit_type0: '',
        allow_reprint0: '',
        allow_reprint_modify0: '',
        original_article_type0: '',
        ori_white_list0: '',
        free_content0: '',
        fee0: '0',
        ad_id0: '',
        guide_words0: '',
        is_share_copyright0: '0',
        share_copyright_url0: '',
        source_article_type0: '',
        reprint_recommend_title0: '',
        reprint_recommend_content0: '',
        share_page_type0: '0',
        share_imageinfo0: '{"list":[]}',
        share_video_id0: '',
        dot0: '{}',
        share_voice_id0: '',
        insert_ad_mode0: '',
        categories_list0: '[]',
      })

      const response = await this.runtime.fetch(
        `https://mp.weixin.qq.com/cgi-bin/operate_appmsg?t=ajax-response&sub=create&type=77&token=${this.weixinMeta!.token}&lang=zh_CN`,
        {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: formData,
        },
      )

      const res = (await response.json()) as {
        appMsgId?: string | number
        ret?: number
        base_resp?: { ret: number; err_msg?: string }
      }

      logger.debug(' Save response:', res)

      const appMsgId = normalizeWeixinAppMsgId(res.appMsgId)
      const responseCode = res.ret ?? res.base_resp?.ret
      if (
        !appMsgId &&
        typeof res.appMsgId === 'undefined' &&
        typeof responseCode === 'number' &&
        responseCode !== 0
      ) {
        const errMsg = this.formatError(res)
        throw new Error(errMsg)
      }

      if (!appMsgId) {
        throw new Error('保存失败: 响应中的 appMsgId 无效')
      }
      const draftUrl = `https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit&action=edit&type=77&appmsgid=${appMsgId}&token=${this.weixinMeta!.token}&lang=zh_CN`

      return this.createResult(true, {
        postId: appMsgId,
        postUrl: draftUrl,
        externalAccountId: operationExternalAccountId,
        draftOnly: options?.draftOnly ?? true,
      })
    }).catch((error) =>
      this.createResult(false, {
        ...(operationExternalAccountId
          ? { externalAccountId: operationExternalAccountId }
          : {}),
        error: (error as Error).message,
      }),
    )
  }

  async openPublicationDraft(
    request: OpenPublicationDraftRequest,
    context?: AdapterOperationContext,
  ): Promise<OpenPublicationDraftResult> {
    context?.signal?.throwIfAborted()
    if (
      request.platform !== 'weixin' ||
      !this.weixinMeta ||
      this.weixinMeta.userName !== request.externalAccountId
    ) {
      throw new Error('ACCOUNT_MISMATCH')
    }

    const appMsgId = normalizeWeixinAppMsgId(request.platformPostId)
    if (!appMsgId || appMsgId !== request.platformPostId) {
      throw new Error('INVALID_DRAFT_POST_ID')
    }
    if (!this.runtime.tabs) {
      throw new Error('PUBLICATION_DRAFT_OPEN_NOT_SUPPORTED')
    }

    const draftUrl = new URL('/cgi-bin/appmsg', 'https://mp.weixin.qq.com')
    draftUrl.search = new URLSearchParams({
      t: 'media/appmsg_edit',
      action: 'edit',
      type: '77',
      appmsgid: appMsgId,
      token: this.weixinMeta.token,
      lang: 'zh_CN',
    }).toString()

    try {
      context?.signal?.throwIfAborted()
      const createdTab = await this.runtime.tabs.create(draftUrl.href, true)
      if (context?.signal?.aborted) {
        try {
          await this.runtime.tabs.remove?.(createdTab.id)
        } catch {
          // The operation was already cancelled. Do not expose a Chrome
          // exception that may contain the token-bearing target URL.
        }
      }
      context?.signal?.throwIfAborted()
    } catch {
      context?.signal?.throwIfAborted()
      // A Chrome error may embed the target URL. Never let it cross the bridge.
      throw new Error('PUBLICATION_DRAFT_OPEN_FAILED')
    }

    return { opened: true }
  }

  protected async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    if (!this.weixinMeta) {
      throw new Error('未登录')
    }

    const imageResponse = await fetch(src)
    if (!imageResponse.ok) {
      throw new Error('图片下载失败: ' + src)
    }
    const imageBlob = await imageResponse.blob()

    const formData = new FormData()
    const timestamp = Date.now()
    const fileName = `${timestamp}.jpg`

    formData.append('type', imageBlob.type || 'image/jpeg')
    formData.append('id', String(timestamp))
    formData.append('name', fileName)
    formData.append('lastModifiedDate', new Date().toString())
    formData.append('size', String(imageBlob.size))
    formData.append('file', imageBlob, fileName)

    const { token, userName, ticket, svrTime } = this.weixinMeta
    const seq = Date.now()

    const response = await this.runtime.fetch(
      `https://mp.weixin.qq.com/cgi-bin/filetransfer?action=upload_material&f=json&scene=8&writetype=doublewrite&groupid=1&ticket_id=${userName}&ticket=${ticket}&svr_time=${svrTime}&token=${token}&lang=zh_CN&seq=${seq}&t=${Math.random()}`,
      {
        method: 'POST',
        credentials: 'include',
        body: formData,
      },
    )

    const res = (await response.json()) as {
      cdn_url?: string
      content?: string
      base_resp?: { err_msg: string; ret: number }
    }

    logger.debug(' Image upload response:', res)

    if (res.base_resp?.err_msg !== 'ok' || !res.cdn_url) {
      throw new Error('图片上传失败: ' + src)
    }

    return {
      url: res.cdn_url,
    }
  }

  private isLatexFormula(text: string): boolean {
    if (/[\\^_{}]/.test(text)) return true
    if (/[α-ωΑ-Ω]/.test(text)) return true
    if (/[∑∏∫∂∇∞≠≤≥±×÷√]/.test(text)) return true
    return false
  }

  private processLatex(content: string): string {
    const LATEX_API = 'https://latex.codecogs.com/png.latex'

    content = content.replace(/\$\$([^$]+)\$\$/g, (match, latex) => {
      if (!this.isLatexFormula(latex)) return match
      const encoded = encodeURIComponent(latex.trim())
      return `<p style="text-align: center;"><img src="${LATEX_API}?\\dpi{150}${encoded}" alt="formula" style="vertical-align: middle; max-width: 100%;"></p>`
    })

    content = content.replace(/\$([^$]+)\$/g, (match, latex) => {
      if (!this.isLatexFormula(latex)) return match
      const encoded = encodeURIComponent(latex.trim())
      return `<img src="${LATEX_API}?\\dpi{120}${encoded}" alt="formula" style="vertical-align: middle;">`
    })

    return content
  }

  private processContent(content: string): string {
    const wrapped = `<section style="margin-left: 6px; margin-right: 6px; line-height: 1.75em;">${content}</section>`
    return juice.inlineContent(wrapped, WEIXIN_CSS)
  }

  /**
   * 移除外部链接（微信不允许非 mp.weixin.qq.com 域名的链接）
   * 将 <a href="外部链接">文字</a> 转换为 文字
   */
  private stripExternalLinks(content: string): string {
    // 匹配 <a> 标签，保留微信域名的链接
    return content.replace(
      /<a\s+[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi,
      (match, href, text) => {
        // 保留微信域名的链接
        if (
          href &&
          (href.includes('mp.weixin.qq.com') ||
            href.includes('weixin.qq.com') ||
            href.startsWith('#') || // 锚点链接
            href.startsWith('javascript:')) // JS 链接
        ) {
          return match
        }
        // 外部链接只保留文字
        return text
      },
    )
  }

  private formatError(res: {
    ret?: number
    base_resp?: { ret: number }
  }): string {
    const ret = res.ret ?? res.base_resp?.ret

    const errorMap: Record<number, string> = {
      [-6]: '请输入验证码',
      [-8]: '请输入验证码',
      [-1]: '系统错误，请注意备份内容后重试',
      [-2]: '参数错误，请注意备份内容后重试',
      [-5]: '服务错误，请注意备份内容后重试',
      [-99]: '内容超出字数，请调整',
      [-206]: '服务负荷过大，请稍后重试',
      [200002]: '参数错误，请注意备份内容后重试',
      [200003]: '登录态超时，请重新登录',
      [412]: '图文中含非法外链',
      [62752]: '可能含有具备安全风险的链接，请检查',
      [64502]: '你输入的微信号不存在',
      [64505]: '发送预览失败，请稍后再试',
      [64506]: '保存失败，链接不合法',
      [64507]: '内容不能包含外部链接',
      [64562]: '请勿插入非微信域名的链接',
      [64509]: '正文中不能包含超过3个视频',
      [64515]: '当前素材非最新内容，请重新打开并编辑',
      [64702]: '标题超出64字长度限制',
      [64703]: '摘要超出120字长度限制',
      [64705]: '内容超出字数，请调整',
      [10806]: '正文不能有违规内容，请重新编辑',
      [10807]: '内容不能违反公众平台协议',
      [220001]: '素材管理中的存储数量已达上限',
      [220002]: '图片库已达到存储上限',
    }

    return errorMap[ret as number] || `同步失败 (错误码: ${ret})`
  }
}
