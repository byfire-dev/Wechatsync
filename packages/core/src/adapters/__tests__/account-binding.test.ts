import { describe, expect, it } from 'vitest'

import {
  normalizeAdapterAccountBinding,
  normalizeAdapterExternalAccountId,
  resolveAdapterAccountBinding,
} from '../account-binding'
import type { AdapterAccountProbe } from '../types'

function authenticated(...externalAccountIds: string[]): AdapterAccountProbe {
  return {
    status: 'AUTHENTICATED',
    accounts: externalAccountIds.map((externalAccountId) => ({
      externalAccountId,
      displayName: externalAccountId,
    })),
  }
}

describe('adapter account binding', () => {
  it('normalizes bounded identities and rejects unsafe values', () => {
    expect(normalizeAdapterExternalAccountId(' account-1 ')).toBe('account-1')
    expect(normalizeAdapterExternalAccountId('')).toBeNull()
    expect(normalizeAdapterExternalAccountId('a'.repeat(501))).toBeNull()
    expect(normalizeAdapterExternalAccountId('account\u0000id')).toBeNull()
  })

  it('accepts only the exact binding field', () => {
    expect(
      normalizeAdapterAccountBinding({
        externalAccountId: ' account-1 ',
      }),
    ).toEqual({ externalAccountId: 'account-1' })
    expect(
      normalizeAdapterAccountBinding({
        externalAccountId: 'account-1',
        token: 'must-not-cross',
      }),
    ).toBeNull()
  })

  it('keeps the legacy fallback for exactly one account', () => {
    expect(resolveAdapterAccountBinding(authenticated('account-1'))).toEqual({
      ok: true,
      account: {
        externalAccountId: 'account-1',
        displayName: 'account-1',
      },
      binding: { externalAccountId: 'account-1' },
    })
  })

  it('requires an explicit binding for multiple accounts', () => {
    expect(
      resolveAdapterAccountBinding(authenticated('account-1', 'account-2')),
    ).toEqual({
      ok: false,
      errorCode: 'ACCOUNT_BINDING_REQUIRED',
    })
  })

  it('distinguishes confirmed logout from an indeterminate probe failure', () => {
    expect(
      resolveAdapterAccountBinding({
        status: 'NOT_AUTHENTICATED',
        accounts: [],
      }),
    ).toEqual({
      ok: false,
      errorCode: 'ACCOUNT_NOT_AUTHENTICATED',
    })
    expect(
      resolveAdapterAccountBinding({
        status: 'PROBE_FAILED',
        accounts: [],
        errorCode: 'NETWORK_ERROR',
      }),
    ).toEqual({
      ok: false,
      errorCode: 'ACCOUNT_PROBE_FAILED',
    })
  })

  it('selects an exact account and never falls back for an unknown binding', () => {
    const probe = authenticated('account-1', 'account-2')
    expect(
      resolveAdapterAccountBinding(probe, {
        externalAccountId: 'account-2',
      }),
    ).toMatchObject({
      ok: true,
      account: { externalAccountId: 'account-2' },
    })
    expect(
      resolveAdapterAccountBinding(probe, {
        externalAccountId: 'account-3',
      }),
    ).toEqual({
      ok: false,
      errorCode: 'ACCOUNT_BINDING_NOT_FOUND',
    })
  })

  it('fails the complete probe on duplicate or invalid account identities', () => {
    expect(
      resolveAdapterAccountBinding(authenticated('account-1', ' account-1 ')),
    ).toEqual({
      ok: false,
      errorCode: 'ACCOUNT_PROBE_FAILED',
    })
    expect(
      resolveAdapterAccountBinding(authenticated('account\u0000id')),
    ).toEqual({
      ok: false,
      errorCode: 'ACCOUNT_PROBE_FAILED',
    })
  })
})
