import { describe, expect, it } from "vitest";

import {
  BRIDGE_DIRECTIONS,
  BRIDGE_NAMESPACE,
  PUBLICATION_BRIDGE_API_VERSION_V3,
  createPublicationBridgeErrorResponseV3,
  createPublicationBridgeSuccessResponseV3,
  parseBridgeRequestEvent,
  parsePublicationBridgeRequestEventV3,
  parsePublicationBridgeResponseEventV3,
  type BridgeMessageEventLike,
} from "../src/bridge";

const topWindow = { kind: "top-window" };

const inspectRequest = {
  contractVersion: "3.0" as const,
  requestId: "inspect-v3-001",
  platform: "zhihu" as const,
  externalAccountId: "zhihu-user-1",
  draft: {
    platformPostId: "123456789",
    draftedAt: "2026-07-29T08:00:00.000Z",
  },
  articleHint: {
    title: "Bridge v3 article",
  },
  limit: 20,
};

function requestEvent(
  overrides: Partial<BridgeMessageEventLike> = {},
): BridgeMessageEventLike {
  return {
    origin: "http://localhost",
    source: topWindow,
    data: {
      namespace: BRIDGE_NAMESPACE,
      apiVersion: PUBLICATION_BRIDGE_API_VERSION_V3,
      direction: BRIDGE_DIRECTIONS.request,
      requestId: "info-v3-001",
      method: "getPublicationBridgeInfoV3",
      payload: {},
    },
    ...overrides,
  };
}

describe("publication Bridge v3 request protocol", () => {
  it("allows only the two explicit v3 methods with contract-validated payloads", () => {
    expect(
      parsePublicationBridgeRequestEventV3(requestEvent(), topWindow),
    ).toMatchObject({
      success: true,
      data: { method: "getPublicationBridgeInfoV3" },
    });

    expect(
      parsePublicationBridgeRequestEventV3(
        requestEvent({
          data: {
            namespace: BRIDGE_NAMESPACE,
            apiVersion: PUBLICATION_BRIDGE_API_VERSION_V3,
            direction: BRIDGE_DIRECTIONS.request,
            requestId: inspectRequest.requestId,
            method: "inspectPublicationV3",
            payload: inspectRequest,
          },
        }),
        topWindow,
      ),
    ).toMatchObject({
      success: true,
      data: {
        method: "inspectPublicationV3",
        payload: inspectRequest,
      },
    });
  });

  it.each([
    "inspectPublication",
    "getBridgeInfo",
    "magicCall",
    "inspectPublicationV4",
  ])("rejects non-v3 method %s", (method) => {
    expect(
      parsePublicationBridgeRequestEventV3(
        requestEvent({
          data: {
            namespace: BRIDGE_NAMESPACE,
            apiVersion: PUBLICATION_BRIDGE_API_VERSION_V3,
            direction: BRIDGE_DIRECTIONS.request,
            requestId: "bad-method-v3",
            method,
            payload: {},
          },
        }),
        topWindow,
      ),
    ).toEqual({ success: false, code: "METHOD_NOT_ALLOWED" });
  });

  it.each([
    "https://evil.example",
    "http://localhost:3000",
    "http://127.0.0.1",
    "http://localhost.evil.example",
  ])("rejects unlisted origin %s", (origin) => {
    expect(
      parsePublicationBridgeRequestEventV3(requestEvent({ origin }), topWindow),
    ).toEqual({ success: false, code: "ORIGIN_NOT_ALLOWED" });
  });

  it("rejects foreign frames, unknown fields and request-ID mismatches", () => {
    expect(
      parsePublicationBridgeRequestEventV3(
        requestEvent({ source: { kind: "child-frame" } }),
        topWindow,
      ),
    ).toEqual({ success: false, code: "SOURCE_MISMATCH" });

    expect(
      parsePublicationBridgeRequestEventV3(
        requestEvent({
          data: {
            namespace: BRIDGE_NAMESPACE,
            apiVersion: PUBLICATION_BRIDGE_API_VERSION_V3,
            direction: BRIDGE_DIRECTIONS.request,
            requestId: "info-v3-001",
            method: "getPublicationBridgeInfoV3",
            payload: { unexpected: true },
          },
        }),
        topWindow,
      ),
    ).toEqual({ success: false, code: "INVALID_PAYLOAD" });

    expect(
      parsePublicationBridgeRequestEventV3(
        requestEvent({
          data: {
            namespace: BRIDGE_NAMESPACE,
            apiVersion: PUBLICATION_BRIDGE_API_VERSION_V3,
            direction: BRIDGE_DIRECTIONS.request,
            requestId: "another-id",
            method: "inspectPublicationV3",
            payload: inspectRequest,
          },
        }),
        topWindow,
      ),
    ).toEqual({ success: false, code: "INVALID_PAYLOAD" });

    expect(
      parsePublicationBridgeRequestEventV3(
        requestEvent({
          data: {
            ...(requestEvent().data as Record<string, unknown>),
            unexpected: true,
          },
        }),
        topWindow,
      ),
    ).toEqual({ success: false, code: "INVALID_ENVELOPE" });
  });
});

describe("publication Bridge v3 response protocol", () => {
  it("strictly creates and parses bridge info from runtime descriptors", () => {
    const parsed = parsePublicationBridgeRequestEventV3(
      requestEvent(),
      topWindow,
    );
    if (
      !parsed.success ||
      parsed.data.method !== "getPublicationBridgeInfoV3"
    ) {
      throw new Error("expected v3 bridge info request");
    }

    const response = createPublicationBridgeSuccessResponseV3(parsed.data, {
      contractVersion: "3.0",
      extensionVersion: "2.0.27",
      platforms: [
        {
          contractVersion: "3.0",
          platform: "zhihu",
          adapterVersion: "2.0.27",
          capabilities: ["publication_inspect"],
        },
      ],
    });

    expect(
      parsePublicationBridgeResponseEventV3(
        { origin: "http://localhost", source: topWindow, data: response },
        topWindow,
      ),
    ).toEqual({ success: true, data: response });
  });

  it("strictly creates and parses the discriminated inspection result", () => {
    const parsed = parsePublicationBridgeRequestEventV3(
      requestEvent({
        data: {
          namespace: BRIDGE_NAMESPACE,
          apiVersion: PUBLICATION_BRIDGE_API_VERSION_V3,
          direction: BRIDGE_DIRECTIONS.request,
          requestId: inspectRequest.requestId,
          method: "inspectPublicationV3",
          payload: inspectRequest,
        },
      }),
      topWindow,
    );
    if (!parsed.success || parsed.data.method !== "inspectPublicationV3") {
      throw new Error("expected v3 inspection request");
    }

    const response = createPublicationBridgeSuccessResponseV3(parsed.data, {
      contractVersion: "3.0",
      requestId: inspectRequest.requestId,
      platform: "zhihu",
      externalAccountId: "zhihu-user-1",
      adapterVersion: "2.0.27",
      ok: false,
      failure: {
        stage: "TIMEOUT",
        code: "PUBLICATION_INSPECTION_TIMEOUT",
        retryable: true,
        message: "The publication inspection timed out.",
        requiredAction: "RETRY",
      },
    });

    expect(
      parsePublicationBridgeResponseEventV3(
        { origin: "http://localhost", source: topWindow, data: response },
        topWindow,
      ),
    ).toEqual({ success: true, data: response });

    expect(
      parsePublicationBridgeResponseEventV3(
        {
          origin: "http://localhost",
          source: topWindow,
          data: {
            ...response,
            result: { ...response.result, requestId: "another-id" },
          },
        },
        topWindow,
      ),
    ).toEqual({ success: false, code: "INVALID_PAYLOAD" });
  });

  it("keeps bounded transport errors separate from inspection failures", () => {
    const parsed = parsePublicationBridgeRequestEventV3(
      requestEvent(),
      topWindow,
    );
    if (
      !parsed.success ||
      parsed.data.method !== "getPublicationBridgeInfoV3"
    ) {
      throw new Error("expected v3 bridge info request");
    }
    const response = createPublicationBridgeErrorResponseV3(parsed.data, {
      code: "BRIDGE_RUNTIME_ERROR",
      message: "Bridge request failed",
    });
    expect(
      parsePublicationBridgeResponseEventV3(
        { origin: "http://localhost", source: topWindow, data: response },
        topWindow,
      ),
    ).toEqual({ success: true, data: response });
  });
});

describe("Bridge v2 and publication Bridge v3 coexistence", () => {
  it("does not let either parser accept the other API version", () => {
    expect(parseBridgeRequestEvent(requestEvent(), topWindow)).toEqual({
      success: false,
      code: "INVALID_ENVELOPE",
    });

    const v2Event = requestEvent({
      data: {
        namespace: BRIDGE_NAMESPACE,
        apiVersion: "2.0",
        direction: BRIDGE_DIRECTIONS.request,
        requestId: "v2-info",
        method: "getBridgeInfo",
        payload: {},
      },
    });
    expect(parsePublicationBridgeRequestEventV3(v2Event, topWindow)).toEqual({
      success: false,
      code: "INVALID_ENVELOPE",
    });
    expect(parseBridgeRequestEvent(v2Event, topWindow)).toMatchObject({
      success: true,
      data: { method: "getBridgeInfo" },
    });
  });
});
