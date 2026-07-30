import { describe, expect, it, vi } from "vitest";
import { SohuAdapter } from "../../core/src/adapters/platforms/sohu";
import { WeixinAdapter } from "../../core/src/adapters/platforms/weixin";
import { ZhihuAdapter } from "../../core/src/adapters/platforms/zhihu";

import manifest from "../manifest.json";
import extensionPackage from "../package.json";
import {
  buildPublicationBridgeInfoV3,
  runPublicationInspectionV3,
  validatePublicationBridgeInfoPayloadV3,
  validatePublicationInspectPayloadV3,
} from "../src/background/bridge-v3";
import { deriveRegisteredPublicationInspectorPlatforms } from "../src/bridge/publication-capabilities-v3";

const extensionVersionFromManifest = manifest.version;
const draftedAt = "2026-07-29T08:00:00.000Z";
const observedAt = "2026-07-29T08:05:00.000Z";
const publishedAt = "2026-07-29T08:04:00.000Z";

const requests = {
  zhihu: {
    contractVersion: "3.0" as const,
    requestId: "inspect-v3-zhihu",
    platform: "zhihu" as const,
    externalAccountId: "zhihu-user-1",
    draft: { platformPostId: "123456789", draftedAt },
    articleHint: { title: "Zhihu article" },
    limit: 20,
  },
  sohu: {
    contractVersion: "3.0" as const,
    requestId: "inspect-v3-sohu",
    platform: "sohu" as const,
    externalAccountId: "120000001",
    draft: { platformPostId: "1000000001", draftedAt },
    articleHint: { title: "Sohu article" },
    limit: 20,
  },
  weixin: {
    contractVersion: "3.0" as const,
    requestId: "inspect-v3-weixin",
    platform: "weixin" as const,
    externalAccountId: "gh_account",
    draft: { platformPostId: "9001", draftedAt },
    articleHint: { title: "WeChat article" },
    limit: 20,
  },
};

const publishedObservations = {
  zhihu: {
    observationKey: "zhihu:123456789:published",
    platform: "zhihu" as const,
    externalAccountId: "zhihu-user-1",
    outcome: "PUBLISHED" as const,
    source: "PUBLIC_PAGE" as const,
    platformPostId: "123456789",
    canonicalUrl: "https://zhuanlan.zhihu.com/p/123456789",
    title: "Zhihu article",
    publishedAt,
    bodyText: "Zhihu public body",
    bodyTruncated: false,
    publicAccess: { status: "CONFIRMED" as const },
    observedAt,
  },
  sohu: {
    observationKey: "sohu:1000000001:published",
    platform: "sohu" as const,
    externalAccountId: "120000001",
    outcome: "PUBLISHED" as const,
    source: "PUBLIC_PAGE" as const,
    platformPostId: "1000000001",
    canonicalUrl: "https://www.sohu.com/a/1000000001_120000001",
    title: "Sohu article",
    publishedAt,
    bodyText: "Sohu public body",
    bodyTruncated: false,
    observedAt,
  },
  weixin: {
    observationKey: "weixin:9001:published",
    platform: "weixin" as const,
    externalAccountId: "gh_account",
    outcome: "PUBLISHED" as const,
    source: "PUBLIC_PAGE" as const,
    platformPostId: "9001",
    canonicalUrl:
      "https://mp.weixin.qq.com/s?__biz=MzA0000000000%3D%3D&mid=1&idx=1",
    title: "WeChat article",
    publishedAt,
    bodyText: "WeChat public body",
    bodyTruncated: false,
    observedAt,
  },
};

const publishedProofAdapters = {
  zhihu: new ZhihuAdapter(),
  sohu: new SohuAdapter(),
  weixin: new WeixinAdapter(),
};

describe("publication Bridge v3 capability descriptors", () => {
  it("keeps the extension package and manifest on the v3 release version", () => {
    expect(extensionPackage.version).toBe("2.0.27");
    expect(manifest.version).toBe(extensionPackage.version);
  });

  it("derives only registered inspectors and never advertises Toutiao", async () => {
    const inspector = vi.fn();
    const publishedProof = vi.fn();
    const registered = deriveRegisteredPublicationInspectorPlatforms([
      {
        platformId: "zhihu",
        inspectPublication: inspector,
        provePublishedObservation: publishedProof,
      },
      { platformId: "toutiao" },
      { platformId: "sohu", inspectPublication: inspector },
      {
        platformId: "sohu",
        inspectPublication: inspector,
        provePublishedObservation: publishedProof,
      },
      {
        platformId: "weixin",
        inspectPublication: inspector,
        provePublishedObservation: publishedProof,
      },
      {
        platformId: "unknown",
        inspectPublication: inspector,
        provePublishedObservation: publishedProof,
      },
    ]);
    expect(registered).toEqual(["zhihu", "sohu", "weixin"]);

    const info = buildPublicationBridgeInfoV3(
      registered,
      extensionVersionFromManifest,
    );
    expect(info).toEqual({
      contractVersion: "3.0",
      extensionVersion: extensionVersionFromManifest,
      platforms: ["zhihu", "sohu", "weixin"].map((platform) => ({
        contractVersion: "3.0",
        platform,
        adapterVersion: extensionVersionFromManifest,
        capabilities: ["publication_inspect"],
      })),
    });
    expect(JSON.stringify(info)).not.toContain("toutiao");
  });

  it("strictly validates the background info payload", () => {
    expect(validatePublicationBridgeInfoPayloadV3({}, "info-v3-001")).toBe(
      true,
    );
    expect(
      validatePublicationBridgeInfoPayloadV3(undefined, "info-v3-001"),
    ).toBe(false);
    expect(
      validatePublicationBridgeInfoPayloadV3(
        { unexpected: true },
        "info-v3-001",
      ),
    ).toBe(false);
    expect(validatePublicationBridgeInfoPayloadV3({}, " padded-id ")).toBe(
      false,
    );
  });
});

describe("publication Bridge v3 background request boundary", () => {
  it("revalidates the contract and binds the runtime request ID", () => {
    expect(
      validatePublicationInspectPayloadV3(
        requests.zhihu,
        requests.zhihu.requestId,
      ),
    ).toEqual({ success: true, data: requests.zhihu });

    expect(
      validatePublicationInspectPayloadV3(requests.zhihu, "another-id"),
    ).toEqual({ success: false, code: "INVALID_PAYLOAD" });
    expect(validatePublicationInspectPayloadV3(requests.zhihu, 123)).toEqual({
      success: false,
      code: "INVALID_PAYLOAD",
    });
    expect(
      validatePublicationInspectPayloadV3(
        { ...requests.zhihu, unexpected: true },
        requests.zhihu.requestId,
      ),
    ).toEqual({ success: false, code: "INVALID_PAYLOAD" });
  });
});

describe("publication Bridge v3 observation projection", () => {
  it.each(["zhihu", "sohu", "weixin"] as const)(
    "maps the strictly revalidated %s PUBLISHED proof",
    async (platform) => {
      const result = await runPublicationInspectionV3(
        requests[platform],
        {
          inspectPublication: async () => [publishedObservations[platform]],
          provePublishedObservation:
            publishedProofAdapters[platform].provePublishedObservation,
        },
        extensionVersionFromManifest,
      );

      expect(result).toMatchObject({
        contractVersion: "3.0",
        requestId: requests[platform].requestId,
        platform,
        externalAccountId: requests[platform].externalAccountId,
        adapterVersion: extensionVersionFromManifest,
        ok: true,
        observations: [
          {
            outcome: "PUBLISHED",
            platform,
            externalAccountId: requests[platform].externalAccountId,
            observedAuthorExternalAccountId:
              requests[platform].externalAccountId,
            publicAccess: { status: "CONFIRMED" },
            title: publishedObservations[platform].title,
            bodyText: publishedObservations[platform].bodyText,
            bodyTruncated: false,
          },
        ],
      });
    },
  );

  it("keeps evidence errors in an ok:true result for persistence", async () => {
    const result = await runPublicationInspectionV3(
      requests.zhihu,
      {
        inspectPublication: async () => [
          {
            observationKey: "zhihu:123456789:account-mismatch",
            platform: "zhihu",
            externalAccountId: "zhihu-user-1",
            platformPostId: "123456789",
            outcome: "ACCOUNT_MISMATCH",
            source: "PLATFORM_DETAIL",
            observedAt,
            errorCode: "ACCOUNT_MISMATCH",
            errorMessage:
              "The active account does not match the bound account.",
          },
        ],
        provePublishedObservation: () => null,
      },
      extensionVersionFromManifest,
    );

    expect(result).toMatchObject({
      ok: true,
      observations: [
        {
          outcome: "ACCOUNT_MISMATCH",
          errorCode: "ACCOUNT_MISMATCH",
        },
      ],
    });

    const fetchError = await runPublicationInspectionV3(
      requests.zhihu,
      {
        inspectPublication: async () => [
          {
            observationKey: "zhihu:123456789:public-fetch-error",
            platform: "zhihu",
            externalAccountId: "zhihu-user-1",
            platformPostId: "123456789",
            outcome: "FETCH_ERROR",
            source: "PUBLIC_PAGE",
            observedAt,
            errorCode: "ZHIHU_PUBLIC_FETCH_ERROR",
            errorMessage: "The public Zhihu page could not be fetched.",
          },
        ],
        provePublishedObservation: () => null,
      },
      extensionVersionFromManifest,
    );
    expect(fetchError).toMatchObject({
      ok: true,
      observations: [
        {
          outcome: "FETCH_ERROR",
          errorCode: "ZHIHU_PUBLIC_FETCH_ERROR",
        },
      ],
    });
  });

  it("fails closed when PUBLISHED lacks complete v3 evidence", async () => {
    const {
      title: _title,
      bodyText: _bodyText,
      ...incomplete
    } = publishedObservations.sohu;
    const result = await runPublicationInspectionV3(
      requests.sohu,
      {
        inspectPublication: async () => [incomplete],
        provePublishedObservation:
          publishedProofAdapters.sohu.provePublishedObservation,
      },
      extensionVersionFromManifest,
    );

    expect(result).toMatchObject({
      ok: false,
      failure: {
        stage: "PROTOCOL",
        code: "INVALID_INSPECTION_RESULT",
      },
    });
    expect(JSON.stringify(result)).not.toContain(
      "observedAuthorExternalAccountId",
    );
  });

  it.each([
    ["an empty response", []],
    [
      "duplicate observation keys",
      [publishedObservations.zhihu, publishedObservations.zhihu],
    ],
  ])("turns %s into a protocol failure", async (_label, observations) => {
    const result = await runPublicationInspectionV3(
      requests.zhihu,
      {
        inspectPublication: async () => observations as never,
        provePublishedObservation:
          publishedProofAdapters.zhihu.provePublishedObservation,
      },
      extensionVersionFromManifest,
    );
    expect(result).toMatchObject({
      ok: false,
      failure: {
        stage: "PROTOCOL",
        code: "INVALID_INSPECTION_RESULT",
      },
    });
  });

  it("rejects PUBLISHED observations that carry top-level error fields", async () => {
    const provePublishedObservation = vi.fn(() => ({
      observedAuthorExternalAccountId: requests.sohu.externalAccountId,
      publicAccess: { status: "CONFIRMED" as const },
      bodyTruncated: false,
    }));
    const result = await runPublicationInspectionV3(
      requests.sohu,
      {
        inspectPublication: async () => [
          {
            ...publishedObservations.sohu,
            errorCode: "UNTRUSTED_ERROR",
            errorMessage: "must not cross v3",
          },
        ],
        provePublishedObservation,
      },
      extensionVersionFromManifest,
    );

    expect(result).toMatchObject({
      ok: false,
      failure: {
        stage: "PROTOCOL",
        code: "INVALID_INSPECTION_RESULT",
      },
    });
    expect(provePublishedObservation).not.toHaveBeenCalled();
  });

  it("rejects PUBLISHED when the adapter proof omits the observed author", async () => {
    const result = await runPublicationInspectionV3(
      requests.sohu,
      {
        inspectPublication: async () => [publishedObservations.sohu],
        provePublishedObservation: () =>
          ({
            publicAccess: { status: "CONFIRMED" },
            bodyTruncated: false,
          }) as never,
      },
      extensionVersionFromManifest,
    );

    expect(result).toMatchObject({
      ok: false,
      failure: {
        stage: "PROTOCOL",
        code: "INVALID_INSPECTION_RESULT",
      },
    });
  });

  it("rejects PUBLISHED when bodyTruncated is not explicit", async () => {
    const {
      bodyTruncated: _bodyTruncated,
      ...missingBodyTruncated
    } = publishedObservations.sohu;
    const result = await runPublicationInspectionV3(
      requests.sohu,
      {
        inspectPublication: async () => [missingBodyTruncated],
        provePublishedObservation: () => ({
          observedAuthorExternalAccountId: requests.sohu.externalAccountId,
          publicAccess: { status: "CONFIRMED" },
          bodyTruncated: false,
        }),
      },
      extensionVersionFromManifest,
    );

    expect(result).toMatchObject({
      ok: false,
      failure: {
        stage: "PROTOCOL",
        code: "INVALID_INSPECTION_RESULT",
      },
    });
  });
});

describe("publication Bridge v3 command failure boundary", () => {
  it("returns command exceptions as ok:false without leaking details", async () => {
    const result = await runPublicationInspectionV3(
      requests.zhihu,
      {
        inspectPublication: async () => {
          throw new Error("cookie=secret");
        },
        provePublishedObservation: () => null,
      },
      extensionVersionFromManifest,
    );
    expect(result).toMatchObject({
      ok: false,
      failure: {
        stage: "ADAPTER",
        code: "PUBLICATION_INSPECTION_FAILED",
        retryable: true,
      },
    });
    expect(JSON.stringify(result)).not.toContain("cookie=secret");
  });

  it("aborts and returns timeout as ok:false", async () => {
    let signal: AbortSignal | undefined;
    const result = await runPublicationInspectionV3(
      requests.zhihu,
      {
        inspectPublication: (_request, context) => {
          signal = context?.signal;
          return new Promise((_resolve, reject) => {
            context?.signal?.addEventListener(
              "abort",
              () => reject(context.signal?.reason),
              { once: true },
            );
          });
        },
        provePublishedObservation: () => null,
      },
      extensionVersionFromManifest,
      1,
    );
    expect(result).toMatchObject({
      ok: false,
      failure: {
        stage: "TIMEOUT",
        code: "PUBLICATION_INSPECTION_TIMEOUT",
        retryable: true,
      },
    });
    expect(signal?.aborted).toBe(true);
  });

  it("does not run or advertise a Toutiao inspector", async () => {
    const inspectPublication = vi.fn();
    const result = await runPublicationInspectionV3(
      {
        ...requests.zhihu,
        requestId: "inspect-v3-toutiao",
        platform: "toutiao",
      },
      { inspectPublication },
      extensionVersionFromManifest,
    );

    expect(inspectPublication).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      platform: "toutiao",
      ok: false,
      failure: {
        stage: "CAPABILITY",
        code: "PUBLICATION_INSPECTION_NOT_IMPLEMENTED",
      },
    });
  });
});
