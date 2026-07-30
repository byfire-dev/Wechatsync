import type {
  AdapterAccount,
  AdapterAccountBinding,
  AdapterAccountProbe,
} from './types'
import { ADAPTER_EXTERNAL_ACCOUNT_ID_MAX_LENGTH } from './types'

export const ADAPTER_ACCOUNT_SELECTION_ERROR_CODES = [
  'INVALID_ACCOUNT_BINDING',
  'ACCOUNT_BINDING_REQUIRED',
  'ACCOUNT_BINDING_NOT_FOUND',
  'ACCOUNT_NOT_AUTHENTICATED',
  'ACCOUNT_PROBE_FAILED',
] as const

export type AdapterAccountSelectionErrorCode =
  (typeof ADAPTER_ACCOUNT_SELECTION_ERROR_CODES)[number]

export type AdapterAccountSelection =
  | {
      ok: true
      account: AdapterAccount
      binding: AdapterAccountBinding
    }
  | {
      ok: false
      errorCode: AdapterAccountSelectionErrorCode
    }

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export function normalizeAdapterExternalAccountId(
  value: unknown,
): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  if (
    normalized.length === 0 ||
    normalized.length > ADAPTER_EXTERNAL_ACCOUNT_ID_MAX_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    return null
  }
  return normalized
}

/**
 * Strictly projects an unknown value onto the only field adapters may use for
 * account selection. Extra fields (including credentials or tokens) are
 * rejected rather than copied.
 */
export function normalizeAdapterAccountBinding(
  value: unknown,
): AdapterAccountBinding | null {
  if (
    !isPlainRecord(value) ||
    Object.getOwnPropertySymbols(value).length > 0 ||
    Object.keys(value).length !== 1 ||
    !Object.prototype.hasOwnProperty.call(value, 'externalAccountId')
  ) {
    return null
  }
  const externalAccountId = normalizeAdapterExternalAccountId(
    value.externalAccountId,
  )
  return externalAccountId ? { externalAccountId } : null
}

/**
 * Select one account without platform-specific fallback rules.
 *
 * The account probe is treated atomically: malformed or duplicate identities
 * invalidate the complete result, preventing a partial response from looking
 * like a safe single-account session.
 */
export function resolveAdapterAccountBinding(
  probe: AdapterAccountProbe,
  requestedBinding?: unknown,
): AdapterAccountSelection {
  if (probe.status === 'NOT_AUTHENTICATED') {
    return { ok: false, errorCode: 'ACCOUNT_NOT_AUTHENTICATED' }
  }
  if (probe.status !== 'AUTHENTICATED' || probe.accounts.length === 0) {
    return { ok: false, errorCode: 'ACCOUNT_PROBE_FAILED' }
  }

  const accountsById = new Map<string, AdapterAccount>()
  for (const account of probe.accounts) {
    const externalAccountId = normalizeAdapterExternalAccountId(
      account.externalAccountId,
    )
    if (!externalAccountId || accountsById.has(externalAccountId)) {
      return { ok: false, errorCode: 'ACCOUNT_PROBE_FAILED' }
    }
    accountsById.set(externalAccountId, {
      ...account,
      externalAccountId,
    })
  }

  if (requestedBinding === undefined) {
    if (accountsById.size !== 1) {
      return { ok: false, errorCode: 'ACCOUNT_BINDING_REQUIRED' }
    }
    const account = accountsById.values().next().value as AdapterAccount
    return {
      ok: true,
      account,
      binding: { externalAccountId: account.externalAccountId },
    }
  }

  const binding = normalizeAdapterAccountBinding(requestedBinding)
  if (!binding) {
    return { ok: false, errorCode: 'INVALID_ACCOUNT_BINDING' }
  }
  const account = accountsById.get(binding.externalAccountId)
  if (!account) {
    return { ok: false, errorCode: 'ACCOUNT_BINDING_NOT_FOUND' }
  }
  return { ok: true, account, binding }
}

export function adapterAccountSelectionErrorMessage(
  errorCode: AdapterAccountSelectionErrorCode,
): string {
  switch (errorCode) {
    case 'INVALID_ACCOUNT_BINDING':
      return 'Invalid account binding'
    case 'ACCOUNT_BINDING_REQUIRED':
      return 'Multiple accounts are available; select an exact account'
    case 'ACCOUNT_BINDING_NOT_FOUND':
      return 'The selected account is no longer available'
    case 'ACCOUNT_NOT_AUTHENTICATED':
      return 'The platform account is not authenticated'
    case 'ACCOUNT_PROBE_FAILED':
      return 'Account probe failed'
  }
}
