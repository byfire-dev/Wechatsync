import {
  normalizeAdapterAccountBinding,
  type PlatformAccountBinding,
  type PlatformMeta,
} from '@wechatsync/core'

export const INVALID_ACCOUNT_BINDINGS = 'INVALID_ACCOUNT_BINDINGS' as const

const MAX_SYNC_PLATFORMS = 64
const MAX_PLATFORM_ID_LENGTH = 100
const PLATFORM_BINDING_KEYS = new Set(['platform', 'externalAccountId'])

export type AccountBindingsValidationResult =
  | {
      success: true
      platforms: string[]
      accountBindings: PlatformAccountBinding[]
    }
  | {
      success: false
      code: typeof INVALID_ACCOUNT_BINDINGS
    }

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function normalizePlatformId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized === value &&
    normalized.length > 0 &&
    normalized.length <= MAX_PLATFORM_ID_LENGTH &&
    !/[\u0000-\u001f\u007f]/.test(normalized)
    ? normalized
    : null
}

function normalizePlatforms(value: unknown): string[] | null {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_SYNC_PLATFORMS
  ) {
    return null
  }

  const platforms: string[] = []
  const seen = new Set<string>()
  for (const candidate of value) {
    const platform = normalizePlatformId(candidate)
    if (!platform || seen.has(platform)) return null
    platforms.push(platform)
    seen.add(platform)
  }
  return platforms
}

/**
 * Project selected legacy page accounts onto the narrow internal write
 * identity. No page-provided field other than type/externalAccountId crosses
 * this boundary.
 */
export function deriveLegacySyncTargets(
  value: unknown,
): AccountBindingsValidationResult {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_SYNC_PLATFORMS
  ) {
    return { success: false, code: INVALID_ACCOUNT_BINDINGS }
  }

  const platforms: string[] = []
  const accountBindings: PlatformAccountBinding[] = []
  const seenPlatforms = new Set<string>()

  for (const candidate of value) {
    if (!isPlainRecord(candidate)) {
      return { success: false, code: INVALID_ACCOUNT_BINDINGS }
    }
    const platform = normalizePlatformId(candidate.type)
    if (!platform || seenPlatforms.has(platform)) {
      return { success: false, code: INVALID_ACCOUNT_BINDINGS }
    }
    seenPlatforms.add(platform)
    platforms.push(platform)

    if (!Object.prototype.hasOwnProperty.call(candidate, 'externalAccountId')) {
      continue
    }
    const binding = normalizeAdapterAccountBinding({
      externalAccountId: candidate.externalAccountId,
    })
    if (!binding) {
      return { success: false, code: INVALID_ACCOUNT_BINDINGS }
    }
    accountBindings.push({ platform, ...binding })
  }

  return { success: true, platforms, accountBindings }
}

/**
 * Revalidate the structured-clone payload at the background boundary.
 */
export function validatePlatformAccountBindings(
  platformValue: unknown,
  bindingValue: unknown,
): AccountBindingsValidationResult {
  const platforms = normalizePlatforms(platformValue)
  if (!platforms) {
    return { success: false, code: INVALID_ACCOUNT_BINDINGS }
  }
  if (bindingValue === undefined) {
    return { success: true, platforms, accountBindings: [] }
  }
  if (
    !Array.isArray(bindingValue) ||
    bindingValue.length > platforms.length
  ) {
    return { success: false, code: INVALID_ACCOUNT_BINDINGS }
  }

  const selectedPlatforms = new Set(platforms)
  const boundPlatforms = new Set<string>()
  const accountBindings: PlatformAccountBinding[] = []
  for (const candidate of bindingValue) {
    if (
      !isPlainRecord(candidate) ||
      Object.getOwnPropertySymbols(candidate).length > 0 ||
      Object.keys(candidate).some((key) => !PLATFORM_BINDING_KEYS.has(key)) ||
      Object.keys(candidate).length !== PLATFORM_BINDING_KEYS.size
    ) {
      return { success: false, code: INVALID_ACCOUNT_BINDINGS }
    }

    const platform = normalizePlatformId(candidate.platform)
    const binding = normalizeAdapterAccountBinding({
      externalAccountId: candidate.externalAccountId,
    })
    if (
      !platform ||
      !binding ||
      !selectedPlatforms.has(platform) ||
      boundPlatforms.has(platform)
    ) {
      return { success: false, code: INVALID_ACCOUNT_BINDINGS }
    }
    boundPlatforms.add(platform)
    accountBindings.push({ platform, ...binding })
  }

  return { success: true, platforms, accountBindings }
}

/**
 * Route bindings only to adapters that explicitly advertise exact-account
 * write support. This keeps legacy callers compatible when they attach a
 * stable identity to every selected v2 account.
 */
export function routeAccountBindingsByCapability(
  bindings: readonly PlatformAccountBinding[],
  metas: readonly Pick<PlatformMeta, 'id' | 'capabilities'>[],
): PlatformAccountBinding[] {
  const capablePlatforms = new Set(
    metas
      .filter((meta) => meta.capabilities.includes('account_binding'))
      .map((meta) => meta.id),
  )
  return bindings.filter((binding) => capablePlatforms.has(binding.platform))
}
