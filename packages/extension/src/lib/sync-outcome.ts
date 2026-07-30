export interface SyncOutcomeLike {
  success: boolean
  outcome?: 'SUCCEEDED' | 'FAILED' | 'OUTCOME_UNKNOWN'
}

export function isSyncReviewRequired(
  result: SyncOutcomeLike,
): boolean {
  return result.outcome === 'OUTCOME_UNKNOWN'
}

export function isConfirmedSyncSuccess(
  result: SyncOutcomeLike,
): boolean {
  return result.success && !isSyncReviewRequired(result)
}
