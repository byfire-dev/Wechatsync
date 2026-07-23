import { describe, expect, it } from 'vitest'

import {
  isLegacyMutationMethod,
  isLegacyMutationRuntimeMessage,
  LEGACY_API_ORIGIN_NOT_ALLOWED,
  parseLegacyPageActionEvent,
  validateLegacyMutationPageEvent,
} from '../src/bridge/legacy-origin-policy'

const pageWindow = {}

function event(
  overrides: Partial<{
    data: unknown
    origin: unknown
    source: unknown
  }> = {},
) {
  return {
    data: JSON.stringify({ method: 'addTask', eventID: 42 }),
    origin: 'http://localhost',
    source: pageWindow,
    ...overrides,
  }
}

describe('Legacy page API parsing boundary', () => {
  it('parses a same-window JSON action', () => {
    expect(parseLegacyPageActionEvent(event(), pageWindow)).toEqual({
      method: 'addTask',
      eventID: 42,
    })
  })

  it.each([
    event({ source: {} }),
    event({ data: { method: 'addTask' } }),
    event({ data: '{' }),
    event({ data: JSON.stringify(['addTask']) }),
    event({ data: JSON.stringify({ eventID: 42 }) }),
  ])('ignores malformed or cross-window actions', (candidate) => {
    expect(parseLegacyPageActionEvent(candidate, pageWindow)).toBeNull()
  })
})

describe('Legacy mutation origin policy', () => {
  it.each(['addTask', 'magicCall', 'updateDriver', 'startInspect'])(
    'classifies %s as a state-changing legacy action',
    (method) => {
      expect(isLegacyMutationMethod(method)).toBe(true)
    },
  )

  it('does not classify the read-only account projection as a mutation', () => {
    expect(isLegacyMutationMethod('getAccounts')).toBe(false)
  })

  it('accepts only the top-level canonical localhost page', () => {
    expect(
      validateLegacyMutationPageEvent(event(), pageWindow, true),
    ).toEqual({ success: true })
  })

  it.each([
    [event({ origin: 'http://localhost:3000' }), true],
    [event({ origin: 'http://127.0.0.1' }), true],
    [event({ origin: 'https://localhost' }), true],
    [event({ source: {} }), true],
    [event(), false],
  ])('rejects a non-canonical or non-top-level caller', (candidate, top) => {
    expect(
      validateLegacyMutationPageEvent(candidate, pageWindow, top),
    ).toEqual({
      success: false,
      code: LEGACY_API_ORIGIN_NOT_ALLOWED,
    })
  })
})

describe('Legacy mutation runtime routing', () => {
  it.each([
    { type: 'UPLOAD_IMAGE', payload: {} },
    { type: 'MAGIC_CALL', payload: {} },
    {
      type: 'SYNC_ARTICLE',
      payload: { source: 'legacy-api' },
    },
  ])('requires a trusted sender for $type', (message) => {
    expect(isLegacyMutationRuntimeMessage(message)).toBe(true)
  })

  it.each([
    {
      type: 'SYNC_ARTICLE',
      payload: { source: 'popup' },
    },
    {
      type: 'SYNC_ARTICLE',
      payload: { source: 'weixin' },
    },
    { type: 'CHECK_ALL_AUTH' },
  ])('preserves non-legacy message routing for $type', (message) => {
    expect(isLegacyMutationRuntimeMessage(message)).toBe(false)
  })
})
