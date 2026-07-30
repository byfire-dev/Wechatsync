import {
  PublicationInspectionRequestSchema,
  PublicationPublishedProofSchema,
  type PublicationInspectionObservation,
  type PublicationInspectionRequest,
} from "@wechatsync/core/publication-inspection";
import {
  PUBLICATION_CONTRACT_VERSION_V3,
  PUBLICATION_REQUEST_ID_MAX_LENGTH_V3,
  PublicationBridgeInfoV3Schema,
  PublicationInspectRequestV3Schema,
  PublicationInspectResultV3Schema,
  PublicationObservationV3Schema,
  PublicationPlatformV3Schema,
  type PublicationBridgeInfoV3,
  type PublicationInspectRequestV3,
  type PublicationInspectResultV3,
  type PublicationObservationV3,
  type PublicationPlatformV3,
} from "@wechatsync/publication-contract/v3";

import {
  runInternalPublicationInspection,
  type PublicationInspectionRunnerFailureCode,
  type PublicationInspectorAdapter,
} from "./publication-inspection-runner";

const INFO_PAYLOAD_KEYS = new Set<string>();

type V3Failure = Extract<PublicationInspectResultV3, { ok: false }>["failure"];

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>,
): boolean {
  return (
    Object.getOwnPropertySymbols(value).length === 0 &&
    Object.keys(value).every((key) => allowedKeys.has(key))
  );
}

function isCanonicalRequestId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  return (
    value.length > 0 &&
    value.length <= PUBLICATION_REQUEST_ID_MAX_LENGTH_V3 &&
    value.trim() === value
  );
}

export function validatePublicationBridgeInfoPayloadV3(
  payload: unknown,
  envelopeRequestId: unknown,
): boolean {
  return (
    isCanonicalRequestId(envelopeRequestId) &&
    isRecord(payload) &&
    hasOnlyKeys(payload, INFO_PAYLOAD_KEYS)
  );
}

/**
 * Revalidates the v3 request at the background trust boundary and binds the
 * contract request ID to the runtime-message envelope.
 */
export function validatePublicationInspectPayloadV3(
  payload: unknown,
  envelopeRequestId: unknown,
):
  | { success: true; data: PublicationInspectRequestV3 }
  | { success: false; code: "INVALID_PAYLOAD" } {
  const parsed = PublicationInspectRequestV3Schema.safeParse(payload);
  if (
    !parsed.success ||
    !isCanonicalRequestId(envelopeRequestId) ||
    parsed.data.requestId !== envelopeRequestId
  ) {
    return { success: false, code: "INVALID_PAYLOAD" };
  }
  return { success: true, data: parsed.data };
}

export function buildPublicationBridgeInfoV3(
  registeredInspectorPlatforms: readonly PublicationPlatformV3[],
  extensionVersion: string,
): PublicationBridgeInfoV3 {
  const uniquePlatforms = [...new Set(registeredInspectorPlatforms)];
  return PublicationBridgeInfoV3Schema.parse({
    contractVersion: PUBLICATION_CONTRACT_VERSION_V3,
    extensionVersion,
    platforms: uniquePlatforms.map((platform) => ({
      contractVersion: PUBLICATION_CONTRACT_VERSION_V3,
      platform,
      adapterVersion: extensionVersion,
      capabilities: ["publication_inspect"],
    })),
  });
}

function toInternalRequest(
  request: PublicationInspectRequestV3,
): PublicationInspectionRequest {
  return PublicationInspectionRequestSchema.parse({
    requestId: request.requestId,
    platform: request.platform,
    externalAccountId: request.externalAccountId,
    draft: request.draft,
    articleHint: request.articleHint,
    limit: request.limit,
  });
}

function failureResult(
  request: PublicationInspectRequestV3,
  adapterVersion: string,
  failure: V3Failure,
): PublicationInspectResultV3 {
  return PublicationInspectResultV3Schema.parse({
    contractVersion: PUBLICATION_CONTRACT_VERSION_V3,
    requestId: request.requestId,
    platform: request.platform,
    externalAccountId: request.externalAccountId,
    adapterVersion,
    ok: false,
    failure,
  });
}

function commandFailureFor(
  errorCode: PublicationInspectionRunnerFailureCode,
): V3Failure {
  if (errorCode === "PUBLICATION_INSPECTION_TIMEOUT") {
    return {
      stage: "TIMEOUT",
      code: errorCode,
      retryable: true,
      message: "The publication inspection timed out.",
      requiredAction: "RETRY",
    };
  }
  if (errorCode === "PUBLICATION_INSPECTION_FAILED") {
    return {
      stage: "ADAPTER",
      code: errorCode,
      retryable: true,
      message: "The publication inspector failed.",
      requiredAction: "RETRY",
    };
  }
  if (
    errorCode === "INVALID_INSPECTION_RESULT" ||
    errorCode === "INVALID_INSPECTION_REQUEST"
  ) {
    return {
      stage: "PROTOCOL",
      code:
        errorCode === "INVALID_INSPECTION_REQUEST"
          ? "INVALID_INSPECTION_REQUEST"
          : "INVALID_INSPECTION_RESULT",
      retryable: false,
      message: "The publication inspector returned an invalid result.",
      requiredAction: "INSTALL_OR_UPGRADE_EXTENSION",
    };
  }
  return {
    stage: "CAPABILITY",
    code: "PUBLICATION_INSPECTION_NOT_IMPLEMENTED",
    retryable: false,
    message: "Publication inspection is not available for this platform.",
    requiredAction: "INSTALL_OR_UPGRADE_EXTENSION",
  };
}

function publicAccessMatches(
  left: NonNullable<PublicationInspectionObservation["publicAccess"]>,
  right: NonNullable<PublicationInspectionObservation["publicAccess"]>,
): boolean {
  if (left.status !== right.status) return false;
  return (
    left.status === "CONFIRMED" ||
    (right.status === "BLOCKED_BY_PLATFORM" &&
      left.reasonCode === right.reasonCode)
  );
}

function publishedObservationV3(
  request: PublicationInspectionRequest,
  observation: PublicationInspectionObservation,
  adapter: PublicationInspectorAdapter,
): PublicationObservationV3 | null {
  if (
    observation.errorCode !== undefined ||
    observation.errorMessage !== undefined ||
    !observation.platformPostId ||
    !observation.canonicalUrl ||
    !observation.publishedAt ||
    !observation.title?.trim() ||
    !observation.bodyText?.trim() ||
    typeof observation.bodyTruncated !== "boolean" ||
    !adapter.provePublishedObservation
  ) {
    return null;
  }

  let untrustedProof: unknown;
  try {
    untrustedProof = adapter.provePublishedObservation(request, observation);
  } catch {
    return null;
  }
  const parsedProof = PublicationPublishedProofSchema.safeParse(untrustedProof);
  if (!parsedProof.success) return null;

  const proof = parsedProof.data;
  if (
    proof.observedAuthorExternalAccountId !== observation.externalAccountId ||
    proof.observedAuthorExternalAccountId !== request.externalAccountId ||
    proof.bodyTruncated !== observation.bodyTruncated ||
    (observation.publicAccess !== undefined &&
      !publicAccessMatches(proof.publicAccess, observation.publicAccess))
  ) {
    return null;
  }

  const parsed = PublicationObservationV3Schema.safeParse({
    observationKey: observation.observationKey,
    platform: observation.platform,
    externalAccountId: observation.externalAccountId,
    outcome: "PUBLISHED",
    source: observation.source,
    platformPostId: observation.platformPostId,
    canonicalUrl: observation.canonicalUrl,
    publishedAt: observation.publishedAt,
    publicAccess: proof.publicAccess,
    observedAuthorExternalAccountId: proof.observedAuthorExternalAccountId,
    title: observation.title,
    bodyText: observation.bodyText,
    bodyTruncated: proof.bodyTruncated,
    observedAt: observation.observedAt,
  });
  return parsed.success ? parsed.data : null;
}

function projectObservationV3(
  request: PublicationInspectionRequest,
  observation: PublicationInspectionObservation,
  adapter: PublicationInspectorAdapter,
): PublicationObservationV3 | null {
  if (observation.outcome === "PUBLISHED") {
    return publishedObservationV3(request, observation, adapter);
  }

  const identity = {
    observationKey: observation.observationKey,
    platform: observation.platform,
    externalAccountId: observation.externalAccountId,
    ...(observation.platformPostId
      ? { platformPostId: observation.platformPostId }
      : {}),
    observedAt: observation.observedAt,
  };

  let candidate: unknown;
  switch (observation.outcome) {
    case "DRAFT_PRESENT":
    case "PENDING_REVIEW":
    case "REJECTED":
    case "SCHEDULED":
      candidate = {
        ...identity,
        outcome: observation.outcome,
        source: observation.source,
        ...(observation.title ? { title: observation.title } : {}),
      };
      break;
    case "NOT_FOUND":
    case "DELETED":
      candidate = {
        ...identity,
        outcome: observation.outcome,
        source: observation.source,
      };
      break;
    case "REVIEW_REQUIRED":
    case "LOGIN_REQUIRED":
    case "UNSUPPORTED":
    case "FETCH_ERROR":
    case "PARSE_ERROR":
      candidate = {
        ...identity,
        outcome: observation.outcome,
        source: observation.source,
        errorCode: observation.errorCode,
        errorMessage: observation.errorMessage,
      };
      break;
    case "ACCOUNT_MISMATCH":
      candidate = {
        ...identity,
        outcome: observation.outcome,
        source: observation.source,
        errorCode: observation.errorCode,
        errorMessage: observation.errorMessage,
      };
      break;
  }

  const parsed = PublicationObservationV3Schema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

export async function runPublicationInspectionV3(
  untrustedRequest: PublicationInspectRequestV3,
  adapter: PublicationInspectorAdapter | null,
  adapterVersion: string,
  timeoutMs?: number,
): Promise<PublicationInspectResultV3> {
  const request = PublicationInspectRequestV3Schema.parse(untrustedRequest);

  if (
    !adapter?.inspectPublication ||
    !adapter.provePublishedObservation ||
    !PublicationPlatformV3Schema.safeParse(request.platform).success
  ) {
    return failureResult(request, adapterVersion, {
      stage: "CAPABILITY",
      code: "PUBLICATION_INSPECTION_NOT_IMPLEMENTED",
      retryable: false,
      message: "Publication inspection is not available for this platform.",
      requiredAction: "INSTALL_OR_UPGRADE_EXTENSION",
    });
  }

  let internalRequest: PublicationInspectionRequest;
  try {
    internalRequest = toInternalRequest(request);
  } catch {
    return failureResult(request, adapterVersion, {
      stage: "PROTOCOL",
      code: "INVALID_INSPECTION_REQUEST",
      retryable: false,
      message: "The v3 request is not compatible with the active inspector.",
      requiredAction: "INSTALL_OR_UPGRADE_EXTENSION",
    });
  }

  const inspection = await runInternalPublicationInspection(
    internalRequest,
    adapter,
    { timeoutMs },
  );
  if (!inspection.ok) {
    return failureResult(
      request,
      adapterVersion,
      commandFailureFor(inspection.code),
    );
  }

  const observations = inspection.observations.map((observation) =>
    projectObservationV3(internalRequest, observation, adapter),
  );
  if (
    observations.length === 0 ||
    observations.some(
      (observation): observation is null => observation === null,
    )
  ) {
    return failureResult(request, adapterVersion, {
      stage: "PROTOCOL",
      code: "INVALID_INSPECTION_RESULT",
      retryable: false,
      message: "The publication inspector returned an invalid result.",
      requiredAction: "INSTALL_OR_UPGRADE_EXTENSION",
    });
  }

  const result = PublicationInspectResultV3Schema.safeParse({
    contractVersion: PUBLICATION_CONTRACT_VERSION_V3,
    requestId: request.requestId,
    platform: request.platform,
    externalAccountId: request.externalAccountId,
    adapterVersion,
    ok: true,
    observations,
  });
  if (result.success) return result.data;

  return failureResult(request, adapterVersion, {
    stage: "PROTOCOL",
    code: "INVALID_INSPECTION_RESULT",
    retryable: false,
    message: "The publication inspector returned an invalid result.",
    requiredAction: "INSTALL_OR_UPGRADE_EXTENSION",
  });
}
