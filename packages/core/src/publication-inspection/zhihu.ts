import type { AuthResult } from '../types'
import type {
  PublicationInspectionEvidenceSource as PublicationObservationSource,
  PublicationInspectionObservation as PublicationObservation,
  PublicationInspectionOutcome as PublicationObservationOutcome,
  PublicationInspectionPublicAccess as PublicationPublicAccess,
  PublicationInspectionRequest as PublicationInspectRequest,
} from './domain'
import { PublicationInspectionObservationSchema } from './domain'
import { normalizeHtmlText, parseTagAttributes } from './html'
import { derivePublicationPublicIdentity, parsePublicationUrl } from './url'

const ZHIHU_PUBLIC_ORIGIN = 'https://zhuanlan.zhihu.com'
const ZHIHU_SOFT_NOT_FOUND_TITLE = '你似乎来到了没有知识存在的荒原 - 知乎'
const MAX_TITLE_LENGTH = 500
const MAX_BODY_TEXT_LENGTH = 50_000

export interface ZhihuInspectionDependencies {
  checkAuth(): Promise<AuthResult>
  fetch(url: string, options?: RequestInit): Promise<Response>
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
  publicAccess?: PublicationPublicAccess
  errorCode?: string
  errorMessage?: string
}

interface PageContent {
  html: string
  responseUrl: string
  checkedAt: string
  httpStatus: number
}

type PublishedPageSource = 'PUBLIC_PAGE' | 'AUTHENTICATED_PUBLIC_PAGE'

type PageProbe =
  | { kind: 'FOUND'; page: PageContent }
  | { kind: 'NOT_FOUND' }
  | {
      kind: 'ACCESS_DENIED'
      observation: PublicationObservation
      publicAccess?: Extract<
        PublicationPublicAccess,
        { status: 'BLOCKED_BY_PLATFORM' }
      >
    }
  | { kind: 'OBSERVATION'; observation: PublicationObservation }

interface DraftContent {
  title: string
  bodyText: string
  bodyTruncated: boolean
}

export interface ZhihuPublishedArticleEvidence {
  postId: string
  authorId: string
  title: string
  publishedAt: string
  bodyText: string
  bodyTruncated: boolean
}

export type ZhihuPublishedEvidenceFailureReason =
  | 'INITIAL_DATA_MISSING'
  | 'INITIAL_DATA_DUPLICATE'
  | 'INITIAL_DATA_INVALID'
  | 'ARTICLE_MISSING'
  | 'ARTICLE_ID_MISMATCH'
  | 'AUTHOR_ID_MISSING'
  | 'PUBLICATION_STATE_UNVERIFIED'
  | 'PUBLISHED_AT_INVALID'
  | 'ARTICLE_PAYLOAD_MISSING'

export type ZhihuPublishedEvidenceParseResult =
  | { success: true; evidence: ZhihuPublishedArticleEvidence }
  | { success: false; reason: ZhihuPublishedEvidenceFailureReason }

export type ZhihuPublishedEvidenceDecision =
  | { outcome: 'PUBLISHED'; evidence: ZhihuPublishedArticleEvidence }
  | {
      outcome: 'REVIEW_REQUIRED' | 'ACCOUNT_MISMATCH' | 'PARSE_ERROR'
      errorCode: string
      errorMessage: string
    }

type DraftProbe =
  | { kind: 'FOUND'; draft: DraftContent }
  | { kind: 'NOT_FOUND' }
  | { kind: 'OBSERVATION'; observation: PublicationObservation }

type PostIdResolution =
  | { success: true; postId: string }
  | {
      success: false
      outcome: 'UNSUPPORTED' | 'PARSE_ERROR'
      errorCode: string
      errorMessage: string
    }

function createObservation(
  request: PublicationInspectRequest,
  observedAt: string,
  details: ObservationDetails,
): PublicationObservation {
  return PublicationInspectionObservationSchema.parse({
    observationKey: `zhihu:${request.requestId}:${details.source}:${details.outcome}`,
    platform: 'zhihu',
    externalAccountId: request.externalAccountId,
    observedAt,
    ...details,
  })
}

function resolvePostId(request: PublicationInspectRequest): PostIdResolution {
  if (request.platform !== 'zhihu') {
    return {
      success: false,
      outcome: 'UNSUPPORTED',
      errorCode: 'ZHIHU_PLATFORM_REQUIRED',
      errorMessage: 'The Zhihu inspector only accepts Zhihu requests.',
    }
  }

  const platformPostId = request.draft.platformPostId?.trim()
  if (platformPostId && !/^\d+$/.test(platformPostId)) {
    return {
      success: false,
      outcome: 'PARSE_ERROR',
      errorCode: 'ZHIHU_INVALID_POST_ID',
      errorMessage: 'The Zhihu post ID must contain digits only.',
    }
  }

  let draftUrlPostId: string | undefined
  if (request.draft.draftUrl) {
    const parsedDraftUrl = parsePublicationUrl('zhihu', request.draft.draftUrl)
    if (
      !parsedDraftUrl ||
      parsedDraftUrl.surface !== 'DRAFT' ||
      !parsedDraftUrl.postId
    ) {
      return {
        success: false,
        outcome: 'PARSE_ERROR',
        errorCode: 'ZHIHU_INVALID_DRAFT_URL',
        errorMessage: 'The draft URL is not a verified Zhihu editor URL.',
      }
    }
    draftUrlPostId = parsedDraftUrl.postId
  }

  if (platformPostId && draftUrlPostId && platformPostId !== draftUrlPostId) {
    return {
      success: false,
      outcome: 'PARSE_ERROR',
      errorCode: 'ZHIHU_POST_ID_CONFLICT',
      errorMessage:
        'The Zhihu post ID and draft URL identify different articles.',
    }
  }

  const postId = platformPostId ?? draftUrlPostId
  if (!postId) {
    return {
      success: false,
      outcome: 'UNSUPPORTED',
      errorCode: 'ZHIHU_POST_ID_REQUIRED',
      errorMessage:
        'Exact Zhihu inspection requires a post ID or verified draft URL.',
    }
  }

  return { success: true, postId }
}

function isSignInUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (
      url.hostname === 'www.zhihu.com' &&
      url.pathname.replace(/\/+$/, '') === '/signin'
    )
  } catch {
    return false
  }
}

function extractIdentityUrls(html: string): string[] {
  const urls: string[] = []
  for (const match of html.matchAll(/<(?:link|meta)\b[^>]*>/gi)) {
    const tag = match[0]
    const attributes = parseTagAttributes(tag)

    if (/^<link\b/i.test(tag)) {
      const rel = attributes.get('rel')?.toLowerCase().split(/\s+/) ?? []
      const href = attributes.get('href')
      if (rel.includes('canonical') && href) urls.push(href)
      continue
    }

    const property = (
      attributes.get('property') ??
      attributes.get('name') ??
      ''
    ).toLowerCase()
    const content = attributes.get('content')
    if (property === 'og:url' && content) urls.push(content)
  }

  return [...new Set(urls)]
}

function hasExpectedIdentity(
  html: string,
  postId: string,
  surface: 'PUBLISHED' | 'DRAFT',
): boolean {
  const identityUrls = extractIdentityUrls(html)
  if (identityUrls.length === 0) return false

  return identityUrls.every((identityUrl) => {
    const parsed = parsePublicationUrl('zhihu', identityUrl)
    if (!parsed || parsed.postId !== postId || parsed.surface === 'UNKNOWN') {
      return false
    }

    // A draft editor may declare either its editor URL or the corresponding
    // public canonical URL. The final response URL still has to be /edit.
    return surface === 'DRAFT' || parsed.surface === 'PUBLISHED'
  })
}

function normalizeText(value: string): string {
  return normalizeHtmlText(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function extractJsonScriptContents(html: string, id: string): string[] {
  const contents: string[] = []
  for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    const tag = match[0].slice(0, match[0].indexOf('>') + 1)
    if (parseTagAttributes(tag).get('id') === id) {
      contents.push(match[1] ?? '')
    }
  }
  return contents
}

function unixSecondsToIso(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return undefined
  }

  const date = new Date(value * 1_000)
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined
}

/**
 * Parse the structured article entity currently emitted by Zhihu's official
 * public article frontend in #js-initialData. This parser is deliberately pure
 * and fail-closed: canonical metadata alone is not publication evidence.
 */
export function parseZhihuPublishedArticleEvidence(
  html: string,
  postId: string,
): ZhihuPublishedEvidenceParseResult {
  const initialDataScripts = extractJsonScriptContents(html, 'js-initialData')
  if (initialDataScripts.length === 0) {
    return { success: false, reason: 'INITIAL_DATA_MISSING' }
  }
  if (initialDataScripts.length !== 1) {
    return { success: false, reason: 'INITIAL_DATA_DUPLICATE' }
  }

  let payload: unknown
  try {
    payload = JSON.parse(initialDataScripts[0])
  } catch {
    return { success: false, reason: 'INITIAL_DATA_INVALID' }
  }

  if (!isRecord(payload)) {
    return { success: false, reason: 'INITIAL_DATA_INVALID' }
  }

  const initialState = payload.initialState
  const entities = isRecord(initialState) ? initialState.entities : undefined
  const articles = isRecord(entities) ? entities.articles : undefined
  if (
    !isRecord(articles) ||
    !Object.prototype.hasOwnProperty.call(articles, postId)
  ) {
    return { success: false, reason: 'ARTICLE_MISSING' }
  }

  const article = articles[postId]
  if (!isRecord(article)) {
    return { success: false, reason: 'ARTICLE_MISSING' }
  }
  if (typeof article.id !== 'string' || article.id !== postId) {
    return { success: false, reason: 'ARTICLE_ID_MISMATCH' }
  }

  const author = article.author
  const authorId =
    isRecord(author) && typeof author.id === 'string' ? author.id.trim() : ''
  if (!authorId) {
    return { success: false, reason: 'AUTHOR_ID_MISSING' }
  }

  const structuredUrl =
    typeof article.url === 'string'
      ? parsePublicationUrl('zhihu', article.url)
      : null
  if (
    article.type !== 'article' ||
    article.articleType !== 'normal' ||
    article.state !== 'published' ||
    article.status !== 0 ||
    article.isVisible !== true ||
    article.isNormal !== true ||
    structuredUrl?.surface !== 'PUBLISHED' ||
    structuredUrl.postId !== postId
  ) {
    return { success: false, reason: 'PUBLICATION_STATE_UNVERIFIED' }
  }

  const publishedAt = unixSecondsToIso(article.created)
  if (!publishedAt) {
    return { success: false, reason: 'PUBLISHED_AT_INVALID' }
  }

  const title =
    typeof article.title === 'string' ? normalizeText(article.title) : ''
  const fullBodyText =
    typeof article.content === 'string' ? normalizeText(article.content) : ''
  if (!title || !fullBodyText) {
    return { success: false, reason: 'ARTICLE_PAYLOAD_MISSING' }
  }

  return {
    success: true,
    evidence: {
      postId,
      authorId,
      title: title.slice(0, MAX_TITLE_LENGTH),
      publishedAt,
      bodyText: fullBodyText.slice(0, MAX_BODY_TEXT_LENGTH),
      bodyTruncated: fullBodyText.length > MAX_BODY_TEXT_LENGTH,
    },
  }
}

/** Decide whether structured public evidence is strong enough to cross the boundary. */
export function decideZhihuPublishedEvidence(
  parsed: ZhihuPublishedEvidenceParseResult,
  expectedAccountId: string,
): ZhihuPublishedEvidenceDecision {
  if (!parsed.success) {
    switch (parsed.reason) {
      case 'INITIAL_DATA_MISSING':
      case 'ARTICLE_MISSING':
        return {
          outcome: 'REVIEW_REQUIRED',
          errorCode: 'ZHIHU_PUBLIC_DETAIL_MISSING',
          errorMessage:
            'The public Zhihu page did not expose structured article detail.',
        }
      case 'AUTHOR_ID_MISSING':
        return {
          outcome: 'REVIEW_REQUIRED',
          errorCode: 'ZHIHU_PUBLIC_AUTHOR_ID_MISSING',
          errorMessage:
            'The public Zhihu article did not expose a stable author ID.',
        }
      case 'PUBLICATION_STATE_UNVERIFIED':
        return {
          outcome: 'REVIEW_REQUIRED',
          errorCode: 'ZHIHU_PUBLICATION_STATE_UNVERIFIED',
          errorMessage:
            'The structured Zhihu article state did not prove a public publication.',
        }
      case 'PUBLISHED_AT_INVALID':
        return {
          outcome: 'REVIEW_REQUIRED',
          errorCode: 'ZHIHU_PUBLIC_PUBLISHED_AT_INVALID',
          errorMessage:
            'The public Zhihu article lacked a valid publication timestamp.',
        }
      case 'ARTICLE_PAYLOAD_MISSING':
        return {
          outcome: 'REVIEW_REQUIRED',
          errorCode: 'ZHIHU_PUBLIC_ARTICLE_PAYLOAD_MISSING',
          errorMessage:
            'The public Zhihu article lacked a complete structured article payload.',
        }
      default:
        return {
          outcome: 'PARSE_ERROR',
          errorCode: 'ZHIHU_PUBLIC_DETAIL_INVALID',
          errorMessage:
            'The public Zhihu article detail had an invalid structure.',
        }
    }
  }

  if (parsed.evidence.authorId !== expectedAccountId.trim()) {
    return {
      outcome: 'ACCOUNT_MISMATCH',
      errorCode: 'ZHIHU_PUBLIC_AUTHOR_MISMATCH',
      errorMessage:
        'The public Zhihu article does not belong to the bound account.',
    }
  }

  return { outcome: 'PUBLISHED', evidence: parsed.evidence }
}

function extractDocumentTitle(html: string): string | undefined {
  const titleMatch = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)
  const normalized = normalizeText(titleMatch?.[1] ?? '')
  return normalized || undefined
}

function isStrictSoftNotFoundPage(html: string): boolean {
  return (
    extractIdentityUrls(html).length === 0 &&
    !/<article\b[^>]*>/i.test(html) &&
    extractDocumentTitle(html) === ZHIHU_SOFT_NOT_FOUND_TITLE
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

function contentTypeIsJson(response: Response): boolean {
  const contentType = response.headers.get('content-type')?.toLowerCase()
  return Boolean(
    contentType &&
    (contentType.includes('application/json') || contentType.includes('+json')),
  )
}

async function fetchPage(
  request: PublicationInspectRequest,
  postId: string,
  source: PublishedPageSource,
  url: string,
  dependencies: ZhihuInspectionDependencies,
  observedAt: string,
  credentials: 'omit' | 'include',
): Promise<PageProbe> {
  let response: Response
  try {
    response = await dependencies.fetch(url, {
      method: 'GET',
      credentials,
      redirect: 'follow',
      cache: 'no-store',
      headers: {
        Accept: 'text/html,application/xhtml+xml',
      },
    })
  } catch {
    return {
      kind: 'OBSERVATION',
      observation: createObservation(request, observedAt, {
        outcome: 'FETCH_ERROR',
        source,
        platformPostId: postId,
        errorCode: 'ZHIHU_FETCH_ERROR',
        errorMessage: 'The Zhihu page request failed.',
      }),
    }
  }

  if (isSignInUrl(response.url) || response.status === 401) {
    return {
      kind: 'OBSERVATION',
      observation: createObservation(request, observedAt, {
        outcome: 'LOGIN_REQUIRED',
        source,
        platformPostId: postId,
        errorCode: 'ZHIHU_LOGIN_REQUIRED',
        errorMessage: 'Zhihu requires an authenticated session.',
      }),
    }
  }

  if (response.status === 404) return { kind: 'NOT_FOUND' }

  if (response.status === 429) {
    return {
      kind: 'OBSERVATION',
      observation: createObservation(request, observedAt, {
        outcome: 'FETCH_ERROR',
        source,
        platformPostId: postId,
        errorCode: 'ZHIHU_RATE_LIMITED',
        errorMessage: 'Zhihu rate-limited the inspection request.',
      }),
    }
  }

  if (response.status === 403) {
    const checkedIdentity = derivePublicationPublicIdentity(
      'zhihu',
      response.url,
    )
    if (!checkedIdentity) {
      return {
        kind: 'OBSERVATION',
        observation: createObservation(request, observedAt, {
          outcome: 'PARSE_ERROR',
          source,
          platformPostId: postId,
          errorCode: 'ZHIHU_UNEXPECTED_PUBLIC_PAGE',
          errorMessage:
            'The denied Zhihu response did not identify the expected public article.',
        }),
      }
    }
    const checkedAt = dependencies.now?.() ?? new Date().toISOString()
    return {
      kind: 'ACCESS_DENIED',
      observation: createObservation(request, observedAt, {
        outcome: 'FETCH_ERROR',
        source,
        platformPostId: postId,
        errorCode:
          credentials === 'include'
            ? 'ZHIHU_AUTHENTICATED_HTTP_403'
            : 'ZHIHU_HTTP_403',
        errorMessage:
          credentials === 'include'
            ? 'Zhihu denied the authenticated inspection request.'
            : 'Zhihu denied the anonymous inspection request.',
      }),
      ...(credentials === 'omit'
        ? {
            publicAccess: {
              status: 'BLOCKED_BY_PLATFORM' as const,
              checkedUrl: response.url,
              checkedPublicIdentityKey: checkedIdentity.key,
              checkedAt,
              httpStatus: response.status,
              reasonCode: 'ZHIHU_ANONYMOUS_HTTP_403',
            },
          }
        : {}),
    }
  }

  if (!response.ok) {
    return {
      kind: 'OBSERVATION',
      observation: createObservation(request, observedAt, {
        outcome: 'FETCH_ERROR',
        source,
        platformPostId: postId,
        errorCode: `ZHIHU_HTTP_${response.status}`,
        errorMessage: `Zhihu returned HTTP ${response.status}.`,
      }),
    }
  }

  if (!contentTypeIsHtml(response)) {
    return {
      kind: 'OBSERVATION',
      observation: createObservation(request, observedAt, {
        outcome: 'PARSE_ERROR',
        source,
        platformPostId: postId,
        errorCode: 'ZHIHU_UNEXPECTED_CONTENT_TYPE',
        errorMessage: 'Zhihu returned a non-HTML response.',
      }),
    }
  }

  try {
    const html = await response.text()
    return {
      kind: 'FOUND',
      page: {
        html,
        responseUrl: response.url,
        checkedAt: dependencies.now?.() ?? new Date().toISOString(),
        httpStatus: response.status,
      },
    }
  } catch {
    return {
      kind: 'OBSERVATION',
      observation: createObservation(request, observedAt, {
        outcome: 'FETCH_ERROR',
        source,
        platformPostId: postId,
        errorCode: 'ZHIHU_BODY_READ_FAILED',
        errorMessage: 'The Zhihu response body could not be read.',
      }),
    }
  }
}

/**
 * Convert a fetched Zhihu article page into one strict publication
 * observation. A valid soft-not-found page returns null so the caller can
 * continue with the authenticated draft-detail probe.
 *
 * AUTHENTICATED_PUBLIC_PAGE means the same canonical article URL was fetched
 * with the bound account after Zhihu returned HTTP 403 anonymously. The
 * publication fact remains PUBLISHED when the authenticated page proves the
 * complete article state, while publicAccess records that anonymous access
 * could not be confirmed automatically.
 */
function inspectPublishedPage(
  request: PublicationInspectRequest,
  postId: string,
  page: PageContent,
  source: PublishedPageSource,
  observedAt: string,
  blockedPublicAccess?: Extract<
    PublicationPublicAccess,
    { status: 'BLOCKED_BY_PLATFORM' }
  >,
): PublicationObservation | null {
  if (!responseUrlMatches(page.responseUrl, postId, 'PUBLISHED')) {
    return createObservation(request, observedAt, {
      outcome: 'PARSE_ERROR',
      source,
      platformPostId: postId,
      errorCode: 'ZHIHU_UNEXPECTED_PUBLIC_PAGE',
      errorMessage:
        'The public page did not prove the expected Zhihu article identity.',
    })
  }

  const hasNotFoundTitle =
    extractDocumentTitle(page.html) === ZHIHU_SOFT_NOT_FOUND_TITLE
  if (hasNotFoundTitle) {
    if (!isStrictSoftNotFoundPage(page.html)) {
      return createObservation(request, observedAt, {
        outcome: 'PARSE_ERROR',
        source,
        platformPostId: postId,
        errorCode: 'ZHIHU_UNEXPECTED_PUBLIC_PAGE',
        errorMessage: 'The public page had contradictory not-found markers.',
      })
    }
    return null
  }

  if (!hasExpectedIdentity(page.html, postId, 'PUBLISHED')) {
    return createObservation(request, observedAt, {
      outcome: 'PARSE_ERROR',
      source,
      platformPostId: postId,
      errorCode: 'ZHIHU_UNEXPECTED_PUBLIC_PAGE',
      errorMessage:
        'The public page did not prove the expected Zhihu article identity.',
    })
  }

  const decision = decideZhihuPublishedEvidence(
    parseZhihuPublishedArticleEvidence(page.html, postId),
    request.externalAccountId,
  )
  if (decision.outcome !== 'PUBLISHED') {
    return createObservation(request, observedAt, {
      outcome: decision.outcome,
      source,
      platformPostId: postId,
      errorCode: decision.errorCode,
      errorMessage: decision.errorMessage,
    })
  }

  const publicIdentity = derivePublicationPublicIdentity(
    'zhihu',
    page.responseUrl,
  )
  if (
    !publicIdentity ||
    (source === 'AUTHENTICATED_PUBLIC_PAGE' && !blockedPublicAccess)
  ) {
    return createObservation(request, observedAt, {
      outcome: 'PARSE_ERROR',
      source,
      platformPostId: postId,
      errorCode: 'ZHIHU_PUBLIC_ACCESS_EVIDENCE_INVALID',
      errorMessage:
        'The Zhihu public-access check did not produce complete identity evidence.',
    })
  }

  return createObservation(request, observedAt, {
    outcome: 'PUBLISHED',
    source,
    platformPostId: postId,
    canonicalUrl: publicIdentity.canonicalUrl,
    title: decision.evidence.title,
    publishedAt: decision.evidence.publishedAt,
    bodyText: decision.evidence.bodyText,
    bodyTruncated: decision.evidence.bodyTruncated,
    publicAccess:
      source === 'PUBLIC_PAGE'
        ? {
            status: 'CONFIRMED',
            checkedUrl: page.responseUrl,
            checkedPublicIdentityKey: publicIdentity.key,
            checkedAt: page.checkedAt,
            httpStatus: page.httpStatus,
          }
        : blockedPublicAccess,
  })
}

async function fetchDraft(
  request: PublicationInspectRequest,
  postId: string,
  dependencies: ZhihuInspectionDependencies,
  observedAt: string,
): Promise<DraftProbe> {
  const draftApiUrl = `${ZHIHU_PUBLIC_ORIGIN}/api/articles/${postId}/draft`
  let response: Response
  try {
    response = await dependencies.fetch(draftApiUrl, {
      method: 'GET',
      credentials: 'include',
      redirect: 'error',
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        'x-requested-with': 'fetch',
      },
    })
  } catch {
    return {
      kind: 'OBSERVATION',
      observation: createObservation(request, observedAt, {
        outcome: 'FETCH_ERROR',
        source: 'DRAFT_DETAIL',
        platformPostId: postId,
        errorCode: 'ZHIHU_DRAFT_FETCH_ERROR',
        errorMessage: 'The Zhihu draft-detail request failed.',
      }),
    }
  }

  if (isSignInUrl(response.url) || response.status === 401) {
    return {
      kind: 'OBSERVATION',
      observation: createObservation(request, observedAt, {
        outcome: 'LOGIN_REQUIRED',
        source: 'DRAFT_DETAIL',
        platformPostId: postId,
        errorCode: 'ZHIHU_LOGIN_REQUIRED',
        errorMessage: 'Zhihu requires an authenticated session.',
      }),
    }
  }

  if (response.url !== draftApiUrl) {
    return {
      kind: 'OBSERVATION',
      observation: createObservation(request, observedAt, {
        outcome: 'PARSE_ERROR',
        source: 'DRAFT_DETAIL',
        platformPostId: postId,
        errorCode: 'ZHIHU_DRAFT_UNEXPECTED_RESPONSE_URL',
        errorMessage:
          'The Zhihu draft-detail response came from an unexpected URL.',
      }),
    }
  }

  if (response.status === 404) return { kind: 'NOT_FOUND' }

  if (response.status === 429) {
    return {
      kind: 'OBSERVATION',
      observation: createObservation(request, observedAt, {
        outcome: 'FETCH_ERROR',
        source: 'DRAFT_DETAIL',
        platformPostId: postId,
        errorCode: 'ZHIHU_DRAFT_RATE_LIMITED',
        errorMessage: 'Zhihu rate-limited the draft-detail request.',
      }),
    }
  }

  if (response.status === 403) {
    return {
      kind: 'OBSERVATION',
      observation: createObservation(request, observedAt, {
        outcome: 'FETCH_ERROR',
        source: 'DRAFT_DETAIL',
        platformPostId: postId,
        errorCode: 'ZHIHU_DRAFT_HTTP_403',
        errorMessage: 'Zhihu denied the draft-detail request.',
      }),
    }
  }

  if (!response.ok) {
    return {
      kind: 'OBSERVATION',
      observation: createObservation(request, observedAt, {
        outcome: 'FETCH_ERROR',
        source: 'DRAFT_DETAIL',
        platformPostId: postId,
        errorCode: `ZHIHU_DRAFT_HTTP_${response.status}`,
        errorMessage: `Zhihu returned HTTP ${response.status} for the draft-detail request.`,
      }),
    }
  }

  if (!contentTypeIsJson(response)) {
    return {
      kind: 'OBSERVATION',
      observation: createObservation(request, observedAt, {
        outcome: 'PARSE_ERROR',
        source: 'DRAFT_DETAIL',
        platformPostId: postId,
        errorCode: 'ZHIHU_DRAFT_UNEXPECTED_CONTENT_TYPE',
        errorMessage: 'Zhihu returned a non-JSON draft-detail response.',
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
        source: 'DRAFT_DETAIL',
        platformPostId: postId,
        errorCode: 'ZHIHU_DRAFT_JSON_INVALID',
        errorMessage: 'The Zhihu draft-detail response was not valid JSON.',
      }),
    }
  }

  if (
    typeof payload !== 'object' ||
    payload === null ||
    Array.isArray(payload)
  ) {
    return {
      kind: 'OBSERVATION',
      observation: createObservation(request, observedAt, {
        outcome: 'PARSE_ERROR',
        source: 'DRAFT_DETAIL',
        platformPostId: postId,
        errorCode: 'ZHIHU_DRAFT_RESPONSE_INVALID',
        errorMessage: 'The Zhihu draft-detail response had an invalid shape.',
      }),
    }
  }

  const draft = payload as Record<string, unknown>
  if (typeof draft.id !== 'string' || draft.id !== postId) {
    return {
      kind: 'OBSERVATION',
      observation: createObservation(request, observedAt, {
        outcome: 'PARSE_ERROR',
        source: 'DRAFT_DETAIL',
        platformPostId: postId,
        errorCode: 'ZHIHU_DRAFT_ID_MISMATCH',
        errorMessage:
          'The Zhihu draft-detail response identified a different article.',
      }),
    }
  }

  if (typeof draft.title !== 'string' || typeof draft.content !== 'string') {
    return {
      kind: 'OBSERVATION',
      observation: createObservation(request, observedAt, {
        outcome: 'PARSE_ERROR',
        source: 'DRAFT_DETAIL',
        platformPostId: postId,
        errorCode: 'ZHIHU_DRAFT_RESPONSE_INVALID',
        errorMessage:
          'The Zhihu draft-detail response lacked title or content.',
      }),
    }
  }

  const title = normalizeText(draft.title)
  const fullBodyText = normalizeText(draft.content)
  if (!title || !fullBodyText) {
    return {
      kind: 'OBSERVATION',
      observation: createObservation(request, observedAt, {
        outcome: 'PARSE_ERROR',
        source: 'DRAFT_DETAIL',
        platformPostId: postId,
        errorCode: 'ZHIHU_DRAFT_RESPONSE_INVALID',
        errorMessage:
          'The Zhihu draft-detail response had empty title or content.',
      }),
    }
  }

  return {
    kind: 'FOUND',
    draft: {
      title: title.slice(0, MAX_TITLE_LENGTH),
      bodyText: fullBodyText.slice(0, MAX_BODY_TEXT_LENGTH),
      bodyTruncated: fullBodyText.length > MAX_BODY_TEXT_LENGTH,
    },
  }
}

function responseUrlMatches(
  responseUrl: string,
  postId: string,
  surface: 'PUBLISHED' | 'DRAFT',
): boolean {
  const parsed = parsePublicationUrl('zhihu', responseUrl)
  return parsed?.surface === surface && parsed.postId === postId
}

/**
 * Inspect a Zhihu article only through the stable article ID created during
 * draft delivery. This deliberately does not scan drafts or published lists.
 */
export async function inspectZhihuPublication(
  request: PublicationInspectRequest,
  dependencies: ZhihuInspectionDependencies,
): Promise<PublicationObservation[]> {
  const observedAt = dependencies.now?.() ?? new Date().toISOString()
  const resolution = resolvePostId(request)
  if (!resolution.success) {
    return [
      createObservation(request, observedAt, {
        outcome: resolution.outcome,
        source: 'DRAFT_DETAIL',
        errorCode: resolution.errorCode,
        errorMessage: resolution.errorMessage,
      }),
    ]
  }

  const { postId } = resolution
  let auth: AuthResult
  try {
    auth = await dependencies.checkAuth()
  } catch {
    return [
      createObservation(request, observedAt, {
        outcome: 'FETCH_ERROR',
        source: 'PLATFORM_DETAIL',
        platformPostId: postId,
        errorCode: 'ZHIHU_AUTH_CHECK_FAILED',
        errorMessage: 'The Zhihu account check failed.',
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
          ? 'ZHIHU_AUTH_CHECK_FAILED'
          : 'ZHIHU_LOGIN_REQUIRED',
        errorMessage: auth.error
          ? 'The Zhihu account check failed.'
          : 'Zhihu requires an authenticated session.',
      }),
    ]
  }

  if (!auth.userId) {
    return [
      createObservation(request, observedAt, {
        outcome: 'PARSE_ERROR',
        source: 'PLATFORM_DETAIL',
        platformPostId: postId,
        errorCode: 'ZHIHU_ACCOUNT_ID_MISSING',
        errorMessage: 'The authenticated Zhihu account has no stable ID.',
      }),
    ]
  }

  if (auth.userId !== request.externalAccountId) {
    return [
      createObservation(request, observedAt, {
        outcome: 'ACCOUNT_MISMATCH',
        source: 'PLATFORM_DETAIL',
        platformPostId: postId,
        errorCode: 'ACCOUNT_MISMATCH',
        errorMessage:
          'The active Zhihu account does not match the bound account.',
      }),
    ]
  }

  const publicUrl = `${ZHIHU_PUBLIC_ORIGIN}/p/${postId}`
  let publishedPageSource: PublishedPageSource = 'PUBLIC_PAGE'
  let blockedPublicAccess:
    | Extract<PublicationPublicAccess, { status: 'BLOCKED_BY_PLATFORM' }>
    | undefined
  let deferredPublicAccessDenied: PublicationObservation | undefined
  let publicProbe = await fetchPage(
    request,
    postId,
    publishedPageSource,
    publicUrl,
    dependencies,
    observedAt,
    'omit',
  )

  if (publicProbe.kind === 'ACCESS_DENIED') {
    blockedPublicAccess = publicProbe.publicAccess
    publishedPageSource = 'AUTHENTICATED_PUBLIC_PAGE'
    publicProbe = await fetchPage(
      request,
      postId,
      publishedPageSource,
      publicUrl,
      dependencies,
      observedAt,
      'include',
    )
  }

  if (publicProbe.kind === 'OBSERVATION') {
    return [publicProbe.observation]
  }

  // A newly created draft can have no readable public surface yet while
  // Zhihu rejects both anonymous and credentialed requests to /p/<id>. That
  // denial is not positive draft evidence, so keep it as a deferred failure
  // and let the exact authenticated draft endpoint decide first.
  if (publicProbe.kind === 'ACCESS_DENIED') {
    deferredPublicAccessDenied = publicProbe.observation
  }

  if (publicProbe.kind === 'FOUND') {
    const publishedObservedAt = dependencies.now?.() ?? new Date().toISOString()
    const observation = inspectPublishedPage(
      request,
      postId,
      publicProbe.page,
      publishedPageSource,
      publishedObservedAt,
      blockedPublicAccess,
    )
    if (observation) return [observation]
  }

  const draftProbe = await fetchDraft(request, postId, dependencies, observedAt)

  if (draftProbe.kind === 'OBSERVATION') {
    return [draftProbe.observation]
  }

  if (draftProbe.kind === 'NOT_FOUND') {
    if (deferredPublicAccessDenied) {
      return [deferredPublicAccessDenied]
    }
    return [
      createObservation(request, observedAt, {
        outcome: 'NOT_FOUND',
        source: 'DRAFT_DETAIL',
        platformPostId: postId,
      }),
    ]
  }

  return [
    createObservation(request, observedAt, {
      outcome: 'DRAFT_PRESENT',
      source: 'DRAFT_DETAIL',
      platformPostId: postId,
      title: draftProbe.draft.title,
      bodyText: draftProbe.draft.bodyText,
      ...(draftProbe.draft.bodyTruncated ? { bodyTruncated: true } : {}),
    }),
  ]
}
