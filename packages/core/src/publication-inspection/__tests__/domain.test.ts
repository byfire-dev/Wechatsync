import { describe, expect, it } from 'vitest'

import { PublicationInspectionObservationSchema } from '../domain'

const basePublishedObservation = {
  observationKey: 'sohu:inspection:published',
  platform: 'sohu' as const,
  externalAccountId: '120219780',
  outcome: 'PUBLISHED' as const,
  source: 'PUBLIC_PAGE' as const,
  platformPostId: '1054312481',
  canonicalUrl: 'https://www.sohu.com/a/1054312481_120219780',
  title: 'Published title',
  publishedAt: '2026-07-24T08:40:14.000Z',
  bodyText: 'Published body',
  bodyTruncated: false,
  publicAccess: {
    status: 'CONFIRMED' as const,
    checkedUrl: 'https://m.sohu.com/a/1054312481_120219780/',
    checkedPublicIdentityKey: 'sohu:post:v1:1054312481:120219780',
    checkedAt: '2026-07-24T09:00:00.000Z',
    httpStatus: 200,
  },
  observedAt: '2026-07-24T09:00:01.000Z',
}

describe('PublicationInspectionObservationSchema public evidence', () => {
  it('accepts a real checked URL that resolves to the canonical identity', () => {
    expect(
      PublicationInspectionObservationSchema.parse(basePublishedObservation),
    ).toEqual(basePublishedObservation)
  })

  it('requires complete confirmed access evidence', () => {
    const { httpStatus: _httpStatus, ...incompleteAccess } =
      basePublishedObservation.publicAccess

    expect(
      PublicationInspectionObservationSchema.safeParse({
        ...basePublishedObservation,
        publicAccess: incompleteAccess,
      }).success,
    ).toBe(false)
  })

  it('rejects evidence for a different public identity', () => {
    expect(
      PublicationInspectionObservationSchema.safeParse({
        ...basePublishedObservation,
        publicAccess: {
          ...basePublishedObservation.publicAccess,
          checkedUrl: 'https://m.sohu.com/a/999_120219780',
        },
      }).success,
    ).toBe(false)
  })

  it('rejects a check timestamp after the observation timestamp', () => {
    expect(
      PublicationInspectionObservationSchema.safeParse({
        ...basePublishedObservation,
        publicAccess: {
          ...basePublishedObservation.publicAccess,
          checkedAt: '2026-07-24T09:00:02.000Z',
        },
      }).success,
    ).toBe(false)
  })
})
