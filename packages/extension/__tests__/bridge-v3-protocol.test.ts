import {
  INVALID_PUBLICATION_BRIDGE_V3_FIXTURES,
  VALID_PUBLICATION_BRIDGE_V3_FIXTURES,
  publicationBridgeV3AccountsRequestFixture,
  publicationBridgeV3AccountsResponseFixture,
  publicationBridgeV3CompletedOperationFixture,
  publicationBridgeV3GetOperationRequestFixture,
  publicationBridgeV3GetOperationResponseFixture,
  publicationBridgeV3InspectRequestFixture,
  publicationBridgeV3InspectResponseFixture,
  publicationBridgeV3NegotiationRequestFixture,
  publicationBridgeV3NegotiationResponseFixture,
  publicationBridgeV3OpenDraftRequestFixture,
  publicationBridgeV3OpenDraftResponseFixture,
  publicationBridgeV3PublishAcceptedResponseFixture,
  publicationBridgeV3PublishReplayRequestFixture,
  publicationBridgeV3PublishReplayedResponseFixture,
  publicationBridgeV3PublishRequestFixture,
  publicationBridgeV3RunningOperationFixture,
} from "@byfire-dev/publication-bridge-contract/v3/testing";
import { describe, expect, it } from "vitest";

import {
  BRIDGE_API_VERSION,
  BRIDGE_DIRECTIONS,
  BRIDGE_NAMESPACE,
  getPublicationBridgeOperationToRunV3,
  parseBridgeRequestEvent,
  parsePublicationBridgeRequestEventV3,
  parsePublicationBridgeResponseEventV3,
  parsePublicationBridgeResponseForRequestV3,
  type BridgeMessageEventLike,
  type PublicationBridgeV3Request,
  type PublicationBridgeV3Response,
} from "../src/bridge";

const topWindow = { kind: "top-window" };

function requestEvent(
  data: unknown,
  overrides: Partial<BridgeMessageEventLike> = {},
): BridgeMessageEventLike {
  return {
    origin: "http://localhost",
    source: topWindow,
    data,
    ...overrides,
  };
}

function parseRequest(data: unknown): PublicationBridgeV3Request {
  const parsed = parsePublicationBridgeRequestEventV3(
    requestEvent(data),
    topWindow,
  );
  if (!parsed.success) throw new Error("expected a valid v3 request fixture");
  return parsed.data;
}

function parseResponse(data: unknown): PublicationBridgeV3Response {
  const parsed = parsePublicationBridgeResponseEventV3(
    requestEvent(data),
    topWindow,
  );
  if (!parsed.success) throw new Error("expected a valid v3 response fixture");
  return parsed.data;
}

describe("published publication Bridge v3 boundary", () => {
  it("accepts every published request and response fixture", () => {
    for (const request of VALID_PUBLICATION_BRIDGE_V3_FIXTURES.requests) {
      expect(
        parsePublicationBridgeRequestEventV3(requestEvent(request), topWindow),
      ).toMatchObject({ success: true });
    }

    for (const response of VALID_PUBLICATION_BRIDGE_V3_FIXTURES.responses) {
      expect(
        parsePublicationBridgeResponseEventV3(
          requestEvent(response),
          topWindow,
        ),
      ).toMatchObject({ success: true });
    }
  });

  it("fails closed for a foreign source, unlisted origin, or malformed envelope", () => {
    expect(
      parsePublicationBridgeRequestEventV3(
        requestEvent(publicationBridgeV3NegotiationRequestFixture, {
          source: { kind: "foreign-frame" },
        }),
        topWindow,
      ),
    ).toEqual({ success: false, code: "SOURCE_MISMATCH" });

    expect(
      parsePublicationBridgeRequestEventV3(
        requestEvent(publicationBridgeV3NegotiationRequestFixture, {
          origin: "https://evil.example",
        }),
        topWindow,
      ),
    ).toEqual({ success: false, code: "ORIGIN_NOT_ALLOWED" });

    const invalidRequest = INVALID_PUBLICATION_BRIDGE_V3_FIXTURES.find(
      (fixture) => fixture.schema === "request",
    );
    expect(invalidRequest).toBeDefined();
    expect(
      parsePublicationBridgeRequestEventV3(
        requestEvent(invalidRequest?.value),
        topWindow,
      ),
    ).toEqual({ success: false, code: "INVALID_ENVELOPE" });
  });

  it("keeps v2 and the published v3 namespace strictly separate", () => {
    expect(
      parseBridgeRequestEvent(
        requestEvent(publicationBridgeV3NegotiationRequestFixture),
        topWindow,
      ),
    ).toEqual({ success: false, code: "INVALID_ENVELOPE" });

    const v2Request = {
      namespace: BRIDGE_NAMESPACE,
      apiVersion: BRIDGE_API_VERSION,
      direction: BRIDGE_DIRECTIONS.request,
      requestId: "v2-info",
      method: "getBridgeInfo",
      payload: {},
    };
    expect(
      parsePublicationBridgeRequestEventV3(requestEvent(v2Request), topWindow),
    ).toEqual({ success: false, code: "INVALID_ENVELOPE" });
    expect(
      parseBridgeRequestEvent(requestEvent(v2Request), topWindow),
    ).toMatchObject({
      success: true,
      data: { method: "getBridgeInfo" },
    });
  });
});

describe("publication Bridge v3 request/response correlation", () => {
  it.each([
    [
      publicationBridgeV3NegotiationRequestFixture,
      publicationBridgeV3NegotiationResponseFixture,
    ],
    [
      publicationBridgeV3AccountsRequestFixture,
      publicationBridgeV3AccountsResponseFixture,
    ],
    [
      publicationBridgeV3PublishRequestFixture,
      publicationBridgeV3PublishAcceptedResponseFixture,
    ],
    [
      publicationBridgeV3PublishReplayRequestFixture,
      publicationBridgeV3PublishReplayedResponseFixture,
    ],
    [
      publicationBridgeV3GetOperationRequestFixture,
      publicationBridgeV3GetOperationResponseFixture,
    ],
    [
      publicationBridgeV3InspectRequestFixture,
      publicationBridgeV3InspectResponseFixture,
    ],
    [
      publicationBridgeV3OpenDraftRequestFixture,
      publicationBridgeV3OpenDraftResponseFixture,
    ],
  ])(
    "accepts a fully correlated published exchange",
    (requestFixture, responseFixture) => {
      const request = parseRequest(requestFixture);
      const response = parsePublicationBridgeResponseForRequestV3(
        request,
        responseFixture,
      );
      expect(response).toMatchObject({ success: true });
    },
  );

  it("rejects a schema-valid response with mismatched correlation fields", () => {
    const request = parseRequest(publicationBridgeV3InspectRequestFixture);
    expect(
      parsePublicationBridgeResponseForRequestV3(request, {
        ...publicationBridgeV3InspectResponseFixture,
        requestId: "req-other-001",
      }),
    ).toEqual({ success: false, code: "INVALID_PAYLOAD" });
    expect(
      parsePublicationBridgeResponseForRequestV3(request, {
        ...publicationBridgeV3InspectResponseFixture,
        operationId: "op-other-001",
      }),
    ).toEqual({ success: false, code: "INVALID_PAYLOAD" });
    expect(
      parsePublicationBridgeResponseForRequestV3(request, {
        ...publicationBridgeV3InspectResponseFixture,
        sessionId: "session-other-001",
      }),
    ).toEqual({ success: false, code: "INVALID_PAYLOAD" });
  });
});

describe("publication Bridge v3 MV3 operation handoff", () => {
  it("runs accepted and incomplete replayed operations by the result operation id", () => {
    const acceptedRequest = parseRequest(
      publicationBridgeV3PublishRequestFixture,
    );
    const acceptedResponse = parseResponse(
      publicationBridgeV3PublishAcceptedResponseFixture,
    );
    expect(
      getPublicationBridgeOperationToRunV3(acceptedRequest, acceptedResponse),
    ).toBe(
      publicationBridgeV3PublishAcceptedResponseFixture.result.operation
        .operationId,
    );

    const replayRequest = parseRequest(
      publicationBridgeV3PublishReplayRequestFixture,
    );
    const incompleteReplay = parseResponse({
      ...publicationBridgeV3PublishReplayedResponseFixture,
      result: {
        ...publicationBridgeV3PublishReplayedResponseFixture.result,
        operation: publicationBridgeV3RunningOperationFixture,
      },
    });
    expect(
      getPublicationBridgeOperationToRunV3(replayRequest, incompleteReplay),
    ).toBe(publicationBridgeV3RunningOperationFixture.operationId);
  });

  it("does not run a completed replay or a non-publish exchange", () => {
    const replayRequest = parseRequest(
      publicationBridgeV3PublishReplayRequestFixture,
    );
    const completedReplay = parseResponse({
      ...publicationBridgeV3PublishReplayedResponseFixture,
      result: {
        ...publicationBridgeV3PublishReplayedResponseFixture.result,
        operation: publicationBridgeV3CompletedOperationFixture,
      },
    });
    expect(
      getPublicationBridgeOperationToRunV3(replayRequest, completedReplay),
    ).toBeNull();

    expect(
      getPublicationBridgeOperationToRunV3(
        parseRequest(publicationBridgeV3NegotiationRequestFixture),
        parseResponse(publicationBridgeV3NegotiationResponseFixture),
      ),
    ).toBeNull();
  });
});
