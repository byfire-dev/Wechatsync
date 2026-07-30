import {
  normalizeWeixinAppMsgId,
  sanitizeSyncResultForBoundary,
} from '@wechatsync/core/publication-inspection'
import { normalizeAdapterExternalAccountId } from '@wechatsync/core'
import type { SyncResult, SyncResultOutcome } from '@wechatsync/core'

export interface LegacyEditResponse {
  draftLink?: string
  postId?: string
}

export const LEGACY_OUTCOME_UNKNOWN_MESSAGE =
  '平台写入结果尚未确认；请人工核验，勿重复提交'

export interface LegacySyncAccountUpdate {
  status: 'done' | 'failed'
  msg?: string
  error?: string
  editResp: LegacyEditResponse | null
  outcome?: SyncResultOutcome
  retryable?: boolean
  requestedExternalAccountId?: string
  observedExternalAccountId?: string
}

function boundedPostId(value: unknown, platform: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  if (platform === 'weixin') {
    return normalizeWeixinAppMsgId(value) ?? undefined
  }
  const normalized = value.trim()
  return normalized.length > 0 &&
    normalized.length <= 500 &&
    !/[\u0000-\u001f\u007f]/.test(normalized)
    ? normalized
    : undefined
}

/**
 * Project a platform sync result onto the narrow legacy account status shape.
 * The projection is a second defense after the adapter boundary: token-bearing
 * WeChat URLs can never be posted into the page, while stable postId survives.
 */
export function toLegacyEditResponse(
  value: unknown,
): LegacyEditResponse | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }

  const result = value as Record<string, unknown>
  if (result.success !== true) return null

  const sanitized = sanitizeSyncResultForBoundary(result)
  const draftLink =
    typeof sanitized.postUrl === 'string'
      ? sanitized.postUrl
      : typeof sanitized.url === 'string'
        ? sanitized.url
        : undefined
  const postId = boundedPostId(sanitized.postId, sanitized.platform)

  return {
    ...(draftLink ? { draftLink } : {}),
    ...(postId ? { postId } : {}),
  }
}

export function getLegacySyncResultRoutingAccountId(
  value: unknown,
): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined
  }

  const result = value as Record<string, unknown>
  if (
    Object.prototype.hasOwnProperty.call(
      result,
      'requestedExternalAccountId',
    )
  ) {
    return (
      normalizeAdapterExternalAccountId(
        result.requestedExternalAccountId,
      ) ?? undefined
    )
  }
  return (
    normalizeAdapterExternalAccountId(result.externalAccountId) ??
    undefined
  )
}

/**
 * Preserve a confirmed platform write in the legacy API while making the
 * account-verification uncertainty and no-retry policy explicit.
 */
export function toLegacySyncAccountUpdate(
  result: SyncResult,
): LegacySyncAccountUpdate {
  const outcomeUnknown = result.outcome === 'OUTCOME_UNKNOWN'
  const requestedExternalAccountId = normalizeAdapterExternalAccountId(
    result.requestedExternalAccountId,
  )
  const observedExternalAccountId = normalizeAdapterExternalAccountId(
    result.observedExternalAccountId,
  )

  return {
    status: result.success ? 'done' : 'failed',
    ...(outcomeUnknown ? { msg: LEGACY_OUTCOME_UNKNOWN_MESSAGE } : {}),
    ...(result.error ? { error: result.error } : {}),
    editResp: toLegacyEditResponse(result),
    ...(result.outcome ? { outcome: result.outcome } : {}),
    ...(typeof result.retryable === 'boolean'
      ? { retryable: result.retryable }
      : {}),
    ...(requestedExternalAccountId
      ? { requestedExternalAccountId }
      : {}),
    ...(observedExternalAccountId
      ? { observedExternalAccountId }
      : {}),
  }
}
