import {
  DEFAULT_BRIDGE_ALLOWED_ORIGINS,
  isAllowedBridgeOrigin,
} from './protocol'

export const LEGACY_API_ORIGIN_NOT_ALLOWED =
  'LEGACY_API_ORIGIN_NOT_ALLOWED' as const

const LEGACY_MUTATION_METHODS = new Set([
  'addTask',
  'magicCall',
  'updateDriver',
  'startInspect',
])

export interface LegacyMessageEventLike {
  data: unknown
  origin: unknown
  source: unknown
}

export type LegacyPageAction = Record<string, any> & {
  method: string
}

export type LegacyMutationPageValidationResult =
  | { success: true }
  | {
      success: false
      code: typeof LEGACY_API_ORIGIN_NOT_ALLOWED
    }

function isRecord(value: unknown): value is Record<string, any> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }

  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export function parseLegacyPageActionEvent(
  event: LegacyMessageEventLike,
  expectedSource: unknown,
): LegacyPageAction | null {
  if (event.source !== expectedSource || typeof event.data !== 'string') {
    return null
  }

  try {
    const action: unknown = JSON.parse(event.data)
    if (!isRecord(action) || typeof action.method !== 'string') {
      return null
    }

    return action as LegacyPageAction
  } catch {
    return null
  }
}

export function isLegacyMutationMethod(
  method: unknown,
): method is 'addTask' | 'magicCall' | 'updateDriver' | 'startInspect' {
  return typeof method === 'string' && LEGACY_MUTATION_METHODS.has(method)
}

export function validateLegacyMutationPageEvent(
  event: LegacyMessageEventLike,
  expectedSource: unknown,
  isTopLevel: boolean,
  allowedOrigins: readonly string[] = DEFAULT_BRIDGE_ALLOWED_ORIGINS,
): LegacyMutationPageValidationResult {
  if (
    !isTopLevel ||
    event.source !== expectedSource ||
    !isAllowedBridgeOrigin(event.origin, allowedOrigins)
  ) {
    return {
      success: false,
      code: LEGACY_API_ORIGIN_NOT_ALLOWED,
    }
  }

  return { success: true }
}

/**
 * Only legacy write paths need this compatibility policy. Native extension
 * pages keep their own sender boundary; web-page callers must use the
 * canonical local VibeMarket origin.
 */
export function isLegacyMutationRuntimeMessage(value: unknown): boolean {
  if (!isRecord(value)) return false

  if (value.type === 'UPLOAD_IMAGE' || value.type === 'MAGIC_CALL') {
    return true
  }

  return (
    value.type === 'SYNC_ARTICLE' &&
    isRecord(value.payload) &&
    value.payload.source === 'legacy-api'
  )
}
