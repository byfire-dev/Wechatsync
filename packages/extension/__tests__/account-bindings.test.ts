import { describe, expect, it } from 'vitest'

import {
  deriveLegacySyncTargets,
  INVALID_ACCOUNT_BINDINGS,
  routeAccountBindingsByCapability,
  validatePlatformAccountBindings,
} from '../src/bridge/account-bindings'

describe('legacy sync account bindings', () => {
  it('derives only platform and stable account identity', () => {
    expect(
      deriveLegacySyncTargets([
        {
          type: 'sohu',
          externalAccountId: ' 120000002 ',
          title: 'Second account',
          token: 'must-not-cross',
        },
        { type: 'zhihu', title: 'Legacy account without stable identity' },
      ]),
    ).toEqual({
      success: true,
      platforms: ['sohu', 'zhihu'],
      accountBindings: [
        { platform: 'sohu', externalAccountId: '120000002' },
      ],
    })
  })

  it.each([
    [],
    [{ type: 'sohu' }, { type: 'sohu' }],
    [{ type: 'sohu', externalAccountId: '' }],
    [{ type: 'sohu', externalAccountId: 'a'.repeat(501) }],
    [{ type: ' sohu', externalAccountId: '120000002' }],
    [{ type: 'sohu', externalAccountId: null }],
  ])('rejects ambiguous or malformed selected accounts', (accounts) => {
    expect(deriveLegacySyncTargets(accounts)).toEqual({
      success: false,
      code: INVALID_ACCOUNT_BINDINGS,
    })
  })

  it('accepts an omitted binding list for old runtime callers', () => {
    expect(validatePlatformAccountBindings(['sohu'], undefined)).toEqual({
      success: true,
      platforms: ['sohu'],
      accountBindings: [],
    })
  })

  it('routes bindings only to registered adapters declaring account binding', () => {
    expect(
      routeAccountBindingsByCapability(
        [
          { platform: 'sohu', externalAccountId: '120000002' },
          { platform: 'zhihu', externalAccountId: 'zhihu-account' },
          { platform: 'toutiao', externalAccountId: 'toutiao-account' },
        ],
        [
          {
            id: 'sohu',
            capabilities: ['article', 'draft', 'account_binding'],
          },
          {
            id: 'zhihu',
            capabilities: ['article', 'draft'],
          },
          {
            id: 'toutiao',
            capabilities: ['article', 'draft'],
          },
        ],
      ),
    ).toEqual([
      { platform: 'sohu', externalAccountId: '120000002' },
    ])
  })

  it.each([
    {
      platforms: ['sohu'],
      bindings: [
        { platform: 'sohu', externalAccountId: '1' },
        { platform: 'sohu', externalAccountId: '2' },
      ],
    },
    {
      platforms: ['sohu'],
      bindings: [{ platform: 'zhihu', externalAccountId: '1' }],
    },
    {
      platforms: ['sohu'],
      bindings: [{ platform: 'sohu', externalAccountId: '1', token: 'secret' }],
    },
    {
      platforms: ['sohu', 'sohu'],
      bindings: [],
    },
    {
      platforms: ['sohu'],
      bindings: [{ platform: 'sohu', externalAccountId: '' }],
    },
  ])(
    'rejects invalid bindings again at the runtime boundary',
    ({ platforms, bindings }) => {
      expect(validatePlatformAccountBindings(platforms, bindings)).toEqual({
        success: false,
        code: INVALID_ACCOUNT_BINDINGS,
      })
    },
  )
})
