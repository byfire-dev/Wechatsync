import type { AuthResult } from '../types'
import { normalizeHtmlText, parseTagAttributes } from './html'
import type {
  PublicationInspectRequest,
  PublicationObservation,
  PublicationObservationOutcome,
  PublicationObservationSource,
} from './types'
import { parsePublicationUrl } from './url'

const SOHU_MANAGEMENT_ORIGIN = 'https://mp.sohu.com'
const SOHU_PUBLIC_ORIGIN = 'https://www.sohu.com'
const SOHU_DETAIL_PATH = '/mpbp/bp/news/v4/article'
const SOHU_SUCCESS_CODE = 2_000_000
const SOHU_LOGIN_REQUIRED_CODE = 1_211
const MAX_TITLE_LENGTH = 500
const MAX_BODY_TEXT_LENGTH = 50_000

export interface SohuInspectionDependencies {
  checkAuth(): Promise<AuthResult>
  /**
   * Multi-account adapters may prove membership in the authenticated account
   * set without changing the legacy checkAuth projection.
   */
  hasAuthenticatedAccount?: (externalAccountId: string) => boolean
  fetch(url: string, options?: RequestInit): Promise<Response>
  detailHeaders?: () => Record<string, string>
  now?: () => string
}

interface ObservationDetails {
  outcome: PublicationObservationOutcome
  source: PublicationObservationSource
  platformPostId?: string
  canonicalUrl?: string
  title?: string
  publishedAt?: string
  bodyText?: string
  bodyTruncated?: boolean
  errorCode?: string
  errorMessage?: string
}

interface SohuArticleDetail {
  status: number
  type?: number
  secureScore?: number
  title?: string
  bodyText?: string
  bodyTruncated?: boolean
}

type PostIdentityResolution =
  | { success: true; postId: string; accountId: string }
  | {
      success: false
      outcome: 'UNSUPPORTED' | 'PARSE_ERROR'
      errorCode: string
      errorMessage: string
    }

type DetailProbe =
  | { kind: 'FOUND'; detail: SohuArticleDetail }
  | { kind: 'OBSERVATION'; observation: PublicationObservation }

export interface SohuPublishedArticleEvidence {
  title: string
  publishedAt: string
  bodyText: string
  bodyTruncated: boolean
}

export type SohuPublishedEvidenceFailureReason =
  | 'IDENTITY_METADATA_MISSING'
  | 'IDENTITY_METADATA_DUPLICATE'
  | 'IDENTITY_METADATA_MISMATCH'
  | 'JSON_LD_MISSING'
  | 'JSON_LD_INVALID'
  | 'NEWS_ARTICLE_MISSING'
  | 'NEWS_ARTICLE_DUPLICATE'
  | 'NEWS_ARTICLE_IDENTITY_MISMATCH'
  | 'NEWS_ARTICLE_PAYLOAD_INVALID'
  | 'CFGS_MISSING'
  | 'CFGS_DUPLICATE'
  | 'CFGS_INVALID'
  | 'CFGS_IDENTITY_MISMATCH'
  | 'DISPLAY_MODE_RESTRICTED'
  | 'ARTICLE_BODY_MISSING'
  | 'ARTICLE_BODY_DUPLICATE'
  | 'ARTICLE_BODY_EMPTY'

export type SohuPublishedEvidenceParseResult =
  | { success: true; evidence: SohuPublishedArticleEvidence }
  | { success: false; reason: SohuPublishedEvidenceFailureReason }

function createObservation(
  request: PublicationInspectRequest,
  observedAt: string,
  details: ObservationDetails,
): PublicationObservation {
  return {
    observationKey: `sohu:${request.requestId}:${details.source}:${details.outcome}`,
    platform: 'sohu',
    externalAccountId: request.externalAccountId,
    observedAt,
    ...details,
  }
}

function normalizeIdentifier(value: unknown): string | undefined {
  if (typeof value === 'string' && /^\d+$/.test(value)) return value
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return String(value)
  }
  return undefined
}

function resolvePostIdentity(
  request: PublicationInspectRequest,
): PostIdentityResolution {
  if (request.platform !== 'sohu') {
    return {
      success: false,
      outcome: 'UNSUPPORTED',
      errorCode: 'SOHU_PLATFORM_REQUIRED',
      errorMessage: 'The Sohu inspector only accepts Sohu requests.',
    }
  }

  const accountId = request.externalAccountId.trim()
  if (!/^\d+$/.test(accountId)) {
    return {
      success: false,
      outcome: 'PARSE_ERROR',
      errorCode: 'SOHU_INVALID_ACCOUNT_ID',
      errorMessage: 'The Sohu account ID must contain digits only.',
    }
  }

  const platformPostId = request.draft.platformPostId?.trim()
  if (platformPostId && !/^\d+$/.test(platformPostId)) {
    return {
      success: false,
      outcome: 'PARSE_ERROR',
      errorCode: 'SOHU_INVALID_POST_ID',
      errorMessage: 'The Sohu post ID must contain digits only.',
    }
  }

  let draftUrlPostId: string | undefined
  if (request.draft.draftUrl) {
    const parsedDraftUrl = parsePublicationUrl('sohu', request.draft.draftUrl)
    if (
      !parsedDraftUrl ||
      parsedDraftUrl.surface !== 'DRAFT' ||
      !parsedDraftUrl.postId
    ) {
      return {
        success: false,
        outcome: 'PARSE_ERROR',
        errorCode: 'SOHU_INVALID_DRAFT_URL',
        errorMessage: 'The draft URL is not a verified Sohu editor URL.',
      }
    }

    if (parsedDraftUrl.accountId && parsedDraftUrl.accountId !== accountId) {
      return {
        success: false,
        outcome: 'PARSE_ERROR',
        errorCode: 'SOHU_DRAFT_ACCOUNT_ID_CONFLICT',
        errorMessage: 'The Sohu draft URL belongs to a different account.',
      }
    }
    draftUrlPostId = parsedDraftUrl.postId
  }

  if (platformPostId && draftUrlPostId && platformPostId !== draftUrlPostId) {
    return {
      success: false,
      outcome: 'PARSE_ERROR',
      errorCode: 'SOHU_POST_ID_CONFLICT',
      errorMessage:
        'The Sohu post ID and draft URL identify different articles.',
    }
  }

  const postId = platformPostId ?? draftUrlPostId
  if (!postId) {
    return {
      success: false,
      outcome: 'UNSUPPORTED',
      errorCode: 'SOHU_POST_ID_REQUIRED',
      errorMessage:
        'Exact Sohu inspection requires a post ID or verified draft URL.',
    }
  }

  return { success: true, postId, accountId }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function contentTypeIsJson(response: Response): boolean {
  const contentType = response.headers.get('content-type')?.toLowerCase()
  return Boolean(
    contentType &&
    (contentType.includes('application/json') || contentType.includes('+json')),
  )
}

function contentTypeIsHtml(response: Response): boolean {
  const contentType = response.headers.get('content-type')?.toLowerCase()
  return Boolean(
    contentType &&
    (contentType.includes('text/html') ||
      contentType.includes('application/xhtml+xml')),
  )
}

function normalizeOptionalText(
  value: unknown,
  maxLength: number,
): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = normalizeHtmlText(value)
  return normalized ? normalized.slice(0, maxLength) : undefined
}

function detailUrl(postId: string, accountId: string): string {
  const url = new URL(SOHU_DETAIL_PATH, SOHU_MANAGEMENT_ORIGIN)
  url.searchParams.set('newsId', postId)
  url.searchParams.set('accountId', accountId)
  return url.href
}

async function fetchArticleDetail(
  request: PublicationInspectRequest,
  postId: string,
  accountId: string,
  dependencies: SohuInspectionDependencies,
  observedAt: string,
): Promise<DetailProbe> {
  const url = detailUrl(postId, accountId)
  let response: Response
  try {
    response = await dependencies.fetch(url, {
      method: 'GET',
      credentials: 'include',
      redirect: 'error',
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        'x-requested-with': 'fetch',
        ...dependencies.detailHeaders?.(),
      },
    })
  } catch {
    return {
      kind: 'OBSERVATION',
      observation: createObservation(request, observedAt, {
        outcome: 'FETCH_ERROR',
        source: 'PLATFORM_DETAIL',
        platformPostId: postId,
        errorCode: 'SOHU_DETAIL_FETCH_ERROR',
        errorMessage: 'The Sohu article-detail request failed.',
      }),
    }
  }

  if (response.url !== url) {
    return {
      kind: 'OBSERVATION',
      observation: createObservation(request, observedAt, {
        outcome: 'PARSE_ERROR',
        source: 'PLATFORM_DETAIL',
        platformPostId: postId,
        errorCode: 'SOHU_DETAIL_UNEXPECTED_RESPONSE_URL',
        errorMessage:
          'The Sohu article-detail response came from an unexpected URL.',
      }),
    }
  }

  if (response.status === 401) {
    return {
      kind: 'OBSERVATION',
      observation: createObservation(request, observedAt, {
        outcome: 'LOGIN_REQUIRED',
        source: 'PLATFORM_DETAIL',
        platformPostId: postId,
        errorCode: 'SOHU_LOGIN_REQUIRED',
        errorMessage: 'Sohu requires an authenticated session.',
      }),
    }
  }

  if (!response.ok) {
    return {
      kind: 'OBSERVATION',
      observation: createObservation(request, observedAt, {
        outcome: 'FETCH_ERROR',
        source: 'PLATFORM_DETAIL',
        platformPostId: postId,
        errorCode: `SOHU_DETAIL_HTTP_${response.status}`,
        errorMessage: `Sohu returned HTTP ${response.status} for the article-detail request.`,
      }),
    }
  }

  if (!contentTypeIsJson(response)) {
    return {
      kind: 'OBSERVATION',
      observation: createObservation(request, observedAt, {
        outcome: 'PARSE_ERROR',
        source: 'PLATFORM_DETAIL',
        platformPostId: postId,
        errorCode: 'SOHU_DETAIL_UNEXPECTED_CONTENT_TYPE',
        errorMessage: 'Sohu returned a non-JSON article-detail response.',
      }),
    }
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    return {
      kind: 'OBSERVATION',
      observation: createObservation(request, observedAt, {
        outcome: 'PARSE_ERROR',
        source: 'PLATFORM_DETAIL',
        platformPostId: postId,
        errorCode: 'SOHU_DETAIL_JSON_INVALID',
        errorMessage: 'The Sohu article-detail response was not valid JSON.',
      }),
    }
  }

  if (!isRecord(payload)) {
    return {
      kind: 'OBSERVATION',
      observation: createObservation(request, observedAt, {
        outcome: 'PARSE_ERROR',
        source: 'PLATFORM_DETAIL',
        platformPostId: postId,
        errorCode: 'SOHU_DETAIL_RESPONSE_INVALID',
        errorMessage: 'The Sohu article-detail response had an invalid shape.',
      }),
    }
  }

  if (payload.code === SOHU_LOGIN_REQUIRED_CODE) {
    return {
      kind: 'OBSERVATION',
      observation: createObservation(request, observedAt, {
        outcome: 'LOGIN_REQUIRED',
        source: 'PLATFORM_DETAIL',
        platformPostId: postId,
        errorCode: 'SOHU_LOGIN_REQUIRED',
        errorMessage: 'Sohu requires an authenticated session.',
      }),
    }
  }

  if (payload.code !== SOHU_SUCCESS_CODE) {
    return {
      kind: 'OBSERVATION',
      observation: createObservation(request, observedAt, {
        outcome: 'FETCH_ERROR',
        source: 'PLATFORM_DETAIL',
        platformPostId: postId,
        errorCode: 'SOHU_DETAIL_BUSINESS_ERROR',
        errorMessage: 'Sohu rejected the article-detail request.',
      }),
    }
  }

  const data = payload.data
  const news = isRecord(data) ? data.news : undefined
  if (!isRecord(news)) {
    return {
      kind: 'OBSERVATION',
      observation: createObservation(request, observedAt, {
        outcome: 'PARSE_ERROR',
        source: 'PLATFORM_DETAIL',
        platformPostId: postId,
        errorCode: 'SOHU_DETAIL_RESPONSE_INVALID',
        errorMessage:
          'The Sohu article-detail response did not contain article data.',
      }),
    }
  }

  if (normalizeIdentifier(news.id) !== postId) {
    return {
      kind: 'OBSERVATION',
      observation: createObservation(request, observedAt, {
        outcome: 'PARSE_ERROR',
        source: 'PLATFORM_DETAIL',
        platformPostId: postId,
        errorCode: 'SOHU_DETAIL_POST_ID_MISMATCH',
        errorMessage:
          'The Sohu article-detail response identified a different article.',
      }),
    }
  }

  if (normalizeIdentifier(news.userId) !== accountId) {
    return {
      kind: 'OBSERVATION',
      observation: createObservation(request, observedAt, {
        outcome: 'ACCOUNT_MISMATCH',
        source: 'PLATFORM_DETAIL',
        platformPostId: postId,
        errorCode: 'ACCOUNT_MISMATCH',
        errorMessage:
          'The Sohu article-detail response belongs to a different account.',
      }),
    }
  }

  if (typeof news.status !== 'number' || !Number.isInteger(news.status)) {
    return {
      kind: 'OBSERVATION',
      observation: createObservation(request, observedAt, {
        outcome: 'PARSE_ERROR',
        source: 'PLATFORM_DETAIL',
        platformPostId: postId,
        errorCode: 'SOHU_DETAIL_STATUS_INVALID',
        errorMessage:
          'The Sohu article-detail response had an invalid publication status.',
      }),
    }
  }

  for (const field of ['type', 'secureScore'] as const) {
    const value = news[field]
    if (
      value !== undefined &&
      (typeof value !== 'number' || !Number.isInteger(value))
    ) {
      return {
        kind: 'OBSERVATION',
        observation: createObservation(request, observedAt, {
          outcome: 'PARSE_ERROR',
          source: 'PLATFORM_DETAIL',
          platformPostId: postId,
          errorCode: `SOHU_DETAIL_${field === 'type' ? 'TYPE' : 'SECURE_SCORE'}_INVALID`,
          errorMessage: `The Sohu article-detail response had an invalid ${field} value.`,
        }),
      }
    }
  }

  const fullBodyText =
    typeof news.content === 'string'
      ? normalizeHtmlText(news.content)
      : undefined

  return {
    kind: 'FOUND',
    detail: {
      status: news.status,
      ...(typeof news.type === 'number' ? { type: news.type } : {}),
      ...(typeof news.secureScore === 'number'
        ? { secureScore: news.secureScore }
        : {}),
      title: normalizeOptionalText(news.title, MAX_TITLE_LENGTH),
      ...(fullBodyText
        ? {
            bodyText: fullBodyText.slice(0, MAX_BODY_TEXT_LENGTH),
            ...(fullBodyText.length > MAX_BODY_TEXT_LENGTH
              ? { bodyTruncated: true }
              : {}),
          }
        : {}),
    },
  }
}

function normalizePublicIdentityUrl(value: string): string | undefined {
  const trimmed = value.trim()
  const withScheme = trimmed.startsWith('//')
    ? `https:${trimmed}`
    : /^www\.sohu\.com\//i.test(trimmed)
      ? `https://${trimmed}`
      : trimmed

  try {
    const url = new URL(withScheme)
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return undefined
    }
    return url.href
  } catch {
    return undefined
  }
}

function extractIdentityMetadata(html: string): {
  canonicalUrls: string[]
  openGraphUrls: string[]
} {
  const canonicalUrls: string[] = []
  const openGraphUrls: string[] = []

  for (const match of html.matchAll(/<(?:link|meta)\b[^>]*>/gi)) {
    const tag = match[0]
    const attributes = parseTagAttributes(tag)
    if (/^<link\b/i.test(tag)) {
      const rel = attributes.get('rel')?.toLowerCase().split(/\s+/) ?? []
      const href = attributes.get('href')
      if (rel.includes('canonical') && href) canonicalUrls.push(href)
      continue
    }

    const property = (
      attributes.get('property') ??
      attributes.get('name') ??
      ''
    ).toLowerCase()
    const content = attributes.get('content')
    if (property === 'og:url' && content) openGraphUrls.push(content)
  }

  return { canonicalUrls, openGraphUrls }
}

function extractJsonLdPayloads(html: string): unknown[] | undefined {
  const payloads: unknown[] = []
  for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    const openingTag = match[0].slice(0, match[0].indexOf('>') + 1)
    if (
      parseTagAttributes(openingTag).get('type')?.toLowerCase() !==
      'application/ld+json'
    ) {
      continue
    }

    try {
      payloads.push(JSON.parse(match[1] ?? ''))
    } catch {
      return undefined
    }
  }
  return payloads
}

function isNewsArticle(value: Record<string, unknown>): boolean {
  const type = value['@type']
  return (
    type === 'NewsArticle' ||
    (Array.isArray(type) && type.includes('NewsArticle'))
  )
}

function collectNewsArticles(payloads: unknown[]): Record<string, unknown>[] {
  const articles: Record<string, unknown>[] = []
  const queue = [...payloads]
  let visited = 0

  while (queue.length > 0 && visited < 10_000) {
    const value = queue.shift()
    visited += 1
    if (Array.isArray(value)) {
      queue.push(...value)
      continue
    }
    if (!isRecord(value)) continue
    if (isNewsArticle(value)) articles.push(value)
    queue.push(...Object.values(value))
  }

  return visited < 10_000 ? articles : []
}

function parsePublishedAt(value: unknown): string | undefined {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/.test(
      value,
    )
  ) {
    return undefined
  }
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined
}

function extractCfgs(html: string):
  | { success: true; newsId: string; mediaId: string; displayMode: string }
  | {
      success: false
      reason: 'CFGS_MISSING' | 'CFGS_DUPLICATE' | 'CFGS_INVALID'
    } {
  const scripts: string[] = []
  for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    const content = match[1] ?? ''
    if (/\bvar\s+cfgs\s*=\s*\{/.test(content)) scripts.push(content)
  }

  if (scripts.length === 0) return { success: false, reason: 'CFGS_MISSING' }
  if (scripts.length !== 1) {
    return { success: false, reason: 'CFGS_DUPLICATE' }
  }

  function valuesFor(key: string): string[] {
    const values: string[] = []
    const pattern = new RegExp(
      `(?:^|[\\r\\n])\\s*${key}\\s*:\\s*(?:["']([^"']*)["']|(\\d+))\\s*,?`,
      'g',
    )
    for (const match of scripts[0].matchAll(pattern)) {
      values.push(match[1] ?? match[2] ?? '')
    }
    return values
  }

  const newsIds = valuesFor('news_id')
  const mediaIds = valuesFor('media_id')
  const displayModes = valuesFor('displayMode')
  if (
    newsIds.length !== 1 ||
    mediaIds.length !== 1 ||
    displayModes.length !== 1 ||
    !/^\d+$/.test(newsIds[0]) ||
    !/^\d+$/.test(mediaIds[0]) ||
    !/^\d+$/.test(displayModes[0])
  ) {
    return { success: false, reason: 'CFGS_INVALID' }
  }

  return {
    success: true,
    newsId: newsIds[0],
    mediaId: mediaIds[0],
    displayMode: displayModes[0],
  }
}

function extractArticleBodies(html: string): string[] {
  const bodies: string[] = []
  const pattern = /<(article|div)\b[^>]*>([\s\S]*?)<\/\1>/gi
  for (const match of html.matchAll(pattern)) {
    const openingTag = match[0].slice(0, match[0].indexOf('>') + 1)
    if (parseTagAttributes(openingTag).get('id') === 'mp-editor') {
      bodies.push(match[2] ?? '')
    }
  }
  return bodies
}

/**
 * Parse the independent evidence emitted by Sohu's public article page.
 * Every identity-bearing surface must agree before publication is accepted.
 */
export function parseSohuPublishedArticleEvidence(
  html: string,
  postId: string,
  accountId: string,
): SohuPublishedEvidenceParseResult {
  const expectedUrl = `${SOHU_PUBLIC_ORIGIN}/a/${postId}_${accountId}`
  const identity = extractIdentityMetadata(html)
  if (
    identity.canonicalUrls.length === 0 ||
    identity.openGraphUrls.length === 0
  ) {
    return { success: false, reason: 'IDENTITY_METADATA_MISSING' }
  }
  if (
    identity.canonicalUrls.length !== 1 ||
    identity.openGraphUrls.length !== 1
  ) {
    return { success: false, reason: 'IDENTITY_METADATA_DUPLICATE' }
  }
  if (
    normalizePublicIdentityUrl(identity.canonicalUrls[0]) !== expectedUrl ||
    normalizePublicIdentityUrl(identity.openGraphUrls[0]) !== expectedUrl
  ) {
    return { success: false, reason: 'IDENTITY_METADATA_MISMATCH' }
  }

  const jsonLdPayloads = extractJsonLdPayloads(html)
  if (!jsonLdPayloads) {
    return { success: false, reason: 'JSON_LD_INVALID' }
  }
  if (jsonLdPayloads.length === 0) {
    return { success: false, reason: 'JSON_LD_MISSING' }
  }

  const articles = collectNewsArticles(jsonLdPayloads)
  if (articles.length === 0) {
    return { success: false, reason: 'NEWS_ARTICLE_MISSING' }
  }
  if (articles.length !== 1) {
    return { success: false, reason: 'NEWS_ARTICLE_DUPLICATE' }
  }

  const article = articles[0]
  const mainEntity = article.mainEntityOfPage
  const mainEntityId = isRecord(mainEntity) ? mainEntity['@id'] : undefined
  if (
    typeof article.url !== 'string' ||
    typeof mainEntityId !== 'string' ||
    normalizePublicIdentityUrl(article.url) !== expectedUrl ||
    normalizePublicIdentityUrl(mainEntityId) !== expectedUrl
  ) {
    return { success: false, reason: 'NEWS_ARTICLE_IDENTITY_MISMATCH' }
  }

  const title =
    typeof article.headline === 'string'
      ? normalizeHtmlText(article.headline).slice(0, MAX_TITLE_LENGTH)
      : ''
  const publishedAt = parsePublishedAt(article.datePublished)
  if (!title || !publishedAt) {
    return { success: false, reason: 'NEWS_ARTICLE_PAYLOAD_INVALID' }
  }

  const cfgs = extractCfgs(html)
  if (!cfgs.success) return cfgs
  if (cfgs.newsId !== postId || cfgs.mediaId !== accountId) {
    return { success: false, reason: 'CFGS_IDENTITY_MISMATCH' }
  }
  if (cfgs.displayMode !== '0') {
    return { success: false, reason: 'DISPLAY_MODE_RESTRICTED' }
  }

  const bodies = extractArticleBodies(html)
  if (bodies.length === 0) {
    return { success: false, reason: 'ARTICLE_BODY_MISSING' }
  }
  if (bodies.length !== 1) {
    return { success: false, reason: 'ARTICLE_BODY_DUPLICATE' }
  }
  const fullBodyText = normalizeHtmlText(bodies[0])
  if (!fullBodyText) {
    return { success: false, reason: 'ARTICLE_BODY_EMPTY' }
  }

  return {
    success: true,
    evidence: {
      title,
      publishedAt,
      bodyText: fullBodyText.slice(0, MAX_BODY_TEXT_LENGTH),
      bodyTruncated: fullBodyText.length > MAX_BODY_TEXT_LENGTH,
    },
  }
}

function evidenceFailureMessage(
  reason: SohuPublishedEvidenceFailureReason,
): string {
  switch (reason) {
    case 'DISPLAY_MODE_RESTRICTED':
      return 'The Sohu article is not publicly visible without restrictions.'
    case 'CFGS_IDENTITY_MISMATCH':
    case 'IDENTITY_METADATA_MISMATCH':
    case 'NEWS_ARTICLE_IDENTITY_MISMATCH':
      return 'The public Sohu page identified a different article or account.'
    case 'ARTICLE_BODY_MISSING':
    case 'ARTICLE_BODY_DUPLICATE':
    case 'ARTICLE_BODY_EMPTY':
      return 'The public Sohu page did not expose one complete article body.'
    default:
      return 'The public Sohu page did not expose complete publication evidence.'
  }
}

async function inspectPublicPage(
  request: PublicationInspectRequest,
  postId: string,
  accountId: string,
  dependencies: SohuInspectionDependencies,
  observedAt: string,
): Promise<PublicationObservation> {
  const publicUrl = `${SOHU_PUBLIC_ORIGIN}/a/${postId}_${accountId}`
  let response: Response
  try {
    response = await dependencies.fetch(publicUrl, {
      method: 'GET',
      credentials: 'omit',
      redirect: 'follow',
      cache: 'no-store',
      headers: {
        Accept: 'text/html,application/xhtml+xml',
      },
    })
  } catch {
    return createObservation(request, observedAt, {
      outcome: 'FETCH_ERROR',
      source: 'PUBLIC_PAGE',
      platformPostId: postId,
      errorCode: 'SOHU_PUBLIC_FETCH_ERROR',
      errorMessage: 'The public Sohu page request failed.',
    })
  }

  if (response.status === 404 || response.status === 410) {
    return createObservation(request, observedAt, {
      outcome: 'REVIEW_REQUIRED',
      source: 'PUBLIC_PAGE',
      platformPostId: postId,
      errorCode: 'SOHU_PUBLIC_PAGE_NOT_VERIFIED',
      errorMessage:
        'Sohu marked the article as published, but its public page was not available.',
    })
  }

  if (!response.ok) {
    return createObservation(request, observedAt, {
      outcome: 'FETCH_ERROR',
      source: 'PUBLIC_PAGE',
      platformPostId: postId,
      errorCode: `SOHU_PUBLIC_HTTP_${response.status}`,
      errorMessage: `Sohu returned HTTP ${response.status} for the public article.`,
    })
  }

  if (response.url !== publicUrl) {
    return createObservation(request, observedAt, {
      outcome: 'REVIEW_REQUIRED',
      source: 'PUBLIC_PAGE',
      platformPostId: postId,
      errorCode: 'SOHU_PUBLIC_RESPONSE_URL_MISMATCH',
      errorMessage:
        'The public Sohu request did not resolve to the expected article URL.',
    })
  }

  if (!contentTypeIsHtml(response)) {
    return createObservation(request, observedAt, {
      outcome: 'REVIEW_REQUIRED',
      source: 'PUBLIC_PAGE',
      platformPostId: postId,
      errorCode: 'SOHU_PUBLIC_UNEXPECTED_CONTENT_TYPE',
      errorMessage: 'Sohu returned a non-HTML public article response.',
    })
  }

  let html: string
  try {
    html = await response.text()
  } catch {
    return createObservation(request, observedAt, {
      outcome: 'FETCH_ERROR',
      source: 'PUBLIC_PAGE',
      platformPostId: postId,
      errorCode: 'SOHU_PUBLIC_BODY_READ_FAILED',
      errorMessage: 'The public Sohu response body could not be read.',
    })
  }

  const parsed = parseSohuPublishedArticleEvidence(html, postId, accountId)
  if (!parsed.success) {
    return createObservation(request, observedAt, {
      outcome: 'REVIEW_REQUIRED',
      source: 'PUBLIC_PAGE',
      platformPostId: postId,
      errorCode: `SOHU_PUBLIC_${parsed.reason}`,
      errorMessage: evidenceFailureMessage(parsed.reason),
    })
  }

  return createObservation(request, observedAt, {
    outcome: 'PUBLISHED',
    source: 'PUBLIC_PAGE',
    platformPostId: postId,
    canonicalUrl: publicUrl,
    title: parsed.evidence.title,
    publishedAt: parsed.evidence.publishedAt,
    bodyText: parsed.evidence.bodyText,
    bodyTruncated: parsed.evidence.bodyTruncated,
  })
}

function detailObservation(
  request: PublicationInspectRequest,
  observedAt: string,
  postId: string,
  detail: SohuArticleDetail,
  outcome: PublicationObservationOutcome,
  error?: { code: string; message: string },
): PublicationObservation {
  return createObservation(request, observedAt, {
    outcome,
    source: 'PLATFORM_DETAIL',
    platformPostId: postId,
    ...(detail.title ? { title: detail.title } : {}),
    ...(detail.bodyText ? { bodyText: detail.bodyText } : {}),
    ...(detail.bodyTruncated ? { bodyTruncated: true } : {}),
    ...(error ? { errorCode: error.code, errorMessage: error.message } : {}),
  })
}

/**
 * Inspect exactly one Sohu article through the stable draft news ID. The
 * inspector never scans or matches by title, and status=4 crosses into
 * PUBLISHED only after independent anonymous public-page verification.
 */
export async function inspectSohuPublication(
  request: PublicationInspectRequest,
  dependencies: SohuInspectionDependencies,
): Promise<PublicationObservation[]> {
  const observedAt = dependencies.now?.() ?? new Date().toISOString()
  const resolution = resolvePostIdentity(request)
  if (!resolution.success) {
    return [
      createObservation(request, observedAt, {
        outcome: resolution.outcome,
        source: 'PLATFORM_DETAIL',
        errorCode: resolution.errorCode,
        errorMessage: resolution.errorMessage,
      }),
    ]
  }

  const { postId, accountId } = resolution
  let auth: AuthResult
  try {
    auth = await dependencies.checkAuth()
  } catch {
    return [
      createObservation(request, observedAt, {
        outcome: 'FETCH_ERROR',
        source: 'PLATFORM_DETAIL',
        platformPostId: postId,
        errorCode: 'SOHU_AUTH_CHECK_FAILED',
        errorMessage: 'The Sohu account check failed.',
      }),
    ]
  }

  if (!auth.isAuthenticated) {
    return [
      createObservation(request, observedAt, {
        outcome: auth.error ? 'FETCH_ERROR' : 'LOGIN_REQUIRED',
        source: 'PLATFORM_DETAIL',
        platformPostId: postId,
        errorCode: auth.error
          ? 'SOHU_AUTH_CHECK_FAILED'
          : 'SOHU_LOGIN_REQUIRED',
        errorMessage: auth.error
          ? 'The Sohu account check failed.'
          : 'Sohu requires an authenticated session.',
      }),
    ]
  }

  if (!auth.userId) {
    return [
      createObservation(request, observedAt, {
        outcome: 'PARSE_ERROR',
        source: 'PLATFORM_DETAIL',
        platformPostId: postId,
        errorCode: 'SOHU_ACCOUNT_ID_MISSING',
        errorMessage: 'The authenticated Sohu account has no stable ID.',
      }),
    ]
  }

  const hasAuthenticatedAccount = dependencies.hasAuthenticatedAccount
    ? dependencies.hasAuthenticatedAccount(accountId)
    : auth.userId === accountId
  if (!hasAuthenticatedAccount) {
    return [
      createObservation(request, observedAt, {
        outcome: 'ACCOUNT_MISMATCH',
        source: 'PLATFORM_DETAIL',
        platformPostId: postId,
        errorCode: 'ACCOUNT_MISMATCH',
        errorMessage:
          'The active Sohu account does not match the bound account.',
      }),
    ]
  }

  const detailProbe = await fetchArticleDetail(
    request,
    postId,
    accountId,
    dependencies,
    observedAt,
  )
  if (detailProbe.kind === 'OBSERVATION') {
    return [detailProbe.observation]
  }

  const { detail } = detailProbe
  switch (detail.status) {
    case 1:
      return [
        detailObservation(request, observedAt, postId, detail, 'DRAFT_PRESENT'),
      ]
    case 2:
      return [
        detailObservation(
          request,
          observedAt,
          postId,
          detail,
          'PENDING_REVIEW',
        ),
      ]
    case 3:
      return [
        detailObservation(request, observedAt, postId, detail, 'REJECTED'),
      ]
    case 4:
      if (detail.type === 30) {
        return [
          detailObservation(
            request,
            observedAt,
            postId,
            detail,
            'REVIEW_REQUIRED',
            {
              code: 'SOHU_UNSUPPORTED_ARTICLE_TYPE',
              message:
                'Sohu uses a separate public host for this article type; automatic public verification currently supports ordinary graphic articles only.',
            },
          ),
        ]
      }
      if (detail.secureScore === 10) {
        return [
          detailObservation(
            request,
            observedAt,
            postId,
            detail,
            'REVIEW_REQUIRED',
            {
              code: 'SOHU_SECURE_PUBLIC_ROUTE_REVIEW_REQUIRED',
              message:
                'Sohu marked this article as using a protected public route, which requires manual verification.',
            },
          ),
        ]
      }
      return [
        await inspectPublicPage(
          request,
          postId,
          accountId,
          dependencies,
          observedAt,
        ),
      ]
    case 5:
      return [
        detailObservation(request, observedAt, postId, detail, 'SCHEDULED'),
      ]
    case 7:
    case 9:
      return [detailObservation(request, observedAt, postId, detail, 'DELETED')]
    case 16:
      return [
        detailObservation(
          request,
          observedAt,
          postId,
          detail,
          'REVIEW_REQUIRED',
          {
            code: 'SOHU_STATUS_REVIEW_REQUIRED',
            message:
              'Sohu reported a second-review state that does not prove public publication.',
          },
        ),
      ]
    default:
      return [
        detailObservation(
          request,
          observedAt,
          postId,
          detail,
          'REVIEW_REQUIRED',
          {
            code: 'SOHU_STATUS_UNKNOWN',
            message:
              'Sohu returned an unknown publication status that requires review.',
          },
        ),
      ]
  }
}
