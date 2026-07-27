import { z } from 'zod'

// Shared with VibeMarket's VARCHAR(128) locator contract. Real appMsgId values
// are substantially shorter.
export const WEIXIN_APP_MSG_ID_MAX_LENGTH = 128

export const PublicationPlatformSchema = z.enum([
  'toutiao',
  'zhihu',
  'sohu',
  'weixin',
])

export type PublicationPlatform = z.infer<typeof PublicationPlatformSchema>

export const PublicationInspectionCapabilitySchema = z.enum([
  'account_identity',
  'draft_open',
  'full_sync_result',
  'publication_inspect',
  'published_list',
  'public_url',
])

export type PublicationInspectionCapability = z.infer<
  typeof PublicationInspectionCapabilitySchema
>

export const SyncerBridgeInfoSchema = z.object({
  apiVersion: z.literal('2.0'),
  extensionVersion: z.string().min(1),
  capabilities: z.array(PublicationInspectionCapabilitySchema),
})

export type SyncerBridgeInfo = z.infer<typeof SyncerBridgeInfoSchema>

export const SyncerAccountV2Schema = z.object({
  platform: PublicationPlatformSchema,
  externalAccountId: z.string().trim().min(1).max(500),
  displayName: z.string().trim().min(1).max(500),
  avatarUrl: z.string().url().max(2_000).optional(),
  homepage: z.string().url().max(2_000).optional(),
  capabilities: z.array(PublicationInspectionCapabilitySchema).max(10),
})

export type SyncerAccountV2 = z.infer<typeof SyncerAccountV2Schema>

export const SyncerAccountProbeStatusSchema = z.enum([
  'AUTHENTICATED',
  'NOT_AUTHENTICATED',
  'PROBE_FAILED',
])

export const SyncerAccountProbeSourceSchema = z.enum([
  'EXTENSION',
  'MAIN_WORLD',
])

export const SyncerAccountProbeErrorCodeSchema = z.enum([
  'PLATFORM_NOT_FOUND',
  'TIMEOUT',
  'NETWORK_ERROR',
  'HTTP_ERROR',
  'REDIRECTED',
  'INVALID_CONTENT_TYPE',
  'RESPONSE_SCHEMA_MISMATCH',
  'ACCOUNT_ID_MISSING',
  'PAGE_CONTEXT_UNAVAILABLE',
  'UNTRUSTED_PAGE',
  'UNKNOWN_ERROR',
])

export const SyncerAccountProbeV2Schema = z
  .object({
    platform: PublicationPlatformSchema,
    status: SyncerAccountProbeStatusSchema,
    source: SyncerAccountProbeSourceSchema,
    errorCode: SyncerAccountProbeErrorCodeSchema.optional(),
    primaryErrorCode: SyncerAccountProbeErrorCodeSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.status === 'PROBE_FAILED' && !value.errorCode) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'failed account probes require a safe error code',
        path: ['errorCode'],
      })
    }

    if (value.status !== 'PROBE_FAILED' && value.errorCode !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'successful account probes cannot contain a final error code',
        path: ['errorCode'],
      })
    }

    if (
      value.source !== 'MAIN_WORLD' &&
      value.primaryErrorCode !== undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'primary probe errors require a MAIN_WORLD fallback',
        path: ['primaryErrorCode'],
      })
    }
  })

export type SyncerAccountProbeV2 = z.infer<
  typeof SyncerAccountProbeV2Schema
>

export const SyncerAccountsV2DetailedSchema = z
  .object({
    accounts: z.array(SyncerAccountV2Schema).max(4),
    probes: z.array(SyncerAccountProbeV2Schema).max(4),
  })
  .strict()
  .superRefine((value, ctx) => {
    const accountPlatforms = new Set<PublicationPlatform>()
    for (const account of value.accounts) {
      if (accountPlatforms.has(account.platform)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'detailed accounts must be unique per platform',
          path: ['accounts'],
        })
      }
      accountPlatforms.add(account.platform)
    }

    const probePlatforms = new Set<PublicationPlatform>()
    for (const probe of value.probes) {
      if (probePlatforms.has(probe.platform)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'account probes must be unique per platform',
          path: ['probes'],
        })
      }
      probePlatforms.add(probe.platform)

      if (
        probe.status === 'AUTHENTICATED' &&
        !accountPlatforms.has(probe.platform)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'authenticated probes require a projected account',
          path: ['probes'],
        })
      }
    }

    for (const platform of accountPlatforms) {
      const probe = value.probes.find(
        (candidate) => candidate.platform === platform,
      )
      if (probe?.status !== 'AUTHENTICATED') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'projected accounts require an authenticated probe',
          path: ['accounts'],
        })
      }
    }
  })

export type SyncerAccountsV2Detailed = z.infer<
  typeof SyncerAccountsV2DetailedSchema
>

export const SYNCER_BRIDGE_REQUEST_ID_MAX_LENGTH = 128

export const OpenPublicationDraftRequestSchema = z
  .object({
    requestId: z
      .string()
      .trim()
      .min(1)
      .max(SYNCER_BRIDGE_REQUEST_ID_MAX_LENGTH),
    platform: PublicationPlatformSchema,
    externalAccountId: z.string().trim().min(1).max(500),
    platformPostId: z.string().trim().min(1).max(WEIXIN_APP_MSG_ID_MAX_LENGTH),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.platform === 'weixin' &&
      !/^[1-9]\d*$/.test(value.platformPostId)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'WeChat draft opening requires a canonical non-zero decimal appMsgId',
        path: ['platformPostId'],
      })
    }
  })

export type OpenPublicationDraftRequest = z.infer<
  typeof OpenPublicationDraftRequestSchema
>

export const OpenPublicationDraftResultSchema = z
  .object({
    opened: z.literal(true),
  })
  .strict()

export type OpenPublicationDraftResult = z.infer<
  typeof OpenPublicationDraftResultSchema
>

export const PublicationInspectRequestSchema = z
  .object({
    requestId: z
      .string()
      .trim()
      .min(1)
      .max(SYNCER_BRIDGE_REQUEST_ID_MAX_LENGTH),
    platform: PublicationPlatformSchema,
    externalAccountId: z.string().trim().min(1).max(500),
    draft: z.object({
      platformPostId: z.string().trim().min(1).max(500).optional(),
      draftUrl: z.string().url().max(4_096).optional(),
      draftedAt: z.string().datetime({ offset: true }),
    }),
    articleHint: z.object({
      title: z.string().min(1).max(500),
      publishedAfter: z.string().datetime({ offset: true }).optional(),
      publishedBefore: z.string().datetime({ offset: true }).optional(),
    }),
    limit: z.number().int().min(1).max(20),
  })
  .superRefine((value, ctx) => {
    const postId = value.draft.platformPostId
    if (
      value.platform === 'weixin' &&
      postId !== undefined &&
      (postId.length > WEIXIN_APP_MSG_ID_MAX_LENGTH ||
        !/^[1-9]\d*$/.test(postId))
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'WeChat draft inspection requires a canonical appMsgId',
        path: ['draft', 'platformPostId'],
      })
    }
  })

export type PublicationInspectRequest = z.infer<
  typeof PublicationInspectRequestSchema
>

export const PublicationObservationOutcomeSchema = z.enum([
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

export type PublicationObservationOutcome = z.infer<
  typeof PublicationObservationOutcomeSchema
>

export const ZHIHU_ARTICLE_SUCCESS_OUTCOMES: readonly PublicationObservationOutcome[] =
  [
    'DRAFT_PRESENT',
    'PENDING_REVIEW',
    'REJECTED',
    'SCHEDULED',
    'PUBLISHED',
    'NOT_FOUND',
    'DELETED',
  ]

export const SOHU_ARTICLE_SUCCESS_OUTCOMES: readonly PublicationObservationOutcome[] =
  ZHIHU_ARTICLE_SUCCESS_OUTCOMES

export const WEIXIN_ARTICLE_SUCCESS_OUTCOMES: readonly PublicationObservationOutcome[] =
  ZHIHU_ARTICLE_SUCCESS_OUTCOMES

export const PublicationObservationSourceSchema = z.enum([
  'DRAFT_DETAIL',
  'DRAFT_LIST',
  'PLATFORM_DETAIL',
  'PUBLISHED_LIST',
  'PUBLIC_PAGE',
])

export type PublicationObservationSource = z.infer<
  typeof PublicationObservationSourceSchema
>

export const PublicationObservationSchema = z
  .object({
    observationKey: z.string().min(1).max(500),
    platform: PublicationPlatformSchema,
    externalAccountId: z.string().trim().min(1).max(500),
    outcome: PublicationObservationOutcomeSchema,
    source: PublicationObservationSourceSchema,
    platformPostId: z.string().trim().min(1).max(500).optional(),
    canonicalUrl: z.string().url().max(4_096).optional(),
    title: z.string().max(500).optional(),
    publishedAt: z.string().datetime({ offset: true }).optional(),
    bodyText: z.string().max(50_000).optional(),
    bodyTruncated: z.boolean().optional(),
    observedAt: z.string().datetime({ offset: true }),
    errorCode: z.string().max(100).optional(),
    errorMessage: z.string().max(2_000).optional(),
  })
  .superRefine((value, ctx) => {
    const isError = [
      'LOGIN_REQUIRED',
      'ACCOUNT_MISMATCH',
      'REVIEW_REQUIRED',
      'UNSUPPORTED',
      'FETCH_ERROR',
      'PARSE_ERROR',
    ].includes(value.outcome)

    if (isError && !value.errorCode) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'error outcomes require errorCode',
        path: ['errorCode'],
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
          'published observations require platformPostId or canonicalUrl',
        path: ['platformPostId'],
      })
    }

    const requiresArticlePostId =
      (value.platform === 'zhihu' &&
        ZHIHU_ARTICLE_SUCCESS_OUTCOMES.includes(value.outcome)) ||
      (value.platform === 'sohu' &&
        SOHU_ARTICLE_SUCCESS_OUTCOMES.includes(value.outcome)) ||
      (value.platform === 'weixin' &&
        WEIXIN_ARTICLE_SUCCESS_OUTCOMES.includes(value.outcome))

    if (requiresArticlePostId && !value.platformPostId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'successful article observations require platformPostId',
        path: ['platformPostId'],
      })
    }

    if (
      value.platform === 'weixin' &&
      value.platformPostId !== undefined &&
      (value.platformPostId.length > WEIXIN_APP_MSG_ID_MAX_LENGTH ||
        !/^[1-9]\d*$/.test(value.platformPostId))
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'WeChat observations require a canonical appMsgId',
        path: ['platformPostId'],
      })
    }

    if (value.platform === 'weixin' && !value.platformPostId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'WeChat observations require the inspected appMsgId',
        path: ['platformPostId'],
      })
    }

    if (
      (value.platform === 'zhihu' ||
        value.platform === 'sohu' ||
        value.platform === 'weixin') &&
      value.outcome === 'PUBLISHED' &&
      !value.canonicalUrl
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'published article observations require canonicalUrl',
        path: ['canonicalUrl'],
      })
    }

    if (
      (value.platform === 'zhihu' ||
        value.platform === 'sohu' ||
        value.platform === 'weixin') &&
      value.outcome === 'PUBLISHED' &&
      !value.publishedAt
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'published article observations require publishedAt',
        path: ['publishedAt'],
      })
    }

    if (
      value.platform === 'weixin' &&
      value.outcome === 'PUBLISHED' &&
      value.source !== 'PUBLIC_PAGE'
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'published WeChat observations require PUBLIC_PAGE evidence',
        path: ['source'],
      })
    }

    if (value.platform === 'weixin' && value.outcome === 'PUBLISHED') {
      if (!value.title?.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'published WeChat observations require a public title',
          path: ['title'],
        })
      }
      if (!value.bodyText?.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'published WeChat observations require public body text',
          path: ['bodyText'],
        })
      }
      if (typeof value.bodyTruncated !== 'boolean') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'published WeChat observations require a body truncation marker',
          path: ['bodyTruncated'],
        })
      }
      if (value.errorCode !== undefined || value.errorMessage !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'published WeChat observations cannot contain error fields',
          path: ['errorCode'],
        })
      }
    }

    if (value.platform === 'weixin' && value.outcome === 'DRAFT_PRESENT') {
      if (value.source !== 'DRAFT_DETAIL') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'draft WeChat observations require DRAFT_DETAIL evidence',
          path: ['source'],
        })
      }
      if (!value.title?.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'draft WeChat observations require a draft title',
          path: ['title'],
        })
      }
      if (!value.bodyText?.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'draft WeChat observations require draft body text',
          path: ['bodyText'],
        })
      }
      if (typeof value.bodyTruncated !== 'boolean') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'draft WeChat observations require a body truncation marker',
          path: ['bodyTruncated'],
        })
      }
      if (
        value.canonicalUrl !== undefined ||
        value.publishedAt !== undefined ||
        value.errorCode !== undefined ||
        value.errorMessage !== undefined
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'draft WeChat observations cannot contain publication or error fields',
          path: ['canonicalUrl'],
        })
      }
    }

    if (value.platform === 'weixin' && value.outcome === 'REVIEW_REQUIRED') {
      if (
        value.source !== 'DRAFT_DETAIL' &&
        value.source !== 'PUBLISHED_LIST' &&
        value.source !== 'PUBLIC_PAGE'
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'review-required WeChat observations require a verified inspection source',
          path: ['source'],
        })
      }
      if (!value.errorCode || !value.errorMessage?.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'review-required WeChat observations require safe error details',
          path: ['errorMessage'],
        })
      }
      if (
        value.canonicalUrl !== undefined ||
        value.publishedAt !== undefined ||
        value.title !== undefined ||
        value.bodyText !== undefined ||
        value.bodyTruncated !== undefined
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'review-required WeChat observations cannot contain unverified article facts',
          path: ['canonicalUrl'],
        })
      }
    }

    if (
      value.platform === 'weixin' &&
      value.outcome !== 'DRAFT_PRESENT' &&
      value.outcome !== 'PUBLISHED' &&
      value.outcome !== 'REVIEW_REQUIRED'
    ) {
      if (value.source !== 'DRAFT_DETAIL') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'failed WeChat observations require DRAFT_DETAIL source',
          path: ['source'],
        })
      }
      if (!value.errorCode || !value.errorMessage?.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'failed WeChat observations require safe error details',
          path: ['errorMessage'],
        })
      }
      if (
        value.canonicalUrl !== undefined ||
        value.publishedAt !== undefined ||
        value.title !== undefined ||
        value.bodyText !== undefined ||
        value.bodyTruncated !== undefined
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'failed WeChat observations cannot contain unverified article facts',
          path: ['canonicalUrl'],
        })
      }
    }
  })

export type PublicationObservation = z.infer<
  typeof PublicationObservationSchema
>
