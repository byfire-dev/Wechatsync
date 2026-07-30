import { parseHTML } from 'linkedom'

import { WEIXIN_APP_MSG_ID_MAX_LENGTH } from './types'
import { parsePublicationUrl } from './url'

export const WEIXIN_DRAFT_BODY_TEXT_LIMIT = 50_000
export const WEIXIN_PUBLISHED_LIST_PAGE_SIZE = 10
export const WEIXIN_PUBLISHED_LIST_MAX_PAGES = 5
export const WEIXIN_PUBLIC_PAGE_MAX_BYTES = 2 * 1024 * 1024
export const WEIXIN_PUBLIC_PAGE_MAX_REDIRECTS = 0

export type WeixinAppMsgIdResolution =
  | { success: true; appMsgId: string }
  | {
      success: false
      outcome: 'UNSUPPORTED' | 'PARSE_ERROR'
      errorCode: string
      errorMessage: string
    }

export type WeixinTempUrlPayloadResult =
  | { success: true; tempUrl: string }
  | {
      success: false
      outcome: 'LOGIN_REQUIRED' | 'FETCH_ERROR' | 'PARSE_ERROR'
      errorCode: string
      errorMessage: string
    }

export type WeixinDraftHtmlResult =
  | {
      success: true
      title: string
      bodyText: string
      bodyTruncated: boolean
    }
  | {
      success: false
      errorCode: 'WEIXIN_DRAFT_HTML_INVALID'
      errorMessage: string
    }

export type WeixinPublishedListLookupResult =
  | {
      success: true
      match: 'PUBLISHED'
      canonicalUrl: string
      publishedAt: string
    }
  | {
      success: true
      match: 'REVIEW_REQUIRED'
    }
  | {
      success: true
      match: 'NOT_FOUND'
      hasMore: boolean
    }
  | {
      success: false
      errorCode:
        | 'WEIXIN_PUBLISHED_LIST_RESPONSE_INVALID'
        | 'WEIXIN_PUBLISHED_LIST_API_ERROR'
    }

export type WeixinPublicPageResponseErrorCode =
  | 'WEIXIN_PUBLIC_CANDIDATE_URL_INVALID'
  | 'WEIXIN_PUBLIC_RESPONSE_URL_INVALID'
  | 'WEIXIN_PUBLIC_RESPONSE_IDENTITY_MISMATCH'
  | 'WEIXIN_PUBLIC_REDIRECT_NOT_ALLOWED'
  | 'WEIXIN_PUBLIC_UNEXPECTED_CONTENT_TYPE'

export type WeixinPublicPageResponseResolution =
  | {
      success: true
      canonicalUrl: string
    }
  | {
      success: false
      errorCode: WeixinPublicPageResponseErrorCode
    }

type WeixinPublicArticleIdentity =
  | {
      kind: 'LONG'
      accountId: string
      publicMid: string
      itemIndex: string
      canonicalUrl: string
    }
  | {
      kind: 'SHORT'
      slug: string
      canonicalUrl: string
    }

export type WeixinTempUrlShape =
  | 'SAFE_ABSOLUTE_HTTPS'
  | 'SAFE_HTTP_UPGRADED'
  | 'PROTOCOL_RELATIVE'
  | 'PATH_RELATIVE'
  | 'HOST_MISMATCH'
  | 'PATH_MISMATCH'
  | 'PORT_OR_USERINFO'
  | 'INVALID_OR_OTHER_SCHEME'

export type WeixinTempUrlClassification =
  | {
      success: true
      shape: 'SAFE_ABSOLUTE_HTTPS' | 'SAFE_HTTP_UPGRADED'
    }
  | {
      success: false
      shape: Exclude<
        WeixinTempUrlShape,
        'SAFE_ABSOLUTE_HTTPS' | 'SAFE_HTTP_UPGRADED'
      >
      errorCode:
        | 'WEIXIN_TEMP_URL_PROTOCOL_RELATIVE'
        | 'WEIXIN_TEMP_URL_PATH_RELATIVE'
        | 'WEIXIN_TEMP_URL_HOST_MISMATCH'
        | 'WEIXIN_TEMP_URL_PATH_MISMATCH'
        | 'WEIXIN_TEMP_URL_PORT_OR_USERINFO'
        | 'WEIXIN_TEMP_URL_INVALID_OR_OTHER_SCHEME'
    }

export type WeixinTempUrlResolution =
  | (Extract<WeixinTempUrlClassification, { success: true }> & {
      url: string
    })
  | Extract<WeixinTempUrlClassification, { success: false }>

interface HtmlNodeLike {
  nodeType: number
  nodeValue?: string | null
  tagName?: string
  childNodes?: ArrayLike<HtmlNodeLike>
}

const BLOCK_TAGS = new Set([
  'ADDRESS',
  'ARTICLE',
  'ASIDE',
  'BLOCKQUOTE',
  'DIV',
  'DL',
  'FIGCAPTION',
  'FIGURE',
  'FOOTER',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'HEADER',
  'HR',
  'LI',
  'MAIN',
  'OL',
  'P',
  'PRE',
  'SECTION',
  'TABLE',
  'TR',
  'UL',
])

const SKIPPED_TAGS = new Set(['NOSCRIPT', 'SCRIPT', 'STYLE', 'TEMPLATE'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  return normalized.length > 0 ? normalized : undefined
}

function nonNegativeInteger(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined
  }
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) {
    return undefined
  }
  const parsed = Number(value.trim())
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

function parseRecordOrJson(value: unknown): Record<string, unknown> | null {
  if (isRecord(value)) return value
  if (typeof value !== 'string' || value.length > 2_000_000) return null
  try {
    const parsed: unknown = JSON.parse(value)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function parseUnixTime(value: unknown): string | undefined {
  const timestamp = nonNegativeInteger(value)
  if (!timestamp) return undefined
  const milliseconds =
    timestamp < 1_000_000_000_000 ? timestamp * 1_000 : timestamp
  if (
    milliseconds < Date.UTC(2000, 0, 1) ||
    milliseconds >= Date.UTC(2100, 0, 1)
  ) {
    return undefined
  }
  const date = new Date(milliseconds)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

function exactAppMsgId(value: unknown, appMsgId: string): boolean {
  return normalizeWeixinAppMsgId(value) === appMsgId
}

function firstRecord(
  records: Array<Record<string, unknown> | null>,
): Record<string, unknown> | null {
  return (
    records.find((record): record is Record<string, unknown> =>
      Boolean(record),
    ) ?? null
  )
}

function firstPublishedAt(values: unknown[]): string | undefined {
  for (const value of values) {
    const publishedAt = parseUnixTime(value)
    if (publishedAt) return publishedAt
  }
  return undefined
}

function parseSentInfo(
  containers: Array<Record<string, unknown>>,
): Record<string, unknown> | null {
  return firstRecord(
    containers.map((container) => parseRecordOrJson(container.sent_info)),
  )
}

function parseSentResult(
  containers: Array<Record<string, unknown>>,
): Record<string, unknown> | null {
  return firstRecord(
    containers.map((container) => parseRecordOrJson(container.sent_result)),
  )
}

const WEIXIN_ARTICLE_ARRAY_FIELDS = [
  'appmsgex',
  'appmsg_info',
  'appMsg_info',
  'appmsgInfo',
] as const

/**
 * Platform variants place the article rows at one of three verified levels:
 * parsed publish_info, its nested publish_info metadata, or the list item.
 * Do not recursively scan arbitrary descendants because forwarded/reference
 * metadata can contain unrelated IDs and links.
 */
function collectArticleItems(
  containers: Array<Record<string, unknown>>,
): Record<string, unknown>[] {
  for (const container of containers) {
    for (const field of WEIXIN_ARTICLE_ARRAY_FIELDS) {
      const items = container[field]
      if (!Array.isArray(items) || items.length === 0) continue
      return items.filter(
        (item): item is Record<string, unknown> =>
          isRecord(item) && nonNegativeInteger(item.itemidx) === 1,
      )
    }
  }
  return []
}

function resolveLongPublicArticleUrl(
  articleItem: Record<string, unknown>,
): string | undefined {
  for (const field of ['content_url', 'url', 'link']) {
    const candidate = nonEmptyString(articleItem[field])
    if (!candidate) continue
    let trustedCandidate: string
    try {
      const url = new URL(candidate.replace(/&amp;/g, '&'))
      if (
        (url.protocol !== 'http:' && url.protocol !== 'https:') ||
        url.hostname.toLowerCase() !== 'mp.weixin.qq.com' ||
        url.port !== '' ||
        url.username !== '' ||
        url.password !== '' ||
        (url.pathname !== '/s' && !url.pathname.startsWith('/s/'))
      ) {
        continue
      }
      if (url.protocol === 'http:') url.protocol = 'https:'
      trustedCandidate = url.href
    } catch {
      continue
    }
    const normalized = normalizeWeixinLongPublicArticleUrl(trustedCandidate)
    if (normalized) return normalized
  }
  return undefined
}

function parseWeixinPublicArticleIdentity(
  value: string,
): WeixinPublicArticleIdentity | null {
  try {
    const url = new URL(value)
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'mp.weixin.qq.com' ||
      url.port !== '' ||
      url.username !== '' ||
      url.password !== ''
    ) {
      return null
    }

    const parsed = parsePublicationUrl('weixin', url.href)
    if (parsed?.surface !== 'PUBLISHED' || !parsed.canonicalUrl) {
      return null
    }

    const canonical = new URL(parsed.canonicalUrl)
    if (canonical.pathname === '/s') {
      const accountId = parsed.accountId
      const publicMid = parsed.postId
      const itemIndex = canonical.searchParams.get('idx')
      if (!accountId || !publicMid || !itemIndex) return null
      return {
        kind: 'LONG',
        accountId,
        publicMid,
        itemIndex,
        canonicalUrl: parsed.canonicalUrl,
      }
    }

    const shortLinkMatch = canonical.pathname.match(
      /^\/s\/([A-Za-z0-9_-]{8,128})$/,
    )
    if (!shortLinkMatch) return null
    return {
      kind: 'SHORT',
      slug: shortLinkMatch[1],
      canonicalUrl: parsed.canonicalUrl,
    }
  } catch {
    return null
  }
}

/**
 * Normalize only anonymous WeChat article URLs that are safe request targets.
 *
 * This is intentionally stricter than a host allowlist: every network hop
 * must also retain a verified public-article path and identity shape.
 */
export function normalizeWeixinPublicArticleUrl(value: string): string | null {
  return parseWeixinPublicArticleIdentity(value)?.canonicalUrl ?? null
}

/**
 * Normalize a public URL only when the platform returned its complete identity.
 *
 * Short links cannot be resolved safely in an MV3 service worker: Fetch's
 * manual redirect response hides Location, while automatic following would
 * send the next request before application code validates it.
 */
export function normalizeWeixinLongPublicArticleUrl(
  value: string,
): string | null {
  const identity = parseWeixinPublicArticleIdentity(value)
  return identity?.kind === 'LONG' ? identity.canonicalUrl : null
}

function sameWeixinPublicArticleIdentity(
  left: WeixinPublicArticleIdentity,
  right: WeixinPublicArticleIdentity,
): boolean {
  if (left.kind !== right.kind) return false
  if (left.kind === 'SHORT' && right.kind === 'SHORT') {
    return left.slug === right.slug
  }
  if (left.kind === 'LONG' && right.kind === 'LONG') {
    return (
      left.accountId === right.accountId &&
      left.publicMid === right.publicMid &&
      left.itemIndex === right.itemIndex
    )
  }
  return false
}

function weixinPublicContentTypeIsHtml(headers: Headers): boolean {
  try {
    const contentType = headers.get('content-type')
    if (!contentType) return false
    const mediaType = contentType.split(';', 1)[0]?.trim().toLowerCase()
    return mediaType === 'text/html' || mediaType === 'application/xhtml+xml'
  } catch {
    return false
  }
}

/**
 * Validate the final anonymous public-page response before its body is read.
 *
 * Public-page inspection accepts only the complete long identity returned by
 * the authenticated published-list API. Any redirect or response URL change is
 * rejected before the body is read.
 */
export function validateWeixinPublicPageResponse(
  candidateUrl: string,
  response: Pick<Response, 'url' | 'redirected' | 'headers'>,
): WeixinPublicPageResponseResolution {
  const candidate = parseWeixinPublicArticleIdentity(candidateUrl)
  if (candidate?.kind !== 'LONG') {
    return {
      success: false,
      errorCode: 'WEIXIN_PUBLIC_CANDIDATE_URL_INVALID',
    }
  }

  const observed = parseWeixinPublicArticleIdentity(response.url)
  if (!observed) {
    return {
      success: false,
      errorCode: 'WEIXIN_PUBLIC_RESPONSE_URL_INVALID',
    }
  }

  if (response.redirected) {
    return {
      success: false,
      errorCode: 'WEIXIN_PUBLIC_REDIRECT_NOT_ALLOWED',
    }
  }

  if (
    observed.kind !== 'LONG' ||
    !sameWeixinPublicArticleIdentity(candidate, observed) ||
    candidate.canonicalUrl !== observed.canonicalUrl
  ) {
    return {
      success: false,
      errorCode: 'WEIXIN_PUBLIC_RESPONSE_IDENTITY_MISMATCH',
    }
  }

  if (!weixinPublicContentTypeIsHtml(response.headers)) {
    return {
      success: false,
      errorCode: 'WEIXIN_PUBLIC_UNEXPECTED_CONTENT_TYPE',
    }
  }

  return {
    success: true,
    canonicalUrl: observed.canonicalUrl,
  }
}

export function normalizeWeixinAppMsgId(value: unknown): string | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? String(value) : null
  }
  if (typeof value !== 'string') return null

  const normalized = value.trim()
  if (
    normalized.length > WEIXIN_APP_MSG_ID_MAX_LENGTH ||
    !/^\d+$/.test(normalized)
  ) {
    return null
  }

  const canonical = normalized.replace(/^0+/, '')
  return canonical || null
}

function parseStrictDraftUrl(value: string): string | undefined {
  const parsed = parsePublicationUrl('weixin', value)
  return parsed?.surface === 'DRAFT' ? parsed.postId : undefined
}

/** Resolve only the verified WeChat draft URL shape; never read its token. */
export function resolveWeixinAppMsgId(
  platformPostId?: string,
  draftUrl?: string,
): WeixinAppMsgIdResolution {
  const directId = normalizeWeixinAppMsgId(platformPostId) ?? undefined
  if (typeof platformPostId !== 'undefined' && !directId) {
    return {
      success: false,
      outcome: 'PARSE_ERROR',
      errorCode: 'WEIXIN_DRAFT_ID_INVALID',
      errorMessage: `The WeChat appMsgId must contain 1 to ${WEIXIN_APP_MSG_ID_MAX_LENGTH} digits.`,
    }
  }
  let urlId: string | undefined

  if (typeof draftUrl !== 'undefined') {
    urlId = parseStrictDraftUrl(draftUrl)
    if (!urlId) {
      return {
        success: false,
        outcome: 'PARSE_ERROR',
        errorCode: 'WEIXIN_DRAFT_URL_INVALID',
        errorMessage:
          'The WeChat draft URL does not match the verified editor shape.',
      }
    }
  }

  if (directId && urlId && directId !== urlId) {
    return {
      success: false,
      outcome: 'PARSE_ERROR',
      errorCode: 'WEIXIN_DRAFT_ID_CONFLICT',
      errorMessage: 'The stored WeChat post ID conflicts with the draft URL.',
    }
  }

  const appMsgId = directId ?? urlId
  if (!appMsgId) {
    return {
      success: false,
      outcome: 'UNSUPPORTED',
      errorCode: 'WEIXIN_DRAFT_ID_REQUIRED',
      errorMessage: 'WeChat draft inspection requires an appMsgId.',
    }
  }

  return { success: true, appMsgId }
}

/** Build the token-bearing published-list request for immediate use only. */
export function buildWeixinPublishedListRequest(
  token: string,
  begin: number,
  count = WEIXIN_PUBLISHED_LIST_PAGE_SIZE,
): string {
  const url = new URL('https://mp.weixin.qq.com/cgi-bin/appmsgpublish')
  url.searchParams.set('sub', 'list')
  url.searchParams.set('begin', String(begin))
  url.searchParams.set('count', String(count))
  url.searchParams.set('query', '')
  url.searchParams.set('type', '101_1_102_103')
  url.searchParams.set('show_type', '')
  url.searchParams.set('free_publish_type', '1_102_103')
  url.searchParams.set('sub_action', 'list_ex')
  url.searchParams.set('search_card', '0')
  url.searchParams.set('token', token)
  url.searchParams.set('lang', 'zh_CN')
  url.searchParams.set('f', 'json')
  url.searchParams.set('ajax', '1')
  return url.href
}

/**
 * Match an editor appMsgId to a published article using only the platform's
 * explicit draft identifiers. The public URL's mid is intentionally ignored.
 */
export function parseWeixinPublishedListPayload(
  value: unknown,
  appMsgId: string,
  begin: number,
  count = WEIXIN_PUBLISHED_LIST_PAGE_SIZE,
): WeixinPublishedListLookupResult {
  if (!isRecord(value)) {
    return {
      success: false,
      errorCode: 'WEIXIN_PUBLISHED_LIST_RESPONSE_INVALID',
    }
  }

  let ret: number | undefined
  if (typeof value.base_resp !== 'undefined') {
    if (!isRecord(value.base_resp)) {
      return {
        success: false,
        errorCode: 'WEIXIN_PUBLISHED_LIST_RESPONSE_INVALID',
      }
    }
    ret = nonNegativeInteger(value.base_resp.ret)
    if (typeof ret === 'undefined') {
      return {
        success: false,
        errorCode: 'WEIXIN_PUBLISHED_LIST_RESPONSE_INVALID',
      }
    }
  } else if (typeof value.ret !== 'undefined') {
    ret = nonNegativeInteger(value.ret)
    if (typeof ret === 'undefined') {
      return {
        success: false,
        errorCode: 'WEIXIN_PUBLISHED_LIST_RESPONSE_INVALID',
      }
    }
  }
  if (typeof ret === 'number' && ret !== 0) {
    return {
      success: false,
      errorCode: 'WEIXIN_PUBLISHED_LIST_API_ERROR',
    }
  }

  const publishPage = parseRecordOrJson(value.publish_page)
  if (
    !publishPage ||
    !Array.isArray(publishPage.publish_list) ||
    publishPage.publish_list.length > count
  ) {
    return {
      success: false,
      errorCode: 'WEIXIN_PUBLISHED_LIST_RESPONSE_INVALID',
    }
  }

  let foundIncompleteExactMatch = false
  const publishedMatches = new Map<
    string,
    { canonicalUrl: string; publishedAt: string }
  >()
  for (const rowValue of publishPage.publish_list) {
    if (!isRecord(rowValue)) {
      return {
        success: false,
        errorCode: 'WEIXIN_PUBLISHED_LIST_RESPONSE_INVALID',
      }
    }
    const hasInlinePublishInfo =
      rowValue.appmsgex !== undefined ||
      rowValue.appmsg_info !== undefined ||
      rowValue.draft_msgid !== undefined ||
      rowValue.copy_appmsg_id !== undefined
    const publishInfo =
      typeof rowValue.publish_info === 'undefined'
        ? hasInlinePublishInfo
          ? rowValue
          : null
        : parseRecordOrJson(rowValue.publish_info)
    if (!publishInfo) {
      return {
        success: false,
        errorCode: 'WEIXIN_PUBLISHED_LIST_RESPONSE_INVALID',
      }
    }

    const nestedPublishInfo = parseRecordOrJson(publishInfo.publish_info)
    if (typeof publishInfo.publish_info !== 'undefined' && !nestedPublishInfo) {
      return {
        success: false,
        errorCode: 'WEIXIN_PUBLISHED_LIST_RESPONSE_INVALID',
      }
    }
    const sourceContainers = [publishInfo, nestedPublishInfo, rowValue].filter(
      (container): container is Record<string, unknown> => container !== null,
    )
    const freePublishIdentityMatch = sourceContainers.some((container) =>
      exactAppMsgId(container.draft_msgid, appMsgId),
    )
    const massPublishIdentityMatch = sourceContainers.some((container) =>
      exactAppMsgId(container.copy_appmsg_id, appMsgId),
    )
    if (!freePublishIdentityMatch && !massPublishIdentityMatch) continue

    const freePublishComplete =
      freePublishIdentityMatch &&
      sourceContainers.some(
        (container) => nonNegativeInteger(container.publish_status) === 200,
      )
    const sentResult = parseSentResult(sourceContainers)
    const massPublishComplete =
      massPublishIdentityMatch &&
      nonNegativeInteger(sentResult?.msg_status) === 2

    if (!freePublishComplete && !massPublishComplete) {
      foundIncompleteExactMatch = true
      continue
    }

    const publishedAt = freePublishComplete
      ? firstPublishedAt([
          nestedPublishInfo?.create_time,
          publishInfo.create_time,
          rowValue.create_time,
        ])
      : firstPublishedAt([parseSentInfo(sourceContainers)?.time])
    if (!publishedAt) {
      foundIncompleteExactMatch = true
      continue
    }

    let matchedThisRecord = false
    for (const articleItem of collectArticleItems(sourceContainers)) {
      const canonicalUrl = resolveLongPublicArticleUrl(articleItem)
      if (!canonicalUrl) continue
      matchedThisRecord = true
      publishedMatches.set(`${canonicalUrl}\n${publishedAt}`, {
        canonicalUrl,
        publishedAt,
      })
    }

    if (!matchedThisRecord) foundIncompleteExactMatch = true
  }

  if (publishedMatches.size === 1 && !foundIncompleteExactMatch) {
    const [match] = publishedMatches.values()
    return {
      success: true,
      match: 'PUBLISHED',
      canonicalUrl: match.canonicalUrl,
      publishedAt: match.publishedAt,
    }
  }

  if (publishedMatches.size > 1 || foundIncompleteExactMatch) {
    return { success: true, match: 'REVIEW_REQUIRED' }
  }

  const totalCount = nonNegativeInteger(publishPage.total_count)
  const pageLength = publishPage.publish_list.length
  if (
    typeof publishPage.total_count !== 'undefined' &&
    (typeof totalCount === 'undefined' || totalCount < begin + pageLength)
  ) {
    return {
      success: false,
      errorCode: 'WEIXIN_PUBLISHED_LIST_RESPONSE_INVALID',
    }
  }
  return {
    success: true,
    match: 'NOT_FOUND',
    hasMore:
      typeof totalCount === 'number'
        ? begin + pageLength < totalCount
        : pageLength >= count,
  }
}

/** Build the token-bearing request URL for immediate in-memory use only. */
export function buildWeixinTempUrlRequest(
  appMsgId: string,
  token: string,
): string {
  const url = new URL('https://mp.weixin.qq.com/cgi-bin/appmsg')
  url.searchParams.set('action', 'get_temp_url')
  url.searchParams.set('appmsgid', appMsgId)
  url.searchParams.set('itemidx', '1')
  url.searchParams.set('token', token)
  url.searchParams.set('lang', 'zh_CN')
  url.searchParams.set('f', 'json')
  url.searchParams.set('ajax', '1')
  return url.href
}

/** Parse only the response fields needed by the inspector. */
export function parseWeixinTempUrlPayload(
  value: unknown,
): WeixinTempUrlPayloadResult {
  if (!isRecord(value)) {
    return {
      success: false,
      outcome: 'PARSE_ERROR',
      errorCode: 'WEIXIN_TEMP_RESPONSE_INVALID',
      errorMessage: 'The WeChat draft-detail response is not an object.',
    }
  }

  let ret: number | undefined
  if (typeof value.base_resp !== 'undefined') {
    if (!isRecord(value.base_resp) || typeof value.base_resp.ret !== 'number') {
      return {
        success: false,
        outcome: 'PARSE_ERROR',
        errorCode: 'WEIXIN_TEMP_RESPONSE_INVALID',
        errorMessage:
          'The WeChat draft-detail response has an invalid base_resp.',
      }
    }
    ret = value.base_resp.ret
  } else if (typeof value.ret !== 'undefined') {
    if (typeof value.ret !== 'number') {
      return {
        success: false,
        outcome: 'PARSE_ERROR',
        errorCode: 'WEIXIN_TEMP_RESPONSE_INVALID',
        errorMessage:
          'The WeChat draft-detail response has an invalid ret value.',
      }
    }
    ret = value.ret
  }

  if (ret === 200003) {
    return {
      success: false,
      outcome: 'LOGIN_REQUIRED',
      errorCode: 'WEIXIN_LOGIN_REQUIRED',
      errorMessage: 'The WeChat login session has expired.',
    }
  }

  if (typeof ret === 'number' && ret !== 0) {
    return {
      success: false,
      outcome: 'FETCH_ERROR',
      errorCode: 'WEIXIN_DRAFT_DETAIL_API_ERROR',
      errorMessage: `The WeChat draft-detail API returned error ${ret}.`,
    }
  }

  const tempUrl = nonEmptyString(value.temp_url)
  if (!tempUrl) {
    return {
      success: false,
      outcome: 'PARSE_ERROR',
      errorCode: 'WEIXIN_TEMP_URL_MISSING',
      errorMessage: 'The WeChat draft-detail response is missing temp_url.',
    }
  }

  return { success: true, tempUrl }
}

/**
 * Resolve a temporary URL at the trust boundary.
 *
 * WeChat still returns legacy HTTP preview URLs and its public host redirects
 * them to HTTPS. Validate the complete authority first, then upgrade only the
 * exact trusted host in memory. Failure results contain only fixed enums and
 * never expose hostname, path, query, fragment, or credentials.
 */
export function resolveWeixinTempUrl(value: string): WeixinTempUrlResolution {
  const normalized = value.trim()
  if (normalized.startsWith('//')) {
    return {
      success: false,
      shape: 'PROTOCOL_RELATIVE',
      errorCode: 'WEIXIN_TEMP_URL_PROTOCOL_RELATIVE',
    }
  }
  if (
    normalized.startsWith('/') ||
    normalized.startsWith('./') ||
    normalized.startsWith('../')
  ) {
    return {
      success: false,
      shape: 'PATH_RELATIVE',
      errorCode: 'WEIXIN_TEMP_URL_PATH_RELATIVE',
    }
  }

  try {
    const parsed = new URL(normalized)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return {
        success: false,
        shape: 'INVALID_OR_OTHER_SCHEME',
        errorCode: 'WEIXIN_TEMP_URL_INVALID_OR_OTHER_SCHEME',
      }
    }
    if (
      parsed.port !== '' ||
      parsed.username !== '' ||
      parsed.password !== ''
    ) {
      return {
        success: false,
        shape: 'PORT_OR_USERINFO',
        errorCode: 'WEIXIN_TEMP_URL_PORT_OR_USERINFO',
      }
    }
    if (parsed.hostname.toLowerCase() !== 'mp.weixin.qq.com') {
      return {
        success: false,
        shape: 'HOST_MISMATCH',
        errorCode: 'WEIXIN_TEMP_URL_HOST_MISMATCH',
      }
    }
    if (parsed.pathname !== '/s') {
      return {
        success: false,
        shape: 'PATH_MISMATCH',
        errorCode: 'WEIXIN_TEMP_URL_PATH_MISMATCH',
      }
    }

    if (parsed.protocol === 'http:') {
      parsed.protocol = 'https:'
      return {
        success: true,
        shape: 'SAFE_HTTP_UPGRADED',
        url: parsed.href,
      }
    }

    return {
      success: true,
      shape: 'SAFE_ABSOLUTE_HTTPS',
      url: parsed.href,
    }
  } catch {
    return {
      success: false,
      shape: 'INVALID_OR_OTHER_SCHEME',
      errorCode: 'WEIXIN_TEMP_URL_INVALID_OR_OTHER_SCHEME',
    }
  }
}

/** Classify without returning the token-bearing URL. */
export function classifyWeixinTempUrl(
  value: string,
): WeixinTempUrlClassification {
  const resolution = resolveWeixinTempUrl(value)
  if (!resolution.success) return resolution
  return { success: true, shape: resolution.shape }
}

/** Return only a normalized HTTPS URL on the exact WeChat preview host. */
export function validateWeixinTempUrl(value: string): string | undefined {
  const resolution = resolveWeixinTempUrl(value)
  return resolution.success ? resolution.url : undefined
}

function collectVisibleText(node: HtmlNodeLike, output: string[]): void {
  if (node.nodeType === 3) {
    output.push(node.nodeValue ?? '')
    return
  }

  const tagName = node.tagName?.toUpperCase()
  if (tagName && SKIPPED_TAGS.has(tagName)) return
  if (tagName === 'BR') {
    output.push('\n')
    return
  }

  const isBlock = Boolean(tagName && BLOCK_TAGS.has(tagName))
  if (isBlock) output.push('\n')
  for (const child of Array.from(node.childNodes ?? [])) {
    collectVisibleText(child, output)
  }
  if (isBlock) output.push('\n')
}

function normalizeBodyText(value: string): string {
  return value
    .replace(/\u00a0/g, ' ')
    .replace(/[\t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function parseWeixinArticleHtml(html: string): WeixinDraftHtmlResult {
  try {
    const { document } = parseHTML(html)
    const titleElement = document.querySelector('#activity-name')
    const contentElement = document.querySelector('#js_content')
    const title = titleElement?.textContent?.replace(/\s+/g, ' ').trim()
    if (!title || !contentElement) {
      return {
        success: false,
        errorCode: 'WEIXIN_DRAFT_HTML_INVALID',
        errorMessage:
          'The WeChat temporary page is missing its title or content container.',
      }
    }

    const textParts: string[] = []
    collectVisibleText(contentElement as unknown as HtmlNodeLike, textParts)
    const fullBodyText = normalizeBodyText(textParts.join(''))
    const bodyTruncated = fullBodyText.length > WEIXIN_DRAFT_BODY_TEXT_LIMIT

    return {
      success: true,
      title: title.slice(0, 500),
      bodyText: bodyTruncated
        ? fullBodyText.slice(0, WEIXIN_DRAFT_BODY_TEXT_LIMIT)
        : fullBodyText,
      bodyTruncated,
    }
  } catch {
    return {
      success: false,
      errorCode: 'WEIXIN_DRAFT_HTML_INVALID',
      errorMessage: 'The WeChat temporary page could not be parsed.',
    }
  }
}

/** Extract only title and visible body text from a temporary preview page. */
export function parseWeixinDraftHtml(html: string): WeixinDraftHtmlResult {
  return parseWeixinArticleHtml(html)
}

/** Extract the same bounded article evidence from a verified public page. */
export function parseWeixinPublicArticleHtml(
  html: string,
): WeixinDraftHtmlResult {
  return parseWeixinArticleHtml(html)
}
