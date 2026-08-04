import { z } from 'zod'

import { derivePublicationPublicIdentity } from './url'

/**
 * Version-neutral publication inspection domain.
 *
 * These types are intentionally independent from every bridge wire version.
 * A bridge must project a validated internal result through its own frozen
 * contract schema before exposing it outside the extension.
 */
export const PublicationInspectionPlatformSchema = z.enum([
  'toutiao',
  'zhihu',
  'sohu',
  'weixin',
])

export type PublicationInspectionPlatform = z.infer<
  typeof PublicationInspectionPlatformSchema
>

export const PublicationInspectionOutcomeSchema = z.enum([
  'DRAFT_PRESENT',
  'PENDING_REVIEW',
  'REJECTED',
  'SCHEDULED',
  'PUBLISHED',
  'NOT_FOUND',
  'DELETED',
  'REVIEW_REQUIRED',
  'ACCOUNT_MISMATCH',
  'LOGIN_REQUIRED',
  'UNSUPPORTED',
  'FETCH_ERROR',
  'PARSE_ERROR',
])

export type PublicationInspectionOutcome = z.infer<
  typeof PublicationInspectionOutcomeSchema
>

export const PublicationInspectionEvidenceSourceSchema = z.enum([
  'DRAFT_DETAIL',
  'DRAFT_LIST',
  'PLATFORM_DETAIL',
  'PUBLISHED_LIST',
  'PUBLIC_PAGE',
  'AUTHENTICATED_PUBLIC_PAGE',
])

export type PublicationInspectionEvidenceSource = z.infer<
  typeof PublicationInspectionEvidenceSourceSchema
>

export const PublicationInspectionPublicAccessSchema = z.discriminatedUnion(
  'status',
  [
    z
      .object({
        status: z.literal('CONFIRMED'),
        checkedUrl: z.string().url().max(4_096),
        checkedPublicIdentityKey: z
          .string()
          .trim()
          .min(3)
          .max(500)
          .regex(/^\S+$/),
        checkedAt: z.string().datetime({ offset: true }),
        httpStatus: z.number().int().min(200).max(299),
      })
      .strict(),
    z
      .object({
        status: z.literal('BLOCKED_BY_PLATFORM'),
        checkedUrl: z.string().url().max(4_096),
        checkedPublicIdentityKey: z
          .string()
          .trim()
          .min(3)
          .max(500)
          .regex(/^\S+$/),
        checkedAt: z.string().datetime({ offset: true }),
        httpStatus: z.number().int().min(400).max(599).optional(),
        reasonCode: z
          .string()
          .trim()
          .min(1)
          .max(100)
          .regex(/^[A-Z][A-Z0-9_]*$/),
      })
      .strict(),
  ],
)

export type PublicationInspectionPublicAccess = z.infer<
  typeof PublicationInspectionPublicAccessSchema
>

export const PublicationInspectionKnownPublicLocatorSchema = z
  .object({
    publicUrl: z.string().url().max(4_096),
    publicIdentityKey: z
      .string()
      .trim()
      .min(3)
      .max(500)
      .regex(/^\S+$/),
  })
  .strict()

export const PublicationInspectionRequestSchema = z
  .object({
    requestId: z.string().trim().min(1).max(128),
    platform: PublicationInspectionPlatformSchema,
    externalAccountId: z.string().trim().min(1).max(500),
    draft: z
      .object({
        platformPostId: z.string().trim().min(1).max(500).optional(),
        draftUrl: z.string().url().max(4_096).optional(),
        draftedAt: z.string().datetime({ offset: true }),
      })
      .strict(),
    articleHint: z
      .object({
        title: z.string().min(1).max(500),
        publishedAfter: z.string().datetime({ offset: true }).optional(),
        publishedBefore: z.string().datetime({ offset: true }).optional(),
      })
      .strict(),
    knownPublicLocator: PublicationInspectionKnownPublicLocatorSchema.optional(),
    limit: z.number().int().min(1).max(20),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.knownPublicLocator) return
    const identity = derivePublicationPublicIdentity(
      value.platform,
      value.knownPublicLocator.publicUrl,
    )
    if (
      !identity ||
      identity.canonicalUrl !== value.knownPublicLocator.publicUrl ||
      identity.key !== value.knownPublicLocator.publicIdentityKey
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['knownPublicLocator'],
        message: 'known public locator must contain one canonical platform identity',
      })
    }
  })

export type PublicationInspectionRequest = z.infer<
  typeof PublicationInspectionRequestSchema
>

/**
 * Adapter evidence that is useful for internal identity checks but deliberately
 * omitted from bridge wire observations.
 */
export const PublicationInspectionInternalEvidenceSchema = z
  .object({
    publicItemId: z.string().trim().min(1).max(500).optional(),
    scanComplete: z.literal(true).optional(),
  })
  .strict()

export type PublicationInspectionInternalEvidence = z.infer<
  typeof PublicationInspectionInternalEvidenceSchema
>

export const PublicationInspectionObservationSchema = z
  .object({
    observationKey: z.string().trim().min(1).max(500),
    platform: PublicationInspectionPlatformSchema,
    externalAccountId: z.string().trim().min(1).max(500),
    outcome: PublicationInspectionOutcomeSchema,
    source: PublicationInspectionEvidenceSourceSchema,
    platformPostId: z.string().trim().min(1).max(500).optional(),
    canonicalUrl: z.string().url().max(4_096).optional(),
    title: z.string().max(500).optional(),
    publishedAt: z.string().datetime({ offset: true }).optional(),
    bodyText: z.string().max(50_000).optional(),
    bodyTruncated: z.boolean().optional(),
    publicAccess: PublicationInspectionPublicAccessSchema.optional(),
    observedAt: z.string().datetime({ offset: true }),
    errorCode: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[A-Z][A-Z0-9_]*$/)
      .optional(),
    errorMessage: z.string().trim().min(1).max(2_000).optional(),
    internalEvidence: PublicationInspectionInternalEvidenceSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const isError = [
      'LOGIN_REQUIRED',
      'ACCOUNT_MISMATCH',
      'REVIEW_REQUIRED',
      'UNSUPPORTED',
      'FETCH_ERROR',
      'PARSE_ERROR',
    ].includes(value.outcome)

    if (isError && (!value.errorCode || !value.errorMessage)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'error outcomes require a safe error code and message',
        path: ['errorCode'],
      })
    }

    if (value.outcome !== 'PUBLISHED' && value.publicAccess !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'only published observations can contain public access',
        path: ['publicAccess'],
      })
    }

    if (
      value.publicAccess?.status === 'CONFIRMED' &&
      (value.outcome !== 'PUBLISHED' || value.source !== 'PUBLIC_PAGE')
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'confirmed public access requires a published public-page observation',
        path: ['publicAccess'],
      })
    }

    if (
      value.outcome === 'PUBLISHED' &&
      value.source === 'PUBLIC_PAGE' &&
      value.publicAccess?.status !== 'CONFIRMED'
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'published public-page observations require confirmed public access evidence',
        path: ['publicAccess'],
      })
    }

    if (
      value.publicAccess?.status === 'BLOCKED_BY_PLATFORM' &&
      (value.outcome !== 'PUBLISHED' ||
        value.source !== 'AUTHENTICATED_PUBLIC_PAGE')
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'blocked public access requires an authenticated public-page observation',
        path: ['publicAccess'],
      })
    }

    if (
      value.outcome === 'PUBLISHED' &&
      value.source === 'AUTHENTICATED_PUBLIC_PAGE' &&
      value.publicAccess?.status !== 'BLOCKED_BY_PLATFORM'
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'authenticated public-page publications require blocked public access evidence',
        path: ['publicAccess'],
      })
    }

    if (value.outcome === 'PUBLISHED' && value.source === 'PLATFORM_DETAIL') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'published observations cannot use platform detail as public evidence',
        path: ['source'],
      })
    }

    if (
      value.outcome === 'PUBLISHED' &&
      !value.platformPostId &&
      !value.canonicalUrl
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'published observations require a platform post ID or canonical URL',
        path: ['platformPostId'],
      })
    }

    if (value.publicAccess) {
      const checkedIdentity = derivePublicationPublicIdentity(
        value.platform,
        value.publicAccess.checkedUrl,
      )
      const canonicalIdentity = value.canonicalUrl
        ? derivePublicationPublicIdentity(value.platform, value.canonicalUrl)
        : null
      if (
        !checkedIdentity ||
        checkedIdentity.key !== value.publicAccess.checkedPublicIdentityKey
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'public access evidence must identify the URL that was actually checked',
          path: ['publicAccess', 'checkedPublicIdentityKey'],
        })
      }
      if (
        !canonicalIdentity ||
        canonicalIdentity.key !== value.publicAccess.checkedPublicIdentityKey
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'public access evidence must prove the canonical publication identity',
          path: ['canonicalUrl'],
        })
      }

      const checkedAt = Date.parse(value.publicAccess.checkedAt)
      const observedAt = Date.parse(value.observedAt)
      const publishedAt = value.publishedAt
        ? Date.parse(value.publishedAt)
        : undefined
      if (
        checkedAt > observedAt ||
        (publishedAt !== undefined && publishedAt > checkedAt)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'publication, public access, and observation timestamps must be monotonic',
          path: ['publicAccess', 'checkedAt'],
        })
      }
    }
  })

export type PublicationInspectionObservation = z.infer<
  typeof PublicationInspectionObservationSchema
>

export interface PublicationInspectionPublishedProof {
  observedAuthorExternalAccountId: string
  publicAccess: PublicationInspectionPublicAccess
  bodyTruncated: boolean
}
