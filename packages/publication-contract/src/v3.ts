import { z } from "zod";

export const PUBLICATION_CONTRACT_VERSION_V3 = "3.0" as const;
export const PUBLICATION_REQUEST_ID_MAX_LENGTH_V3 = 128;
export const PUBLICATION_EXTERNAL_ACCOUNT_ID_MAX_LENGTH_V3 = 500;
export const PUBLICATION_PLATFORM_POST_ID_MAX_LENGTH_V3 = 500;
export const PUBLICATION_ADAPTER_VERSION_MAX_LENGTH_V3 = 100;

const StrictHttpUrlV3Schema = z
  .string()
  .url()
  .max(4_096)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        (url.protocol === "http:" || url.protocol === "https:") &&
        url.username === "" &&
        url.password === ""
      );
    } catch {
      return false;
    }
  }, "expected an HTTP(S) URL without embedded credentials");

const RequestIdV3Schema = z
  .string()
  .trim()
  .min(1)
  .max(PUBLICATION_REQUEST_ID_MAX_LENGTH_V3);

const ExternalAccountIdV3Schema = z
  .string()
  .trim()
  .min(1)
  .max(PUBLICATION_EXTERNAL_ACCOUNT_ID_MAX_LENGTH_V3);

const PlatformPostIdV3Schema = z
  .string()
  .trim()
  .min(1)
  .max(PUBLICATION_PLATFORM_POST_ID_MAX_LENGTH_V3);

export const PublicationContractVersionV3Schema = z.literal(
  PUBLICATION_CONTRACT_VERSION_V3,
);

export type PublicationContractVersionV3 = z.infer<
  typeof PublicationContractVersionV3Schema
>;

export const PublicationPlatformV3Schema = z.enum([
  "toutiao",
  "zhihu",
  "sohu",
  "weixin",
]);

export type PublicationPlatformV3 = z.infer<typeof PublicationPlatformV3Schema>;

export const PublicationAdapterVersionV3Schema = z
  .string()
  .trim()
  .min(1)
  .max(PUBLICATION_ADAPTER_VERSION_MAX_LENGTH_V3)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._+-]*$/,
    "adapterVersion must be a stable, display-safe identifier",
  );

export type PublicationAdapterVersionV3 = z.infer<
  typeof PublicationAdapterVersionV3Schema
>;

export const PublicationAdapterCapabilityV3Schema = z.enum([
  "publication_inspect",
]);

export type PublicationAdapterCapabilityV3 = z.infer<
  typeof PublicationAdapterCapabilityV3Schema
>;

const UniqueCapabilitiesV3Schema = z
  .array(PublicationAdapterCapabilityV3Schema)
  .max(10)
  .superRefine((capabilities, ctx) => {
    if (new Set(capabilities).size !== capabilities.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "capabilities must not contain duplicates",
      });
    }
  });

export const PublicationPlatformCapabilityDescriptorV3Schema = z
  .object({
    contractVersion: PublicationContractVersionV3Schema,
    platform: PublicationPlatformV3Schema,
    adapterVersion: PublicationAdapterVersionV3Schema,
    capabilities: UniqueCapabilitiesV3Schema,
  })
  .strict();

export type PublicationPlatformCapabilityDescriptorV3 = z.infer<
  typeof PublicationPlatformCapabilityDescriptorV3Schema
>;

export const PublicationBridgeInfoV3Schema = z
  .object({
    contractVersion: PublicationContractVersionV3Schema,
    extensionVersion: z.string().trim().min(1).max(100),
    platforms: z
      .array(PublicationPlatformCapabilityDescriptorV3Schema)
      .max(PublicationPlatformV3Schema.options.length),
  })
  .strict()
  .superRefine((value, ctx) => {
    const platforms = value.platforms.map((descriptor) => descriptor.platform);
    if (new Set(platforms).size !== platforms.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "platform descriptors must be unique by platform",
        path: ["platforms"],
      });
    }
  });

export type PublicationBridgeInfoV3 = z.infer<
  typeof PublicationBridgeInfoV3Schema
>;

export const PublicationFailureStageV3Schema = z.enum([
  "PROTOCOL",
  "CAPABILITY",
  "TRANSPORT",
  "ADAPTER",
  "TIMEOUT",
  "UNKNOWN",
]);

export type PublicationFailureStageV3 = z.infer<
  typeof PublicationFailureStageV3Schema
>;

export const PublicationRequiredActionV3Schema = z.enum([
  "RETRY",
  "INSTALL_OR_UPGRADE_EXTENSION",
  "LOGIN",
  "SWITCH_ACCOUNT",
  "OPEN_PLATFORM",
  "REVIEW_MANUALLY",
]);

export type PublicationRequiredActionV3 = z.infer<
  typeof PublicationRequiredActionV3Schema
>;

export const PublicationFailureV3Schema = z
  .object({
    stage: PublicationFailureStageV3Schema,
    code: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(
        /^[A-Z][A-Z0-9_]*$/,
        "failure code must be stable SCREAMING_SNAKE_CASE",
      ),
    retryable: z.boolean(),
    message: z.string().trim().min(1).max(2_000),
    requiredAction: PublicationRequiredActionV3Schema.optional(),
  })
  .strict();

export type PublicationFailureV3 = z.infer<typeof PublicationFailureV3Schema>;

export const PublicationEvidenceSourceV3Schema = z.enum([
  "DRAFT_DETAIL",
  "DRAFT_LIST",
  "PLATFORM_DETAIL",
  "PUBLISHED_LIST",
  "PUBLIC_PAGE",
  "AUTHENTICATED_PUBLIC_PAGE",
]);

export type PublicationEvidenceSourceV3 = z.infer<
  typeof PublicationEvidenceSourceV3Schema
>;

export const PublicationPublicAccessV3Schema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("CONFIRMED"),
    })
    .strict(),
  z
    .object({
      status: z.literal("BLOCKED_BY_PLATFORM"),
      reasonCode: z.string().trim().min(1).max(100),
    })
    .strict(),
]);

export type PublicationPublicAccessV3 = z.infer<
  typeof PublicationPublicAccessV3Schema
>;

const ObservationIdentityV3Shape = {
  observationKey: z.string().trim().min(1).max(500),
  platform: PublicationPlatformV3Schema,
  externalAccountId: ExternalAccountIdV3Schema,
  observedAt: z.string().datetime({ offset: true }),
};

const ExactObservationIdentityV3Shape = {
  ...ObservationIdentityV3Shape,
  platformPostId: PlatformPostIdV3Schema,
};

const ErrorObservationIdentityV3Shape = {
  ...ObservationIdentityV3Shape,
  platformPostId: PlatformPostIdV3Schema.optional(),
};

const EvidenceErrorV3Shape = {
  errorCode: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(/^[A-Z][A-Z0-9_]*$/),
  errorMessage: z.string().trim().min(1).max(2_000),
};

const PublicationDraftPresentObservationV3Schema = z
  .object({
    ...ExactObservationIdentityV3Shape,
    outcome: z.literal("DRAFT_PRESENT"),
    source: z.enum(["DRAFT_DETAIL", "DRAFT_LIST", "PLATFORM_DETAIL"]),
    title: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

const PublicationPendingReviewObservationV3Schema = z
  .object({
    ...ExactObservationIdentityV3Shape,
    outcome: z.literal("PENDING_REVIEW"),
    source: z.enum(["DRAFT_DETAIL", "DRAFT_LIST", "PLATFORM_DETAIL"]),
    title: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

const PublicationRejectedObservationV3Schema = z
  .object({
    ...ExactObservationIdentityV3Shape,
    outcome: z.literal("REJECTED"),
    source: z.enum(["DRAFT_DETAIL", "DRAFT_LIST", "PLATFORM_DETAIL"]),
    title: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

const PublicationScheduledObservationV3Schema = z
  .object({
    ...ExactObservationIdentityV3Shape,
    outcome: z.literal("SCHEDULED"),
    source: z.enum(["DRAFT_DETAIL", "DRAFT_LIST", "PLATFORM_DETAIL"]),
    title: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

const PublicationNotFoundObservationV3Schema = z
  .object({
    ...ExactObservationIdentityV3Shape,
    outcome: z.literal("NOT_FOUND"),
    source: PublicationEvidenceSourceV3Schema,
  })
  .strict();

const PublicationDeletedObservationV3Schema = z
  .object({
    ...ExactObservationIdentityV3Shape,
    outcome: z.literal("DELETED"),
    source: PublicationEvidenceSourceV3Schema,
  })
  .strict();

const PublicationReviewRequiredObservationV3Schema = z
  .object({
    ...ErrorObservationIdentityV3Shape,
    ...EvidenceErrorV3Shape,
    outcome: z.literal("REVIEW_REQUIRED"),
    source: PublicationEvidenceSourceV3Schema,
  })
  .strict();

const PublicationAccountMismatchObservationV3Schema = z
  .object({
    ...ErrorObservationIdentityV3Shape,
    ...EvidenceErrorV3Shape,
    outcome: z.literal("ACCOUNT_MISMATCH"),
    source: PublicationEvidenceSourceV3Schema,
    observedExternalAccountId: ExternalAccountIdV3Schema.optional(),
  })
  .strict();

const PublicationLoginRequiredObservationV3Schema = z
  .object({
    ...ErrorObservationIdentityV3Shape,
    ...EvidenceErrorV3Shape,
    outcome: z.literal("LOGIN_REQUIRED"),
    source: PublicationEvidenceSourceV3Schema,
  })
  .strict();

const PublicationUnsupportedObservationV3Schema = z
  .object({
    ...ErrorObservationIdentityV3Shape,
    ...EvidenceErrorV3Shape,
    outcome: z.literal("UNSUPPORTED"),
    source: PublicationEvidenceSourceV3Schema,
  })
  .strict();

const PublicationFetchErrorObservationV3Schema = z
  .object({
    ...ErrorObservationIdentityV3Shape,
    ...EvidenceErrorV3Shape,
    outcome: z.literal("FETCH_ERROR"),
    source: PublicationEvidenceSourceV3Schema,
  })
  .strict();

const PublicationParseErrorObservationV3Schema = z
  .object({
    ...ErrorObservationIdentityV3Shape,
    ...EvidenceErrorV3Shape,
    outcome: z.literal("PARSE_ERROR"),
    source: PublicationEvidenceSourceV3Schema,
  })
  .strict();

const PublicationPublishedObservationV3Schema = z
  .object({
    ...ExactObservationIdentityV3Shape,
    outcome: z.literal("PUBLISHED"),
    source: z.enum(["PUBLIC_PAGE", "AUTHENTICATED_PUBLIC_PAGE"]),
    canonicalUrl: StrictHttpUrlV3Schema,
    publishedAt: z.string().datetime({ offset: true }),
    publicAccess: PublicationPublicAccessV3Schema,
    observedAuthorExternalAccountId: ExternalAccountIdV3Schema,
    title: z.string().trim().min(1).max(500),
    bodyText: z.string().min(1).max(50_000),
    bodyTruncated: z.boolean(),
  })
  .strict();

export const PublicationObservationV3Schema = z
  .discriminatedUnion("outcome", [
    PublicationDraftPresentObservationV3Schema,
    PublicationPendingReviewObservationV3Schema,
    PublicationRejectedObservationV3Schema,
    PublicationScheduledObservationV3Schema,
    PublicationPublishedObservationV3Schema,
    PublicationNotFoundObservationV3Schema,
    PublicationDeletedObservationV3Schema,
    PublicationReviewRequiredObservationV3Schema,
    PublicationAccountMismatchObservationV3Schema,
    PublicationLoginRequiredObservationV3Schema,
    PublicationUnsupportedObservationV3Schema,
    PublicationFetchErrorObservationV3Schema,
    PublicationParseErrorObservationV3Schema,
  ])
  .superRefine((value, ctx) => {
    if (value.outcome !== "PUBLISHED") return;

    const hasConfirmedPublicAccess =
      value.source === "PUBLIC_PAGE" &&
      value.publicAccess.status === "CONFIRMED";
    const hasAuthenticatedBlockedAccess =
      value.source === "AUTHENTICATED_PUBLIC_PAGE" &&
      value.publicAccess.status === "BLOCKED_BY_PLATFORM";

    if (!hasConfirmedPublicAccess && !hasAuthenticatedBlockedAccess) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "public access evidence must match the published observation source",
        path: ["publicAccess"],
      });
    }
  });

export type PublicationObservationV3 = z.infer<
  typeof PublicationObservationV3Schema
>;

export const PublicationInspectRequestV3Schema = z
  .object({
    contractVersion: PublicationContractVersionV3Schema,
    requestId: RequestIdV3Schema,
    platform: PublicationPlatformV3Schema,
    externalAccountId: ExternalAccountIdV3Schema,
    draft: z
      .object({
        platformPostId: PlatformPostIdV3Schema.optional(),
        draftUrl: StrictHttpUrlV3Schema.optional(),
        draftedAt: z.string().datetime({ offset: true }),
      })
      .strict(),
    articleHint: z
      .object({
        title: z.string().trim().min(1).max(500),
        publishedAfter: z.string().datetime({ offset: true }).optional(),
        publishedBefore: z.string().datetime({ offset: true }).optional(),
      })
      .strict(),
    limit: z.number().int().min(1).max(20),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.draft.platformPostId && !value.draft.draftUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "inspection requires an exact post ID or draft URL",
        path: ["draft"],
      });
    }
  });

export type PublicationInspectRequestV3 = z.infer<
  typeof PublicationInspectRequestV3Schema
>;

const PublicationInspectSuccessV3Schema = z
  .object({
    contractVersion: PublicationContractVersionV3Schema,
    requestId: RequestIdV3Schema,
    platform: PublicationPlatformV3Schema,
    externalAccountId: ExternalAccountIdV3Schema,
    adapterVersion: PublicationAdapterVersionV3Schema,
    ok: z.literal(true),
    observations: z.array(PublicationObservationV3Schema).min(1).max(20),
  })
  .strict();

const PublicationInspectFailureV3Schema = z
  .object({
    contractVersion: PublicationContractVersionV3Schema,
    requestId: RequestIdV3Schema,
    platform: PublicationPlatformV3Schema,
    externalAccountId: ExternalAccountIdV3Schema,
    adapterVersion: PublicationAdapterVersionV3Schema,
    ok: z.literal(false),
    failure: PublicationFailureV3Schema,
  })
  .strict();

export const PublicationInspectResultV3Schema = z
  .discriminatedUnion("ok", [
    PublicationInspectSuccessV3Schema,
    PublicationInspectFailureV3Schema,
  ])
  .superRefine((value, ctx) => {
    if (!value.ok) return;

    const observationKeys = value.observations.map(
      (observation) => observation.observationKey,
    );
    if (new Set(observationKeys).size !== observationKeys.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "observation keys must be unique within a response",
        path: ["observations"],
      });
    }

    value.observations.forEach((observation, index) => {
      if (observation.platform !== value.platform) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "observation platform must match the response envelope",
          path: ["observations", index, "platform"],
        });
      }
      if (observation.externalAccountId !== value.externalAccountId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "observation account identity must match the response envelope",
          path: ["observations", index, "externalAccountId"],
        });
      }
      if (
        observation.outcome === "PUBLISHED" &&
        observation.observedAuthorExternalAccountId !== value.externalAccountId
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "published author identity must match the response account identity",
          path: ["observations", index, "observedAuthorExternalAccountId"],
        });
      }
    });
  });

export type PublicationInspectResultV3 = z.infer<
  typeof PublicationInspectResultV3Schema
>;
