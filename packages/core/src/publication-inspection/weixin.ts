import { parseHTML } from 'linkedom'

import { WEIXIN_APP_MSG_ID_MAX_LENGTH } from './types'
import { parsePublicationUrl } from './url'

export const WEIXIN_DRAFT_BODY_TEXT_LIMIT = 50_000
export const WEIXIN_PUBLISHED_LIST_PAGE_SIZE = 10
export const WEIXIN_PUBLISHED_LIST_MAX_REQUESTS = 20
export const WEIXIN_PUBLISHED_LIST_MAX_RECORDS = 100
export const WEIXIN_PUBLISHED_LIST_MAX_BYTES = 2 * 1024 * 1024
export const WEIXIN_DRAFT_LIST_PAGE_SIZE = 20
export const WEIXIN_DRAFT_LIST_MAX_BYTES = 2 * 1024 * 1024
export const WEIXIN_PUBLIC_PAGE_MAX_BYTES = 4 * 1024 * 1024
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

export type WeixinDraftListLookupResult =
  | { success: true; match: 'DRAFT_PRESENT' }
  | { success: true; match: 'NOT_FOUND' }
  | {
      success: false
      errorCode:
        | 'WEIXIN_DRAFT_LIST_ROOT_INVALID'
        | 'WEIXIN_DRAFT_LIST_BASE_RESPONSE_INVALID'
        | 'WEIXIN_DRAFT_LIST_BASE_RET_INVALID'
        | 'WEIXIN_DRAFT_LIST_API_ERROR'
        | 'WEIXIN_DRAFT_LIST_RECORDS_INVALID'
        | 'WEIXIN_DRAFT_LIST_RECORD_INVALID'
      shapeFingerprint?: string
    }

export type WeixinPublicArticlePublishedAtResult =
  | { success: true; publishedAt: string }
  | {
      success: false
      errorCode:
        | 'WEIXIN_PUBLIC_PUBLISHED_AT_MISSING'
        | 'WEIXIN_PUBLIC_PUBLISHED_AT_INVALID'
        | 'WEIXIN_PUBLIC_PUBLISHED_AT_AMBIGUOUS'
        | 'WEIXIN_PUBLIC_PUBLISHED_AT_CONFLICT'
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
      match: 'SCAN_INCOMPLETE'
    }
  | {
      success: true
      match: 'NOT_FOUND'
      hasMore: false
    }
  | {
      success: true
      match: 'NOT_FOUND'
      hasMore: true
      nextBegin: number
      totalCount?: number
      /** Newest completed publication time on a page proven newest-first. */
      newestPublishedAt?: string
      /** Oldest completed publication time on the same proven ordered page. */
      oldestPublishedAt?: string
    }
  | {
      success: false
      errorCode: 'WEIXIN_PUBLISHED_LIST_API_ERROR'
    }
  | {
      success: false
      errorCode: WeixinPublishedListShapeErrorCode
      /**
       * Fixed-vocabulary response shape only. It must never contain values,
       * keys supplied by the platform, account data, titles, URLs, or tokens.
       */
      shapeFingerprint: string
    }

export type WeixinPublishedListShapeErrorCode =
  | 'WEIXIN_PUBLISHED_LIST_ROOT_INVALID'
  | 'WEIXIN_PUBLISHED_LIST_BASE_RESPONSE_INVALID'
  | 'WEIXIN_PUBLISHED_LIST_BASE_RET_INVALID'
  | 'WEIXIN_PUBLISHED_LIST_PUBLISH_PAGE_INVALID'
  | 'WEIXIN_PUBLISHED_LIST_PUBLISH_LIST_INVALID'
  | 'WEIXIN_PUBLISHED_LIST_RECORD_INVALID'
  | 'WEIXIN_PUBLISHED_LIST_PUBLISH_INFO_INVALID'
  | 'WEIXIN_PUBLISHED_LIST_NESTED_INFO_INVALID'
  | 'WEIXIN_PUBLISHED_LIST_PAGINATION_INVALID'

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

type WeixinSafeValueShape =
  | 'missing'
  | 'null'
  | 'object'
  | 'array'
  | 'string:empty'
  | 'string:oversized'
  | 'string:json-object'
  | 'string:json-array'
  | 'string:json-scalar'
  | 'string:invalid-json'
  | 'number'
  | 'boolean'
  | 'other'

interface RecordOrJsonInspection {
  record: Record<string, unknown> | null
  shape: WeixinSafeValueShape
}

type WeixinPublishedListShapePath =
  | 'root'
  | 'base_resp'
  | 'base_resp.ret'
  | 'ret'
  | 'publish_page'
  | 'publish_page.publish_list'
  | 'publish_page.publish_list.row'
  | 'publish_info'
  | 'publish_info.publish_info'
  | 'publish_page.total_count'

function inspectRecordOrJson(value: unknown): RecordOrJsonInspection {
  if (typeof value === 'undefined') return { record: null, shape: 'missing' }
  if (value === null) return { record: null, shape: 'null' }
  if (isRecord(value)) return { record: value, shape: 'object' }
  if (Array.isArray(value)) return { record: null, shape: 'array' }
  if (typeof value !== 'string') {
    if (typeof value === 'number') return { record: null, shape: 'number' }
    if (typeof value === 'boolean') return { record: null, shape: 'boolean' }
    return { record: null, shape: 'other' }
  }
  if (value.length > 2_000_000) {
    return { record: null, shape: 'string:oversized' }
  }
  if (value.trim().length === 0) return { record: null, shape: 'string:empty' }
  try {
    const parsed: unknown = JSON.parse(value)
    if (isRecord(parsed)) return { record: parsed, shape: 'string:json-object' }
    return {
      record: null,
      shape: Array.isArray(parsed) ? 'string:json-array' : 'string:json-scalar',
    }
  } catch {
    return { record: null, shape: 'string:invalid-json' }
  }
}

function parseRecordOrJson(value: unknown): Record<string, unknown> | null {
  return inspectRecordOrJson(value).record
}

function safeValueShape(value: unknown): WeixinSafeValueShape {
  return inspectRecordOrJson(value).shape
}

function isAbsentRecordSentinel(
  shape: WeixinSafeValueShape,
): shape is 'missing' | 'string:empty' {
  return shape === 'missing' || shape === 'string:empty'
}

function publishedListShapeFailure(
  errorCode: WeixinPublishedListShapeErrorCode,
  path: WeixinPublishedListShapePath,
  shape:
    | WeixinSafeValueShape
    | 'array:exceeds-requested-count'
    | 'less-than-page-bound'
    | 'less-than-materialized-page-bound',
): Extract<
  WeixinPublishedListLookupResult,
  { success: false; shapeFingerprint: string }
> {
  return {
    success: false,
    errorCode,
    shapeFingerprint: `wx-list-shape:v1;${path}=${shape}`,
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

type WeixinInlineIdentityShape = 'missing' | 'invalid' | 'target' | 'other'

function classifyWeixinInlineIdentity(
  row: Record<string, unknown>,
  appMsgId: string,
): WeixinInlineIdentityShape {
  const values = [row.draft_msgid, row.copy_appmsg_id]
  const presentValues = values.filter((value) => value !== undefined)
  if (presentValues.length === 0) return 'missing'

  const normalizedValues = presentValues
    .map((value) => normalizeWeixinAppMsgId(value))
    .filter((value): value is string => value !== null)
  if (normalizedValues.includes(appMsgId)) return 'target'
  if (normalizedValues.length > 0) return 'other'
  return 'invalid'
}

function publishedListInlineInfoFailure(
  publishInfoShape: 'missing' | 'string:empty',
  inlineIdentityShape: WeixinInlineIdentityShape,
): Extract<
  WeixinPublishedListLookupResult,
  { success: false; shapeFingerprint: string }
> {
  return {
    success: false,
    errorCode: 'WEIXIN_PUBLISHED_LIST_PUBLISH_INFO_INVALID',
    shapeFingerprint:
      `wx-list-row:v2;publish_info=${publishInfoShape};` +
      `inline_identity=${inlineIdentityShape}`,
  }
}

function isWeixinEmptyPublishedListPlaceholder(
  publishInfoShape: WeixinSafeValueShape,
  inlineIdentityShape: WeixinInlineIdentityShape,
): boolean {
  return (
    publishInfoShape === 'string:empty' && inlineIdentityShape === 'missing'
  )
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

function resolvePublicArticleUrl(
  articleItem: Record<string, unknown>,
): string | undefined {
  const canonicalUrls = new Set<string>()
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
    const normalized = normalizeWeixinPublicArticleUrl(trustedCandidate)
    if (normalized) canonicalUrls.add(normalized)
  }
  return canonicalUrls.size === 1
    ? canonicalUrls.values().next().value
    : undefined
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
 * Normalize the legacy long public URL shape.
 *
 * Retained for callers that specifically require __biz/mid/idx identity.
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
 * Public-page inspection accepts either verified WeChat identity shape, but
 * only when the initial request returns that exact canonical URL directly.
 * Redirects and response URL changes are rejected before the body is read.
 */
export function validateWeixinPublicPageResponse(
  candidateUrl: string,
  response: Pick<Response, 'url' | 'redirected' | 'headers'>,
): WeixinPublicPageResponseResolution {
  const candidate = parseWeixinPublicArticleIdentity(candidateUrl)
  if (!candidate) {
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

/** Build the token-bearing current-draft list request for immediate use only. */
export function buildWeixinDraftListRequest(
  token: string,
  type: 10 | 77,
  count = WEIXIN_DRAFT_LIST_PAGE_SIZE,
): string {
  const url = new URL('https://mp.weixin.qq.com/cgi-bin/appmsg')
  url.searchParams.set('begin', '0')
  url.searchParams.set('count', String(count))
  url.searchParams.set('type', String(type))
  url.searchParams.set('action', 'list_card')
  url.searchParams.set('token', token)
  url.searchParams.set('lang', 'zh_CN')
  url.searchParams.set('f', 'json')
  url.searchParams.set('ajax', '1')
  return url.href
}

function parseArrayOrJson(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value
  if (typeof value !== 'string' || value.length > 2_000_000) return null
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** Match only the exact numeric appMsgId in the authenticated current-draft list. */
export function parseWeixinDraftListPayload(
  value: unknown,
  appMsgId: string,
): WeixinDraftListLookupResult {
  if (!isRecord(value)) {
    return {
      success: false,
      errorCode: 'WEIXIN_DRAFT_LIST_ROOT_INVALID',
      shapeFingerprint: `wx-draft-list-shape:v1;root=${safeValueShape(value)}`,
    }
  }

  if (!isRecord(value.base_resp)) {
    return {
      success: false,
      errorCode: 'WEIXIN_DRAFT_LIST_BASE_RESPONSE_INVALID',
      shapeFingerprint: `wx-draft-list-shape:v1;base_resp=${safeValueShape(value.base_resp)}`,
    }
  }
  const ret = nonNegativeInteger(value.base_resp.ret)
  if (typeof ret === 'undefined') {
    return {
      success: false,
      errorCode: 'WEIXIN_DRAFT_LIST_BASE_RET_INVALID',
      shapeFingerprint: `wx-draft-list-shape:v1;base_resp.ret=${safeValueShape(value.base_resp.ret)}`,
    }
  }
  if (ret !== 0) {
    return { success: false, errorCode: 'WEIXIN_DRAFT_LIST_API_ERROR' }
  }

  const cardInfo = isRecord(value.app_msg_info) ? value.app_msg_info : null
  const cardRecords = cardInfo ? parseArrayOrJson(cardInfo.item) : null
  if (!cardRecords) {
    return {
      success: false,
      errorCode: 'WEIXIN_DRAFT_LIST_RECORDS_INVALID',
      shapeFingerprint:
        `wx-draft-list-shape:v1;app_msg_info=${safeValueShape(value.app_msg_info)};` +
        `app_msg_info.item=${safeValueShape(cardInfo?.item)}`,
    }
  }

  for (const record of cardRecords) {
    if (!isRecord(record)) {
      return {
        success: false,
        errorCode: 'WEIXIN_DRAFT_LIST_RECORD_INVALID',
        shapeFingerprint: `wx-draft-list-shape:v1;record=${safeValueShape(record)}`,
      }
    }
    const candidate = normalizeWeixinAppMsgId(record.app_id)
    if (!candidate) {
      return {
        success: false,
        errorCode: 'WEIXIN_DRAFT_LIST_RECORD_INVALID',
        shapeFingerprint: `wx-draft-list-shape:v1;record.app_id=${safeValueShape(record.app_id)}`,
      }
    }
    if (candidate === appMsgId) {
      return { success: true, match: 'DRAFT_PRESENT' }
    }
  }
  return { success: true, match: 'NOT_FOUND' }
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
  remainingMaterializedRecordBudget = Math.max(
    0,
    WEIXIN_PUBLISHED_LIST_MAX_RECORDS - begin,
  ),
): WeixinPublishedListLookupResult {
  if (!isRecord(value)) {
    return publishedListShapeFailure(
      'WEIXIN_PUBLISHED_LIST_ROOT_INVALID',
      'root',
      safeValueShape(value),
    )
  }

  let ret: number | undefined
  if (typeof value.base_resp !== 'undefined') {
    if (!isRecord(value.base_resp)) {
      return publishedListShapeFailure(
        'WEIXIN_PUBLISHED_LIST_BASE_RESPONSE_INVALID',
        'base_resp',
        safeValueShape(value.base_resp),
      )
    }
    ret = nonNegativeInteger(value.base_resp.ret)
    if (typeof ret === 'undefined') {
      return publishedListShapeFailure(
        'WEIXIN_PUBLISHED_LIST_BASE_RET_INVALID',
        'base_resp.ret',
        safeValueShape(value.base_resp.ret),
      )
    }
  } else if (typeof value.ret !== 'undefined') {
    ret = nonNegativeInteger(value.ret)
    if (typeof ret === 'undefined') {
      return publishedListShapeFailure(
        'WEIXIN_PUBLISHED_LIST_BASE_RET_INVALID',
        'ret',
        safeValueShape(value.ret),
      )
    }
  }
  if (typeof ret === 'number' && ret !== 0) {
    return {
      success: false,
      errorCode: 'WEIXIN_PUBLISHED_LIST_API_ERROR',
    }
  }

  const publishPageInspection = inspectRecordOrJson(value.publish_page)
  const publishPage = publishPageInspection.record
  if (!publishPage) {
    return publishedListShapeFailure(
      'WEIXIN_PUBLISHED_LIST_PUBLISH_PAGE_INVALID',
      'publish_page',
      publishPageInspection.shape,
    )
  }
  if (!Array.isArray(publishPage.publish_list)) {
    return publishedListShapeFailure(
      'WEIXIN_PUBLISHED_LIST_PUBLISH_LIST_INVALID',
      'publish_page.publish_list',
      safeValueShape(publishPage.publish_list),
    )
  }
  if (publishPage.publish_list.length > count) {
    return publishedListShapeFailure(
      'WEIXIN_PUBLISHED_LIST_PUBLISH_LIST_INVALID',
      'publish_page.publish_list',
      'array:exceeds-requested-count',
    )
  }

  let foundIncompleteExactMatch = false
  let materializedPublishRecordCount = 0
  const materializedPublishedTimes: string[] = []
  let materializedPublicationTimesComplete = true
  const publishedMatches = new Map<
    string,
    { canonicalUrl: string; publishedAt: string }
  >()
  for (const rowValue of publishPage.publish_list) {
    if (!isRecord(rowValue)) {
      return publishedListShapeFailure(
        'WEIXIN_PUBLISHED_LIST_RECORD_INVALID',
        'publish_page.publish_list.row',
        safeValueShape(rowValue),
      )
    }
    const publishInfoInspection = inspectRecordOrJson(rowValue.publish_info)
    const inlineIdentityShape = classifyWeixinInlineIdentity(rowValue, appMsgId)
    let publishInfo = publishInfoInspection.record
    let usesInlinePublishInfo = false
    if (!publishInfo && isAbsentRecordSentinel(publishInfoInspection.shape)) {
      if (inlineIdentityShape === 'target' || inlineIdentityShape === 'other') {
        publishInfo = rowValue
        usesInlinePublishInfo = true
      } else if (
        isWeixinEmptyPublishedListPlaceholder(
          publishInfoInspection.shape,
          inlineIdentityShape,
        )
      ) {
        continue
      } else {
        return publishedListInlineInfoFailure(
          publishInfoInspection.shape,
          inlineIdentityShape,
        )
      }
    }
    if (!publishInfo) {
      return publishedListShapeFailure(
        'WEIXIN_PUBLISHED_LIST_PUBLISH_INFO_INVALID',
        'publish_info',
        publishInfoInspection.shape,
      )
    }
    materializedPublishRecordCount += 1
    // The hard record cap is a trust boundary, not merely a pagination hint.
    // Enforce it before inspecting identity or publication evidence so the
    // first record beyond the budget can never become a false positive.
    if (materializedPublishRecordCount > remainingMaterializedRecordBudget) {
      return { success: true, match: 'SCAN_INCOMPLETE' }
    }

    const nestedPublishInfoValue = usesInlinePublishInfo
      ? undefined
      : publishInfo.publish_info
    const nestedPublishInfoInspection = inspectRecordOrJson(
      nestedPublishInfoValue,
    )
    const nestedPublishInfo = nestedPublishInfoInspection.record
    if (
      !nestedPublishInfo &&
      !isAbsentRecordSentinel(nestedPublishInfoInspection.shape)
    ) {
      return publishedListShapeFailure(
        'WEIXIN_PUBLISHED_LIST_NESTED_INFO_INVALID',
        'publish_info.publish_info',
        nestedPublishInfoInspection.shape,
      )
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
    const freePublishComplete = sourceContainers.some(
      (container) => nonNegativeInteger(container.publish_status) === 200,
    )
    const sentResult = parseSentResult(sourceContainers)
    const massPublishComplete = nonNegativeInteger(sentResult?.msg_status) === 2
    const recordPublishedAt = freePublishComplete
      ? firstPublishedAt([
          nestedPublishInfo?.create_time,
          publishInfo.create_time,
          rowValue.create_time,
        ])
      : massPublishComplete
        ? firstPublishedAt([parseSentInfo(sourceContainers)?.time])
        : undefined
    if (recordPublishedAt) {
      materializedPublishedTimes.push(recordPublishedAt)
    } else {
      materializedPublicationTimesComplete = false
    }

    if (!freePublishIdentityMatch && !massPublishIdentityMatch) continue

    if (
      (freePublishIdentityMatch && !freePublishComplete) ||
      (massPublishIdentityMatch && !massPublishComplete)
    ) {
      foundIncompleteExactMatch = true
      continue
    }

    const publishedAt = recordPublishedAt
    if (!publishedAt) {
      foundIncompleteExactMatch = true
      continue
    }

    let matchedThisRecord = false
    for (const articleItem of collectArticleItems(sourceContainers)) {
      const canonicalUrl = resolvePublicArticleUrl(articleItem)
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
  if (
    typeof publishPage.total_count !== 'undefined' &&
    typeof totalCount === 'undefined'
  ) {
    return publishedListShapeFailure(
      'WEIXIN_PUBLISHED_LIST_PAGINATION_INVALID',
      'publish_page.total_count',
      safeValueShape(publishPage.total_count),
    )
  }

  // The web endpoint pads an exhausted page with strict empty publish_info
  // placeholders while total_count remains advisory. A page with no
  // materialized publish records is the terminal sentinel and must win before
  // relational pagination checks.
  if (materializedPublishRecordCount === 0) {
    return { success: true, match: 'NOT_FOUND', hasMore: false }
  }

  const nextBegin = begin + materializedPublishRecordCount
  if (typeof totalCount === 'number' && totalCount < nextBegin) {
    return publishedListShapeFailure(
      'WEIXIN_PUBLISHED_LIST_PAGINATION_INVALID',
      'publish_page.total_count',
      'less-than-materialized-page-bound',
    )
  }
  const newestPublishedAt =
    materializedPublicationTimesComplete &&
    materializedPublishedTimes.length === materializedPublishRecordCount &&
    materializedPublishedTimes.every(
      (publishedAt, index) =>
        index === 0 ||
        Date.parse(materializedPublishedTimes[index - 1]!) >=
          Date.parse(publishedAt),
    )
      ? materializedPublishedTimes[0]
      : undefined
  const oldestPublishedAt = newestPublishedAt
    ? materializedPublishedTimes.at(-1)
    : undefined
  return {
    success: true,
    match: 'NOT_FOUND',
    hasMore: true,
    nextBegin,
    ...(typeof totalCount === 'number' ? { totalCount } : {}),
    ...(newestPublishedAt ? { newestPublishedAt } : {}),
    ...(oldestPublishedAt ? { oldestPublishedAt } : {}),
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

function collectPublicTimeAssignments(
  scripts: readonly string[],
  field: 'ct' | 'oriCreateTime',
): { present: boolean; invalid: boolean; values: Set<string> } {
  const values = new Set<string>()
  let present = false
  let invalid = false
  const source =
    field === 'ct'
      ? String.raw`(?:^|(?<=[;\r\n]))\s*var\s+ct\s*=\s*([^;\r\n]*)(?:;|$)`
      : String.raw`(?:^|(?<=[;\r\n]))\s*(?:var\s+)?oriCreateTime\s*=\s*([^;\r\n]*)(?:;|$)`
  for (const script of scripts) {
    const pattern = new RegExp(source, 'g')
    for (const match of script.matchAll(pattern)) {
      present = true
      const assignment = (match[1] ?? '').trim()
      const value = assignment.match(/^(["'])(\d{10})\1$/)?.[2]
      if (!value) invalid = true
      else values.add(value)
    }
  }
  return { present, invalid, values }
}

/** Parse an independently verified public-page publication time. */
export function parseWeixinPublicArticlePublishedAt(
  html: string,
  checkedAt: string,
): WeixinPublicArticlePublishedAtResult {
  try {
    const checkedAtMs = Date.parse(checkedAt)
    if (!Number.isFinite(checkedAtMs)) {
      return {
        success: false,
        errorCode: 'WEIXIN_PUBLIC_PUBLISHED_AT_INVALID',
        errorMessage: 'The WeChat public-page check time is invalid.',
      }
    }
    const { document } = parseHTML(html)
    const content = document.querySelector('#js_content')
    const scripts = Array.from(document.querySelectorAll('script'))
      .filter((script) => !content?.contains(script))
      .map((script) => script.textContent ?? '')
    const ct = collectPublicTimeAssignments(scripts, 'ct')
    const original = collectPublicTimeAssignments(scripts, 'oriCreateTime')
    const hasValidAssignment = ct.values.size > 0 || original.values.size > 0
    if (!hasValidAssignment && !ct.invalid && !original.invalid) {
      return {
        success: false,
        errorCode: 'WEIXIN_PUBLIC_PUBLISHED_AT_MISSING',
        errorMessage:
          'The WeChat public page does not expose a publication time.',
      }
    }
    // `ct` is also a common local variable name inside WeChat's bundled
    // JavaScript. Once an exact quoted Unix timestamp exists, unrelated
    // non-timestamp assignments must not poison that publication evidence.
    // With no valid timestamp at all, an assignment-shaped occurrence still
    // fails closed as INVALID instead of being treated as missing evidence.
    if (!hasValidAssignment && (ct.invalid || original.invalid)) {
      return {
        success: false,
        errorCode: 'WEIXIN_PUBLIC_PUBLISHED_AT_INVALID',
        errorMessage:
          'The WeChat public page exposes an invalid publication time.',
      }
    }
    if (ct.values.size > 1 || original.values.size > 1) {
      return {
        success: false,
        errorCode: 'WEIXIN_PUBLIC_PUBLISHED_AT_AMBIGUOUS',
        errorMessage:
          'The WeChat public page exposes ambiguous publication times.',
      }
    }
    const ctValue = [...ct.values][0]
    const originalValue = [...original.values][0]
    if (ctValue && originalValue && ctValue !== originalValue) {
      return {
        success: false,
        errorCode: 'WEIXIN_PUBLIC_PUBLISHED_AT_CONFLICT',
        errorMessage:
          'The WeChat public page exposes conflicting publication times.',
      }
    }
    const value = ctValue ?? originalValue
    const seconds = value ? Number(value) : Number.NaN
    const minimumSeconds = Date.UTC(2000, 0, 1) / 1_000
    if (
      !Number.isSafeInteger(seconds) ||
      seconds < minimumSeconds ||
      seconds * 1_000 > checkedAtMs
    ) {
      return {
        success: false,
        errorCode: 'WEIXIN_PUBLIC_PUBLISHED_AT_INVALID',
        errorMessage:
          'The WeChat public page exposes an invalid publication time.',
      }
    }
    return {
      success: true,
      publishedAt: new Date(seconds * 1_000).toISOString(),
    }
  } catch {
    return {
      success: false,
      errorCode: 'WEIXIN_PUBLIC_PUBLISHED_AT_INVALID',
      errorMessage:
        'The WeChat public-page publication time could not be parsed.',
    }
  }
}
