import { describe, expect, it } from 'vitest'

import {
  isConfirmedSyncSuccess,
  isSyncReviewRequired,
} from '../src/lib/sync-outcome'

describe('sync outcome classification', () => {
  it('does not count a non-retryable unknown write as confirmed success', () => {
    const result = {
      success: true,
      outcome: 'OUTCOME_UNKNOWN' as const,
    }

    expect(isSyncReviewRequired(result)).toBe(true)
    expect(isConfirmedSyncSuccess(result)).toBe(false)
  })

  it.each([
    [{ success: true }, true],
    [{ success: true, outcome: 'SUCCEEDED' as const }, true],
    [{ success: false, outcome: 'FAILED' as const }, false],
  ])('classifies ordinary terminal result %#', (result, expected) => {
    expect(isConfirmedSyncSuccess(result)).toBe(expected)
    expect(isSyncReviewRequired(result)).toBe(false)
  })
})
