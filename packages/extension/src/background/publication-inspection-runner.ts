import type { PlatformAdapter } from '@wechatsync/core'
import {
  parsePublicationUrl,
  PublicationInspectionObservationSchema,
  PublicationInspectionRequestSchema,
  resolveWeixinAppMsgId,
  TOUTIAO_ANONYMOUS_BLOCKED_REASONS,
  type PublicationInspectionObservation,
  type PublicationInspectionOutcome,
  type PublicationInspectionPlatform,
  type PublicationInspectionRequest,
} from '@wechatsync/core/publication-inspection'

const DEFAULT_INSPECTION_TIMEOUT_MS = 12_000
const TOUTIAO_BLOCKED_PUBLIC_ACCESS_REASONS = new Set<string>(
  TOUTIAO_ANONYMOUS_BLOCKED_REASONS,
)
const EXACT_ARTICLE_LIFECYCLE_OUTCOMES = new Set<PublicationInspectionOutcome>([
  'DRAFT_PRESENT',
  'PENDING_REVIEW',
  'REJECTED',
  'SCHEDULED',
  'PUBLISHED',
  'NOT_FOUND',
  'DELETED',
])

export type PublicationInspectorAdapter = Pick<
  PlatformAdapter,
  'inspectPublication' | 'provePublishedObservation'
>

export type PublicationInspectionRunnerFailureCode =
  | 'INVALID_INSPECTION_REQUEST'
  | 'PUBLICATION_INSPECTION_NOT_IMPLEMENTED'
  | 'INVALID_INSPECTION_RESULT'
  | 'PUBLICATION_INSPECTION_TIMEOUT'
  | 'PUBLICATION_INSPECTION_FAILED'

export type PublicationInspectionRunnerResult =
  | {
      ok: true
      request: PublicationInspectionRequest
      observations: PublicationInspectionObservation[]
    }
  | {
      ok: false
      request: PublicationInspectionRequest | null
      code: PublicationInspectionRunnerFailureCode
    }

interface PublicationIdentityPolicy {
  platform: PublicationInspectionPlatform
  resolveRequestPostId?(request: PublicationInspectionRequest): string | null
  requiresExactPostIdForAllOutcomes?: boolean
  allowedArticleLifecycleOutcomes?: ReadonlySet<PublicationInspectionOutcome>
  validateDraftIdentity(
    request: PublicationInspectionRequest,
    identity: NonNullable<ReturnType<typeof parsePublicationUrl>>,
  ): boolean
  validatePublishedIdentity(
    request: PublicationInspectionRequest,
    observation: PublicationInspectionObservation,
    expectedPostId: string,
    identity: NonNullable<ReturnType<typeof parsePublicationUrl>>,
  ): boolean
  validateObservation?(
    request: PublicationInspectionRequest,
    observation: PublicationInspectionObservation,
    expectedPostId: string | null,
  ): boolean
}

const PUBLICATION_IDENTITY_POLICIES: Partial<
  Record<PublicationInspectionPlatform, PublicationIdentityPolicy>
> = {
  zhihu: {
    platform: 'zhihu',
    validateDraftIdentity: () => true,
    validatePublishedIdentity: (
      _request,
      observation,
      expectedPostId,
      identity,
    ) =>
      (observation.source === 'PUBLIC_PAGE' ||
        observation.source === 'AUTHENTICATED_PUBLIC_PAGE') &&
      identity.postId === expectedPostId &&
      identity.postId === observation.platformPostId,
  },
  sohu: {
    platform: 'sohu',
    validateDraftIdentity: (request, identity) =>
      !identity.accountId || identity.accountId === request.externalAccountId,
    validatePublishedIdentity: (
      request,
      observation,
      expectedPostId,
      identity,
    ) => {
      const expectedCanonicalUrl = `https://www.sohu.com/a/${expectedPostId}_${request.externalAccountId}`
      return (
        observation.source === 'PUBLIC_PAGE' &&
        Boolean(observation.publishedAt) &&
        identity.postId === expectedPostId &&
        identity.postId === observation.platformPostId &&
        identity.accountId === request.externalAccountId &&
        identity.canonicalUrl === expectedCanonicalUrl
      )
    },
  },
  weixin: {
    platform: 'weixin',
    requiresExactPostIdForAllOutcomes: true,
    resolveRequestPostId: (request) => {
      const resolved = resolveWeixinAppMsgId(
        request.draft.platformPostId,
        request.draft.draftUrl,
      )
      return resolved.success ? resolved.appMsgId : null
    },
    allowedArticleLifecycleOutcomes: new Set(['DRAFT_PRESENT', 'PUBLISHED']),
    validateDraftIdentity: () => true,
    // The public URL's mid is a different identifier. The adapter preserves
    // the requested appMsgId after an exact published-list match.
    validatePublishedIdentity: (
      _request,
      observation,
      expectedPostId,
      identity,
    ) =>
      observation.source === 'PUBLIC_PAGE' &&
      Boolean(observation.publishedAt) &&
      typeof observation.title === 'string' &&
      observation.title.trim().length > 0 &&
      typeof observation.bodyText === 'string' &&
      observation.bodyText.trim().length > 0 &&
      typeof observation.bodyTruncated === 'boolean' &&
      observation.errorCode === undefined &&
      observation.errorMessage === undefined &&
      observation.platformPostId === expectedPostId &&
      identity.canonicalUrl === observation.canonicalUrl,
  },
  toutiao: {
    platform: 'toutiao',
    requiresExactPostIdForAllOutcomes: true,
    validateDraftIdentity: () => true,
    validatePublishedIdentity: (
      _request,
      observation,
      expectedPostId,
      identity,
    ) =>
      (observation.source === 'PUBLIC_PAGE' ||
        observation.source === 'AUTHENTICATED_PUBLIC_PAGE') &&
      Boolean(observation.publishedAt) &&
      observation.platformPostId === expectedPostId &&
      Boolean(identity.postId) &&
      observation.internalEvidence?.publicItemId === identity.postId &&
      identity.canonicalUrl === observation.canonicalUrl,
    validateObservation: (_request, observation) => {
      if (observation.outcome === 'NOT_FOUND') {
        return observation.internalEvidence?.scanComplete === true
      }
      if (observation.outcome !== 'PUBLISHED') return true

      return (
        (observation.source === 'PUBLIC_PAGE' &&
          observation.publicAccess?.status === 'CONFIRMED') ||
        (observation.source === 'AUTHENTICATED_PUBLIC_PAGE' &&
          observation.publicAccess?.status === 'BLOCKED_BY_PLATFORM' &&
          TOUTIAO_BLOCKED_PUBLIC_ACCESS_REASONS.has(
            observation.publicAccess.reasonCode,
          ))
      )
    },
  },
}

function resolveRequestPostId(
  request: PublicationInspectionRequest,
  policy: PublicationIdentityPolicy,
): string | null {
  if (policy.resolveRequestPostId) {
    return policy.resolveRequestPostId(request)
  }

  const explicitPostId = request.draft.platformPostId
  let draftUrlPostId: string | undefined

  if (request.draft.draftUrl) {
    const parsedDraftUrl = parsePublicationUrl(
      policy.platform,
      request.draft.draftUrl,
    )
    if (
      !parsedDraftUrl ||
      parsedDraftUrl.surface !== 'DRAFT' ||
      !parsedDraftUrl.postId ||
      !policy.validateDraftIdentity(request, parsedDraftUrl)
    ) {
      return null
    }
    draftUrlPostId = parsedDraftUrl.postId
  }

  if (explicitPostId && draftUrlPostId && explicitPostId !== draftUrlPostId) {
    return null
  }

  return explicitPostId ?? draftUrlPostId ?? null
}

function normalizeAdapterObservations(
  request: PublicationInspectionRequest,
  value: unknown,
): PublicationInspectionObservation[] | null {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > request.limit
  ) {
    return null
  }

  const seenKeys = new Set<string>()
  const observations: PublicationInspectionObservation[] = []
  const identityPolicy = PUBLICATION_IDENTITY_POLICIES[request.platform]
  const expectedPostId = identityPolicy
    ? resolveRequestPostId(request, identityPolicy)
    : null

  for (const candidate of value) {
    const parsed = PublicationInspectionObservationSchema.safeParse(candidate)
    if (
      !parsed.success ||
      parsed.data.platform !== request.platform ||
      parsed.data.externalAccountId !== request.externalAccountId ||
      seenKeys.has(parsed.data.observationKey)
    ) {
      return null
    }

    let normalized = parsed.data
    if (
      identityPolicy?.requiresExactPostIdForAllOutcomes &&
      (!expectedPostId || normalized.platformPostId !== expectedPostId)
    ) {
      return null
    }
    if (
      identityPolicy &&
      EXACT_ARTICLE_LIFECYCLE_OUTCOMES.has(normalized.outcome) &&
      (identityPolicy.allowedArticleLifecycleOutcomes?.has(
        normalized.outcome,
      ) === false ||
        !expectedPostId ||
        normalized.platformPostId !== expectedPostId)
    ) {
      return null
    }
    if (
      identityPolicy?.validateObservation &&
      !identityPolicy.validateObservation(request, normalized, expectedPostId)
    ) {
      return null
    }

    if (normalized.canonicalUrl) {
      const canonical = parsePublicationUrl(
        request.platform,
        normalized.canonicalUrl,
      )
      if (
        !canonical ||
        canonical.surface !== 'PUBLISHED' ||
        !canonical.canonicalUrl
      ) {
        return null
      }
      if (
        identityPolicy &&
        EXACT_ARTICLE_LIFECYCLE_OUTCOMES.has(normalized.outcome) &&
        (!expectedPostId ||
          !identityPolicy.validatePublishedIdentity(
            request,
            normalized,
            expectedPostId,
            canonical,
          ))
      ) {
        return null
      }
      normalized = {
        ...normalized,
        canonicalUrl: canonical.canonicalUrl,
      }
    }

    if (
      identityPolicy &&
      normalized.outcome === 'PUBLISHED' &&
      (!expectedPostId || !normalized.canonicalUrl || !normalized.publishedAt)
    ) {
      return null
    }

    seenKeys.add(normalized.observationKey)
    observations.push(normalized)
  }

  return observations
}

export function withPublicationInspectionDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController()
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      controller.abort()
      reject(new Error('PUBLICATION_INSPECTION_TIMEOUT'))
    }, timeoutMs)

    Promise.resolve()
      .then(() => operation(controller.signal))
      .then(
        (value) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve(value)
        },
        (error) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          reject(error)
        },
      )
  })
}

/**
 * Execute one adapter inspection behind a version-neutral shape, identity and
 * deadline boundary. No bridge wire schema participates in this operation.
 */
export async function runInternalPublicationInspection(
  untrustedRequest: PublicationInspectionRequest,
  adapter: PublicationInspectorAdapter | null,
  options: {
    activePlatforms?: ReadonlySet<PublicationInspectionPlatform>
    timeoutMs?: number
  } = {},
): Promise<PublicationInspectionRunnerResult> {
  const parsedRequest =
    PublicationInspectionRequestSchema.safeParse(untrustedRequest)
  if (!parsedRequest.success) {
    return {
      ok: false,
      request: null,
      code: 'INVALID_INSPECTION_REQUEST',
    }
  }
  const request = parsedRequest.data

  if (
    (options.activePlatforms &&
      !options.activePlatforms.has(request.platform)) ||
    !adapter?.inspectPublication
  ) {
    return {
      ok: false,
      request,
      code: 'PUBLICATION_INSPECTION_NOT_IMPLEMENTED',
    }
  }

  try {
    const value = await withPublicationInspectionDeadline(
      (signal) => adapter.inspectPublication!(request, { signal }),
      options.timeoutMs ?? DEFAULT_INSPECTION_TIMEOUT_MS,
    )
    const observations = normalizeAdapterObservations(request, value)
    if (!observations) {
      return {
        ok: false,
        request,
        code: 'INVALID_INSPECTION_RESULT',
      }
    }
    return { ok: true, request, observations }
  } catch (error) {
    const timedOut =
      error instanceof Error &&
      error.message === 'PUBLICATION_INSPECTION_TIMEOUT'
    return {
      ok: false,
      request,
      code: timedOut
        ? 'PUBLICATION_INSPECTION_TIMEOUT'
        : 'PUBLICATION_INSPECTION_FAILED',
    }
  }
}
