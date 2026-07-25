import {
  OpenPublicationDraftRequestSchema,
  OpenPublicationDraftResultSchema,
  parsePublicationUrl,
  PublicationInspectRequestSchema,
  PublicationObservationSchema,
  PublicationPlatformSchema,
  normalizeWeixinAppMsgId,
  resolveWeixinAppMsgId,
  SyncerAccountV2Schema,
  type OpenPublicationDraftRequest,
  type OpenPublicationDraftResult,
  type PublicationInspectRequest,
  type PublicationObservation,
  type PublicationPlatform,
  type SyncerAccountV2,
} from '@wechatsync/core/publication-inspection'
import type { PlatformAdapter } from '@wechatsync/core'

import {
  DEFAULT_BRIDGE_ALLOWED_ORIGINS,
  normalizeBridgeRequestId,
  type GetAccountsV2Payload,
} from '../bridge/protocol'

const BRIDGE_ORIGIN = DEFAULT_BRIDGE_ALLOWED_ORIGINS[0]
const ACCOUNT_CAPABILITIES = {
  toutiao: ['account_identity'],
  zhihu: ['account_identity', 'publication_inspect', 'public_url'],
  sohu: ['account_identity', 'publication_inspect', 'public_url'],
  weixin: [
    'account_identity',
    'draft_open',
    'publication_inspect',
    'public_url',
  ],
} as const satisfies Record<
  PublicationPlatform,
  readonly SyncerAccountV2['capabilities'][number][]
>
const INSPECTION_TIMEOUT_MS = 12_000
const ACTIVE_INSPECTION_PLATFORMS = new Set<PublicationPlatform>([
  'zhihu',
  'sohu',
  'weixin',
])
const ACTIVE_DRAFT_OPEN_PLATFORMS = new Set<PublicationPlatform>(['weixin'])
const EXACT_ARTICLE_LIFECYCLE_OUTCOMES = new Set<
  PublicationObservation['outcome']
>([
  'DRAFT_PRESENT',
  'PENDING_REVIEW',
  'REJECTED',
  'SCHEDULED',
  'PUBLISHED',
  'NOT_FOUND',
  'DELETED',
])
const GET_ACCOUNTS_KEYS = new Set(['platforms', 'forceRefresh'])
const INSPECT_KEYS = new Set([
  'requestId',
  'platform',
  'externalAccountId',
  'draft',
  'articleHint',
  'limit',
])
const INSPECT_DRAFT_KEYS = new Set(['platformPostId', 'draftUrl', 'draftedAt'])
const INSPECT_ARTICLE_HINT_KEYS = new Set([
  'title',
  'publishedAfter',
  'publishedBefore',
])
const OPEN_PUBLICATION_DRAFT_KEYS = new Set([
  'requestId',
  'platform',
  'externalAccountId',
  'platformPostId',
])

export type BackgroundBridgeFailureCode =
  | 'SENDER_NOT_ALLOWED'
  | 'INVALID_PAYLOAD'

export type BackgroundBridgeValidationResult<T> =
  | { success: true; data: T }
  | { success: false; code: BackgroundBridgeFailureCode }

export interface VerifiedBridgeMessageSender {
  origin: typeof BRIDGE_ORIGIN
  tabId: number
  url: string
}

export interface VerifiedLegacyMutationMessageSender {
  channel: 'bridge' | 'extension'
  origin: string
  tabId?: number
  url: string
}

/**
 * Minimal shape returned by checkAllPlatformsAuth. Keeping this boundary typed
 * as unknown prevents legacy adapter fields from crossing Bridge v2 by accident.
 */
export interface AuthenticatedPlatformCandidate {
  id?: unknown
  name?: unknown
  homepage?: unknown
  isAuthenticated?: unknown
  username?: unknown
  userId?: unknown
  avatar?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }

  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>,
): boolean {
  return (
    Object.getOwnPropertySymbols(value).length === 0 &&
    Object.keys(value).every((key) => allowedKeys.has(key))
  )
}

function isExactBridgePageUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false

  try {
    const parsed = new URL(value)
    return (
      parsed.origin === BRIDGE_ORIGIN &&
      parsed.protocol === 'http:' &&
      parsed.hostname === 'localhost' &&
      parsed.port === '' &&
      parsed.username === '' &&
      parsed.password === ''
    )
  } catch {
    return false
  }
}

/**
 * Accept Bridge v2 messages only from the top frame of the canonical local app.
 * Chrome's MessageSender is treated as the authority; page-provided message
 * fields are deliberately not consulted here.
 */
export function validateBridgeMessageSender(
  sender: chrome.runtime.MessageSender,
): BackgroundBridgeValidationResult<VerifiedBridgeMessageSender> {
  const tabId = sender.tab?.id
  if (
    !Number.isInteger(tabId) ||
    (tabId as number) < 0 ||
    sender.frameId !== 0 ||
    sender.origin !== BRIDGE_ORIGIN ||
    !isExactBridgePageUrl(sender.url) ||
    !isExactBridgePageUrl(sender.tab?.url)
  ) {
    return { success: false, code: 'SENDER_NOT_ALLOWED' }
  }

  return {
    success: true,
    data: {
      origin: BRIDGE_ORIGIN,
      tabId: tabId as number,
      url: sender.url,
    },
  }
}

function isOwnExtensionPageUrl(
  value: unknown,
  extensionId: string,
): value is string {
  if (typeof value !== 'string') return false

  try {
    const parsed = new URL(value)
    return (
      parsed.protocol === 'chrome-extension:' &&
      parsed.hostname === extensionId &&
      parsed.port === '' &&
      parsed.username === '' &&
      parsed.password === ''
    )
  } catch {
    return false
  }
}

/**
 * Legacy writes may come from the canonical VibeMarket page through a content
 * script or from one of this extension's own UI pages. Any other web sender is
 * rejected before the background executes a state-changing operation.
 */
export function validateLegacyMutationMessageSender(
  sender: chrome.runtime.MessageSender,
  extensionId: string,
): BackgroundBridgeValidationResult<VerifiedLegacyMutationMessageSender> {
  const verifiedBridgeSender = validateBridgeMessageSender(sender)
  if (verifiedBridgeSender.success) {
    return {
      success: true,
      data: {
        channel: 'bridge',
        ...verifiedBridgeSender.data,
      },
    }
  }

  const extensionOrigin = `chrome-extension://${extensionId}`
  if (
    !/^[a-p]{32}$/.test(extensionId) ||
    sender.id !== extensionId ||
    (sender.frameId !== undefined && sender.frameId !== 0) ||
    (sender.origin !== undefined && sender.origin !== extensionOrigin) ||
    !isOwnExtensionPageUrl(sender.url, extensionId) ||
    (sender.tab?.url !== undefined &&
      !isOwnExtensionPageUrl(sender.tab.url, extensionId))
  ) {
    return { success: false, code: 'SENDER_NOT_ALLOWED' }
  }

  return {
    success: true,
    data: {
      channel: 'extension',
      origin: extensionOrigin,
      ...(Number.isInteger(sender.tab?.id) && (sender.tab?.id as number) >= 0
        ? { tabId: sender.tab?.id }
        : {}),
      url: sender.url,
    },
  }
}

function parsePlatformList(value: unknown): PublicationPlatform[] | null {
  if (!Array.isArray(value) || value.length > 4) return null

  const platforms: PublicationPlatform[] = []
  for (const candidate of value) {
    const parsed = PublicationPlatformSchema.safeParse(candidate)
    if (!parsed.success || platforms.includes(parsed.data)) return null
    platforms.push(parsed.data)
  }

  return platforms
}

/** Revalidates the page payload at the background trust boundary. */
export function validateGetAccountsV2Payload(
  payload: unknown,
): BackgroundBridgeValidationResult<GetAccountsV2Payload> {
  if (!isRecord(payload) || !hasOnlyKeys(payload, GET_ACCOUNTS_KEYS)) {
    return { success: false, code: 'INVALID_PAYLOAD' }
  }

  if (
    typeof payload.forceRefresh !== 'undefined' &&
    typeof payload.forceRefresh !== 'boolean'
  ) {
    return { success: false, code: 'INVALID_PAYLOAD' }
  }

  let platforms: PublicationPlatform[] | undefined
  if (typeof payload.platforms !== 'undefined') {
    const parsedPlatforms = parsePlatformList(payload.platforms)
    if (parsedPlatforms === null) {
      return { success: false, code: 'INVALID_PAYLOAD' }
    }
    platforms = parsedPlatforms
  }

  return {
    success: true,
    data: {
      ...(platforms ? { platforms } : {}),
      ...(typeof payload.forceRefresh === 'boolean'
        ? { forceRefresh: payload.forceRefresh }
        : {}),
    },
  }
}

function hasStrictInspectShape(
  value: unknown,
): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, INSPECT_KEYS) &&
    isRecord(value.draft) &&
    hasOnlyKeys(value.draft, INSPECT_DRAFT_KEYS) &&
    isRecord(value.articleHint) &&
    hasOnlyKeys(value.articleHint, INSPECT_ARTICLE_HINT_KEYS)
  )
}

/** Revalidates inspectPublication after the content-script protocol parser. */
export function validateInspectPublicationPayload(
  payload: unknown,
  envelopeRequestId: string,
): BackgroundBridgeValidationResult<PublicationInspectRequest> {
  if (!hasStrictInspectShape(payload)) {
    return { success: false, code: 'INVALID_PAYLOAD' }
  }

  const parsed = PublicationInspectRequestSchema.safeParse(payload)
  const normalizedEnvelopeRequestId =
    normalizeBridgeRequestId(envelopeRequestId)
  if (
    !parsed.success ||
    normalizedEnvelopeRequestId === null ||
    parsed.data.requestId !== normalizedEnvelopeRequestId
  ) {
    return { success: false, code: 'INVALID_PAYLOAD' }
  }

  return { success: true, data: parsed.data }
}

/** Revalidates an authenticated draft-open request at the background boundary. */
export function validateOpenPublicationDraftPayload(
  payload: unknown,
  envelopeRequestId: string,
): BackgroundBridgeValidationResult<OpenPublicationDraftRequest> {
  if (
    !isRecord(payload) ||
    !hasOnlyKeys(payload, OPEN_PUBLICATION_DRAFT_KEYS)
  ) {
    return { success: false, code: 'INVALID_PAYLOAD' }
  }

  const parsed = OpenPublicationDraftRequestSchema.safeParse(payload)
  const normalizedEnvelopeRequestId =
    normalizeBridgeRequestId(envelopeRequestId)
  if (
    !parsed.success ||
    normalizedEnvelopeRequestId === null ||
    parsed.data.requestId !== normalizedEnvelopeRequestId
  ) {
    return { success: false, code: 'INVALID_PAYLOAD' }
  }

  return { success: true, data: parsed.data }
}

function safeHttpUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined

  try {
    const parsed = new URL(value)
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      parsed.username !== '' ||
      parsed.password !== ''
    ) {
      return undefined
    }
    return parsed.href
  } catch {
    return undefined
  }
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  return normalized.length > 0 ? normalized : undefined
}

/**
 * Converts legacy auth results into the intentionally narrow Bridge v2 account
 * representation. At most one account is emitted per Phase 0 platform.
 */
export function buildSyncerAccountsV2(
  candidates: readonly AuthenticatedPlatformCandidate[],
  requestedPlatforms?: readonly PublicationPlatform[],
): SyncerAccountV2[] {
  const requested = requestedPlatforms
    ? new Set<PublicationPlatform>(requestedPlatforms)
    : null
  const emitted = new Set<PublicationPlatform>()
  const accounts: SyncerAccountV2[] = []

  for (const candidate of candidates) {
    const platform = PublicationPlatformSchema.safeParse(candidate.id)
    if (
      !platform.success ||
      candidate.isAuthenticated !== true ||
      (requested && !requested.has(platform.data)) ||
      emitted.has(platform.data)
    ) {
      continue
    }

    const externalAccountId = nonEmptyString(candidate.userId)
    if (!externalAccountId) continue

    const account = SyncerAccountV2Schema.safeParse({
      platform: platform.data,
      externalAccountId,
      displayName:
        nonEmptyString(candidate.username) ??
        nonEmptyString(candidate.name) ??
        externalAccountId,
      ...(safeHttpUrl(candidate.avatar)
        ? { avatarUrl: safeHttpUrl(candidate.avatar) }
        : {}),
      ...(safeHttpUrl(candidate.homepage)
        ? { homepage: safeHttpUrl(candidate.homepage) }
        : {}),
      capabilities: [...ACCOUNT_CAPABILITIES[platform.data]],
    })

    if (!account.success) continue
    accounts.push(account.data)
    emitted.add(platform.data)
  }

  return accounts
}

function resolveWeixinFailurePostId(
  request: PublicationInspectRequest,
): string | null {
  if (request.platform !== 'weixin') return null

  const resolved = resolveWeixinAppMsgId(
    request.draft.platformPostId,
    request.draft.draftUrl,
  )
  return resolved.success
    ? resolved.appMsgId
    : normalizeWeixinAppMsgId(request.draft.platformPostId)
}

/**
 * Paused platforms remain callable at the protocol level but explicitly return
 * UNSUPPORTED. This avoids misclassifying absence as NOT_FOUND.
 */
export function createUnsupportedPublicationObservation(
  request: PublicationInspectRequest,
  observedAt = new Date().toISOString(),
): PublicationObservation {
  const weixinAppMsgId = resolveWeixinFailurePostId(request)
  return PublicationObservationSchema.parse({
    observationKey: `bridge-v2:${request.requestId}:${request.platform}:unsupported`,
    platform: request.platform,
    externalAccountId: request.externalAccountId,
    outcome: 'UNSUPPORTED',
    source: request.platform === 'weixin' ? 'DRAFT_DETAIL' : 'PLATFORM_DETAIL',
    ...(weixinAppMsgId ? { platformPostId: weixinAppMsgId } : {}),
    observedAt,
    errorCode: 'PUBLICATION_INSPECTION_NOT_IMPLEMENTED',
    errorMessage: `Publication inspection is not implemented for ${request.platform} in Phase 0.`,
  })
}

type PublicationInspectorAdapter = Pick<PlatformAdapter, 'inspectPublication'>
type PublicationDraftOpenerAdapter = Pick<
  PlatformAdapter,
  'checkAuth' | 'openPublicationDraft'
>

interface PublicationIdentityPolicy {
  platform: PublicationPlatform
  resolveRequestPostId?(request: PublicationInspectRequest): string | null
  requiresExactPostIdForAllOutcomes?: boolean
  allowedArticleLifecycleOutcomes?: ReadonlySet<
    PublicationObservation['outcome']
  >
  validateDraftIdentity(
    request: PublicationInspectRequest,
    identity: NonNullable<ReturnType<typeof parsePublicationUrl>>,
  ): boolean
  validatePublishedIdentity(
    request: PublicationInspectRequest,
    observation: PublicationObservation,
    expectedPostId: string,
    identity: NonNullable<ReturnType<typeof parsePublicationUrl>>,
  ): boolean
}

const PUBLICATION_IDENTITY_POLICIES: Partial<
  Record<PublicationPlatform, PublicationIdentityPolicy>
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
}

function resolveRequestPostId(
  request: PublicationInspectRequest,
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

function createInspectionFailure(
  request: PublicationInspectRequest,
  outcome: 'FETCH_ERROR' | 'PARSE_ERROR',
  errorCode: string,
  errorMessage: string,
  observedAt = new Date().toISOString(),
): PublicationObservation {
  const weixinAppMsgId = resolveWeixinFailurePostId(request)
  return PublicationObservationSchema.parse({
    observationKey: `bridge-v2:${request.requestId}:${request.platform}:${errorCode.toLowerCase()}`,
    platform: request.platform,
    externalAccountId: request.externalAccountId,
    outcome,
    source: request.platform === 'weixin' ? 'DRAFT_DETAIL' : 'PLATFORM_DETAIL',
    ...(weixinAppMsgId ? { platformPostId: weixinAppMsgId } : {}),
    observedAt,
    errorCode,
    errorMessage,
  })
}

function normalizeAdapterObservations(
  request: PublicationInspectRequest,
  value: unknown,
): PublicationObservation[] | null {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > request.limit
  ) {
    return null
  }

  const seenKeys = new Set<string>()
  const observations: PublicationObservation[] = []
  const identityPolicy = PUBLICATION_IDENTITY_POLICIES[request.platform]
  const expectedPostId = identityPolicy
    ? resolveRequestPostId(request, identityPolicy)
    : null

  for (const candidate of value) {
    const parsed = PublicationObservationSchema.safeParse(candidate)
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

function withInspectionDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
) {
  const controller = new AbortController()
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      // Abort first so every nested adapter fetch is cancelled before the
      // bridge publishes its timeout result.
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

const SAFE_DRAFT_OPEN_FAILURES = new Set([
  'ACCOUNT_AUTH_CHECK_FAILED',
  'ACCOUNT_ID_MISSING',
  'ACCOUNT_MISMATCH',
  'INVALID_DRAFT_POST_ID',
  'INVALID_DRAFT_OPEN_RESULT',
  'LOGIN_REQUIRED',
  'PUBLICATION_DRAFT_OPEN_NOT_SUPPORTED',
  'PUBLICATION_DRAFT_OPEN_FAILED',
])

function draftOpenFailure(code: string): Error {
  return new Error(code)
}

/**
 * Re-authenticate and bind the active account before allowing an adapter to
 * open a token-bearing editor URL. URLs and adapter exception details never
 * cross this boundary.
 */
export async function runOpenPublicationDraft(
  request: OpenPublicationDraftRequest,
  adapter: PublicationDraftOpenerAdapter | null,
  timeoutMs = INSPECTION_TIMEOUT_MS,
): Promise<OpenPublicationDraftResult> {
  if (
    !ACTIVE_DRAFT_OPEN_PLATFORMS.has(request.platform) ||
    !adapter?.openPublicationDraft
  ) {
    throw draftOpenFailure('PUBLICATION_DRAFT_OPEN_NOT_SUPPORTED')
  }

  try {
    return await withInspectionDeadline(async (signal) => {
      let auth
      try {
        auth = await adapter.checkAuth({ signal })
      } catch {
        throw draftOpenFailure('ACCOUNT_AUTH_CHECK_FAILED')
      }

      if (!auth.isAuthenticated) {
        throw draftOpenFailure('LOGIN_REQUIRED')
      }
      if (!auth.userId) {
        throw draftOpenFailure('ACCOUNT_ID_MISSING')
      }
      if (auth.userId !== request.externalAccountId) {
        throw draftOpenFailure('ACCOUNT_MISMATCH')
      }

      let value: unknown
      try {
        value = await adapter.openPublicationDraft!(request, { signal })
      } catch (error) {
        const code = error instanceof Error ? error.message : ''
        throw draftOpenFailure(
          SAFE_DRAFT_OPEN_FAILURES.has(code)
            ? code
            : 'PUBLICATION_DRAFT_OPEN_FAILED',
        )
      }

      const parsed = OpenPublicationDraftResultSchema.safeParse(value)
      if (!parsed.success) {
        throw draftOpenFailure('INVALID_DRAFT_OPEN_RESULT')
      }
      return parsed.data
    }, timeoutMs)
  } catch (error) {
    const code = error instanceof Error ? error.message : ''
    throw draftOpenFailure(
      SAFE_DRAFT_OPEN_FAILURES.has(code)
        ? code
        : 'PUBLICATION_DRAFT_OPEN_FAILED',
    )
  }
}

/**
 * Execute an adapter inspector behind a final schema, account, URL and timeout
 * boundary. Adapter failures never become NOT_FOUND.
 */
export async function runPublicationInspection(
  request: PublicationInspectRequest,
  adapter: PublicationInspectorAdapter | null,
  timeoutMs = INSPECTION_TIMEOUT_MS,
): Promise<PublicationObservation[]> {
  if (
    !ACTIVE_INSPECTION_PLATFORMS.has(request.platform) ||
    !adapter?.inspectPublication
  ) {
    return [createUnsupportedPublicationObservation(request)]
  }

  try {
    const value = await withInspectionDeadline(
      (signal) => adapter.inspectPublication!(request, { signal }),
      timeoutMs,
    )
    const observations = normalizeAdapterObservations(request, value)
    if (!observations) {
      return [
        createInspectionFailure(
          request,
          'PARSE_ERROR',
          'INVALID_INSPECTION_RESULT',
          'The platform inspector returned an invalid result.',
        ),
      ]
    }
    return observations
  } catch (error) {
    const timedOut =
      error instanceof Error &&
      error.message === 'PUBLICATION_INSPECTION_TIMEOUT'
    return [
      createInspectionFailure(
        request,
        'FETCH_ERROR',
        timedOut
          ? 'PUBLICATION_INSPECTION_TIMEOUT'
          : 'PUBLICATION_INSPECTION_FAILED',
        timedOut
          ? 'The platform inspection timed out.'
          : 'The platform inspection failed.',
      ),
    ]
  }
}
