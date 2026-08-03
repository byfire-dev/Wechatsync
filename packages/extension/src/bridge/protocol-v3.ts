import {
  PublicationBridgeV3CommandExchangeSchema,
  PublicationBridgeV3NegotiationExchangeSchema,
  PublicationBridgeV3RequestSchema,
  PublicationBridgeV3ResponseSchema,
  type PublicationBridgeV3Request,
  type PublicationBridgeV3Response,
} from "@byfire-dev/publication-bridge-contract/v3";

import {
  DEFAULT_BRIDGE_ALLOWED_ORIGINS,
  isAllowedBridgeOrigin,
  type BridgeMessageEventLike,
  type BridgeParseResult,
} from "./protocol";

function validateEventBoundary(
  event: BridgeMessageEventLike,
  expectedSource: unknown,
  allowedOrigins: readonly string[],
): BridgeParseResult<never> | null {
  if (event.source !== expectedSource) {
    return { success: false, code: "SOURCE_MISMATCH" };
  }
  if (!isAllowedBridgeOrigin(event.origin, allowedOrigins)) {
    return { success: false, code: "ORIGIN_NOT_ALLOWED" };
  }
  return null;
}

/**
 * Parse the page-to-extension v3 boundary with the published contract package.
 * No local envelope or command union is maintained in Wechatsync.
 */
export function parsePublicationBridgeRequestEventV3(
  event: BridgeMessageEventLike,
  expectedSource: unknown,
  allowedOrigins: readonly string[] = DEFAULT_BRIDGE_ALLOWED_ORIGINS,
): BridgeParseResult<PublicationBridgeV3Request> {
  const boundaryFailure = validateEventBoundary(
    event,
    expectedSource,
    allowedOrigins,
  );
  if (boundaryFailure) return boundaryFailure;

  const parsed = PublicationBridgeV3RequestSchema.safeParse(event.data);
  if (!parsed.success) {
    return { success: false, code: "INVALID_ENVELOPE" };
  }
  return { success: true, data: parsed.data };
}

/** Test helper for the extension-to-page side of the same raw transport. */
export function parsePublicationBridgeResponseEventV3(
  event: BridgeMessageEventLike,
  expectedSource: unknown,
  allowedOrigins: readonly string[] = DEFAULT_BRIDGE_ALLOWED_ORIGINS,
): BridgeParseResult<PublicationBridgeV3Response> {
  const boundaryFailure = validateEventBoundary(
    event,
    expectedSource,
    allowedOrigins,
  );
  if (boundaryFailure) return boundaryFailure;

  const parsed = PublicationBridgeV3ResponseSchema.safeParse(event.data);
  if (!parsed.success) {
    return { success: false, code: "INVALID_ENVELOPE" };
  }
  return { success: true, data: parsed.data };
}

/**
 * Validate a background response against both the public response schema and
 * the request/response correlation rules published by the contract package.
 */
export function parsePublicationBridgeResponseForRequestV3(
  request: PublicationBridgeV3Request,
  response: unknown,
): BridgeParseResult<PublicationBridgeV3Response> {
  const parsedResponse = PublicationBridgeV3ResponseSchema.safeParse(response);
  if (!parsedResponse.success) {
    return { success: false, code: "INVALID_ENVELOPE" };
  }

  const parsedExchange =
    request.command === "bridge.negotiate"
      ? PublicationBridgeV3NegotiationExchangeSchema.safeParse({
          request,
          response: parsedResponse.data,
        })
      : PublicationBridgeV3CommandExchangeSchema.safeParse({
          request,
          response: parsedResponse.data,
        });

  if (!parsedExchange.success) {
    return { success: false, code: "INVALID_PAYLOAD" };
  }

  return { success: true, data: parsedResponse.data };
}

/**
 * A publish acceptance is posted to the page immediately. The returned
 * operation id is then used by the content script to open a second, long-lived
 * runtime message that keeps the MV3 worker alive until the write settles.
 */
export function getPublicationBridgeOperationToRunV3(
  request: PublicationBridgeV3Request,
  response: PublicationBridgeV3Response,
): string | null {
  if (
    request.command !== "publication.publishDraft" ||
    response.command !== "publication.publishDraft" ||
    !response.ok ||
    (response.result.disposition !== "ACCEPTED" &&
      response.result.disposition !== "REPLAYED") ||
    response.result.operation.state === "COMPLETED"
  ) {
    return null;
  }

  return response.result.operation.operationId;
}

export type {
  PublicationBridgeV3Request,
  PublicationBridgeV3Response,
} from "@byfire-dev/publication-bridge-contract/v3";
