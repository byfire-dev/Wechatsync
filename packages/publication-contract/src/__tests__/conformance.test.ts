import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  OpenPublicationDraftRequestSchema,
  OpenPublicationDraftResultSchema,
  PublicationInspectRequestSchema,
  PublicationObservationSchema,
  SyncerAccountsV2DetailedSchema,
  SyncerBridgeInfoSchema,
} from "../v2";
import {
  PublicationBridgeInfoV3Schema,
  PublicationInspectRequestV3Schema,
  PublicationInspectResultV3Schema,
} from "../v3";

function fixture(relativePath: string): unknown {
  const fixtureUrl = new URL(`../../fixtures/${relativePath}`, import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(fixtureUrl), "utf8"));
}

describe("publication contract conformance fixtures", () => {
  it("keeps the extracted v2 Zhihu observation wire-compatible", () => {
    const value = fixture("v2/zhihu-published.json");
    expect(PublicationObservationSchema.parse(value)).toEqual(value);
  });

  it("keeps the complete extracted v2 command surface wire-compatible", () => {
    const bridgeInfo = fixture("v2/bridge-info.json");
    const accounts = fixture("v2/accounts-detailed.json");
    const inspection = fixture("v2/inspect-request.json");
    const openDraft = fixture("v2/open-weixin-draft.json");
    const openResult = fixture("v2/open-result.json");

    expect(SyncerBridgeInfoSchema.parse(bridgeInfo)).toEqual(bridgeInfo);
    expect(SyncerAccountsV2DetailedSchema.parse(accounts)).toEqual(accounts);
    expect(PublicationInspectRequestSchema.parse(inspection)).toEqual(
      inspection,
    );
    expect(OpenPublicationDraftRequestSchema.parse(openDraft)).toEqual(
      openDraft,
    );
    expect(OpenPublicationDraftResultSchema.parse(openResult)).toEqual(
      openResult,
    );
  });

  it("accepts the v3 platform capability descriptors", () => {
    const value = fixture("v3/bridge-info.json");
    expect(PublicationBridgeInfoV3Schema.parse(value)).toEqual(value);
  });

  it.each(["zhihu", "sohu", "weixin"])(
    "accepts the strict v3 %s published fixture",
    (platform) => {
      const value = fixture(`v3/${platform}-published.json`);
      expect(PublicationInspectResultV3Schema.parse(value)).toEqual(value);
    },
  );

  it("accepts a structured v3 failure envelope", () => {
    const value = fixture("v3/adapter-timeout.json");
    expect(PublicationInspectResultV3Schema.parse(value)).toEqual(value);
  });

  it("keeps account mismatch as persistable evidence", () => {
    const value = fixture("v3/account-mismatch.json");
    expect(PublicationInspectResultV3Schema.parse(value)).toEqual(value);
  });

  it("accepts URL-only inspection and evidence errors without a post ID", () => {
    const request = fixture("v3/inspect-request-url-only.json");
    const result = fixture("v3/draft-url-fetch-error.json");

    expect(PublicationInspectRequestV3Schema.parse(request)).toEqual(request);
    expect(PublicationInspectResultV3Schema.parse(result)).toEqual(result);
  });

  it("rejects unknown fields at every v3 wire boundary", () => {
    const value = fixture("v3/zhihu-published.json") as {
      observations: Array<Record<string, unknown>>;
    };

    expect(
      PublicationInspectResultV3Schema.safeParse({
        ...value,
        unexpectedEnvelopeField: true,
      }).success,
    ).toBe(false);
    expect(
      PublicationInspectResultV3Schema.safeParse({
        ...value,
        observations: [
          {
            ...value.observations[0],
            unexpectedObservationField: true,
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("does not allow failure fields inside successful observations", () => {
    const value = fixture("v3/zhihu-published.json") as {
      observations: Array<Record<string, unknown>>;
    };

    expect(
      PublicationInspectResultV3Schema.safeParse({
        ...value,
        observations: [
          {
            ...value.observations[0],
            failure: {
              stage: "PARSE",
              code: "INVALID_PAYLOAD",
              retryable: false,
              message: "invalid",
            },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("requires safe error details and forbids success fields on evidence errors", () => {
    const value = fixture("v3/account-mismatch.json") as {
      observations: Array<Record<string, unknown>>;
    };
    const { errorMessage: _errorMessage, ...withoutMessage } =
      value.observations[0];

    expect(
      PublicationInspectResultV3Schema.safeParse({
        ...value,
        observations: [withoutMessage],
      }).success,
    ).toBe(false);
    expect(
      PublicationInspectResultV3Schema.safeParse({
        ...value,
        observations: [
          {
            ...value.observations[0],
            canonicalUrl: "https://zhuanlan.zhihu.com/p/123456789",
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("requires complete public facts for PUBLISHED", () => {
    const value = fixture("v3/zhihu-published.json") as {
      observations: Array<Record<string, unknown>>;
    };
    const { canonicalUrl: _canonicalUrl, ...incompleteObservation } =
      value.observations[0];

    expect(
      PublicationInspectResultV3Schema.safeParse({
        ...value,
        observations: [incompleteObservation],
      }).success,
    ).toBe(false);
  });

  it("requires published evidence to include the observed author identity", () => {
    const value = fixture("v3/zhihu-published.json") as {
      observations: Array<Record<string, unknown>>;
    };
    const {
      observedAuthorExternalAccountId: _observedAuthorExternalAccountId,
      ...withoutAuthor
    } = value.observations[0];

    expect(
      PublicationInspectResultV3Schema.safeParse({
        ...value,
        observations: [withoutAuthor],
      }).success,
    ).toBe(false);
    expect(
      PublicationInspectResultV3Schema.safeParse({
        ...value,
        observations: [
          {
            ...value.observations[0],
            observedAuthorExternalAccountId: "another-account",
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("binds publicAccess status to its evidence source", () => {
    const value = fixture("v3/zhihu-published.json") as {
      observations: Array<Record<string, unknown>>;
    };
    const observation = value.observations[0];

    expect(
      PublicationInspectResultV3Schema.safeParse({
        ...value,
        observations: [
          {
            ...observation,
            publicAccess: {
              status: "BLOCKED_BY_PLATFORM",
              reasonCode: "ZHIHU_ANONYMOUS_HTTP_403",
            },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      PublicationInspectResultV3Schema.safeParse({
        ...value,
        observations: [
          {
            ...observation,
            source: "AUTHENTICATED_PUBLIC_PAGE",
            publicAccess: { status: "CONFIRMED" },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      PublicationInspectResultV3Schema.safeParse({
        ...value,
        observations: [
          {
            ...observation,
            source: "AUTHENTICATED_PUBLIC_PAGE",
            publicAccess: {
              status: "BLOCKED_BY_PLATFORM",
              reasonCode: "ZHIHU_ANONYMOUS_HTTP_403",
            },
          },
        ],
      }).success,
    ).toBe(true);
  });

  it("binds observations to the response platform and account", () => {
    const value = fixture("v3/zhihu-published.json") as {
      observations: Array<Record<string, unknown>>;
    };

    expect(
      PublicationInspectResultV3Schema.safeParse({
        ...value,
        observations: [
          {
            ...value.observations[0],
            platform: "sohu",
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      PublicationInspectResultV3Schema.safeParse({
        ...value,
        observations: [
          {
            ...value.observations[0],
            externalAccountId: "another-account",
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects duplicate observation keys within one response", () => {
    const value = fixture("v3/zhihu-published.json") as {
      observations: Array<Record<string, unknown>>;
    };

    expect(
      PublicationInspectResultV3Schema.safeParse({
        ...value,
        observations: [value.observations[0], value.observations[0]],
      }).success,
    ).toBe(false);
  });

  it("rejects duplicate platform and capability descriptors", () => {
    const value = fixture("v3/bridge-info.json") as {
      platforms: Array<Record<string, unknown>>;
    };

    expect(
      PublicationBridgeInfoV3Schema.safeParse({
        ...value,
        platforms: [...value.platforms, value.platforms[0]],
      }).success,
    ).toBe(false);
    expect(
      PublicationBridgeInfoV3Schema.safeParse({
        ...value,
        platforms: [
          {
            ...value.platforms[0],
            capabilities: ["publication_inspect", "publication_inspect"],
          },
        ],
      }).success,
    ).toBe(false);
  });
});
