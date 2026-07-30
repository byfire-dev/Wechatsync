import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import type { RuntimeInterface } from "../../../runtime/interface";
import type { PublicationInspectionRequest } from "../../../publication-inspection/domain";
import {
  TOUTIAO_ANONYMOUS_HTTP_404_REASON,
  TOUTIAO_ANONYMOUS_SOFT_404_REASON,
  TOUTIAO_PUBLISHED_LIST_URL,
  scanToutiaoPublishedListInPage,
  type ToutiaoPublishedListScanResult,
} from "../../../publication-inspection/toutiao";
import { ToutiaoAdapter } from "../toutiao";
import { TOUTIAO_ENDPOINTS } from "../toutiao-protocol";

const authenticatedArticleHtml = readFileSync(
  new URL(
    "../../../publication-inspection/__fixtures__/toutiao-authenticated-article.html",
    import.meta.url,
  ),
  "utf8",
);
const anonymousSoft404Html = readFileSync(
  new URL(
    "../../../publication-inspection/__fixtures__/toutiao-anonymous-soft-404.html",
    import.meta.url,
  ),
  "utf8",
);

const ACCOUNT_ID = "7390000000000000001";
const ACCOUNT_NAME = "脱敏头条账号";
const PGC_ID = "7444000000000000001";
const ITEM_ID = "7667071065847677450";
const TITLE = "统一发布核验协议的设计与实践";
const PUBLIC_URL = `https://www.toutiao.com/article/${ITEM_ID}/`;

const request: PublicationInspectionRequest = {
  requestId: "toutiao-inspection-1",
  platform: "toutiao",
  externalAccountId: ACCOUNT_ID,
  draft: {
    platformPostId: PGC_ID,
    draftUrl: `https://mp.toutiao.com/profile_v4/graphic/publish?pgc_id=${PGC_ID}`,
    draftedAt: "2026-07-30T00:00:00.000Z",
  },
  articleHint: {
    title: TITLE,
    publishedAfter: "2026-07-30T00:00:00.000Z",
    publishedBefore: "2026-07-30T02:00:00.000Z",
  },
  limit: 20,
};

const publishedScan: ToutiaoPublishedListScanResult = {
  success: true,
  match: "PUBLISHED",
  requestedPgcId: PGC_ID,
  publicItemId: ITEM_ID,
  itemUrl: `https://www.toutiao.com/item/${ITEM_ID}/`,
  publicArticleUrl: PUBLIC_URL,
  title: TITLE,
  publishedLabel: "已发布",
  scanComplete: true,
};

function accountResponse(
  accountId = ACCOUNT_ID,
  displayName = ACCOUNT_NAME,
): Response {
  return responseAt(
    TOUTIAO_ENDPOINTS.account,
    JSON.stringify({
      data: {
        user: {
          id: accountId,
          screen_name: displayName,
          https_avatar_url: "https://example.com/avatar.png",
        },
      },
    }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  );
}

function responseAt(
  url: string,
  body: BodyInit | null,
  init?: ResponseInit,
): Response {
  const response = new Response(body, init);
  Object.defineProperty(response, "url", { value: url });
  return response;
}

function createRuntime(options?: {
  fetch?: RuntimeInterface["fetch"];
  scan?: unknown;
  waitForLoad?: (tabId: number, timeout?: number) => Promise<void>;
}) {
  const fetch =
    options?.fetch ??
    vi.fn(async (url: string) => {
      if (url === TOUTIAO_ENDPOINTS.account) return accountResponse();
      if (url === PUBLIC_URL) {
        return responseAt(url, authenticatedArticleHtml, {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      throw new Error("unexpected URL");
    });
  const create = vi.fn().mockResolvedValue({ id: 91 });
  const remove = vi.fn().mockResolvedValue(undefined);
  const waitForLoad =
    options?.waitForLoad ?? vi.fn().mockResolvedValue(undefined);
  const executeScript = vi
    .fn()
    .mockResolvedValue(options?.scan ?? publishedScan);

  const runtime = {
    type: "extension",
    fetch,
    cookies: {
      get: vi.fn(),
      set: vi.fn(),
      remove: vi.fn(),
    },
    storage: {
      get: vi.fn(),
      set: vi.fn(),
      remove: vi.fn(),
    },
    session: {
      get: vi.fn(),
      set: vi.fn(),
    },
    tabs: {
      query: vi.fn().mockResolvedValue([]),
      create,
      remove,
      waitForLoad,
      executeScript,
    },
    dom: {
      parseHTML: vi.fn(),
      querySelector: vi.fn(),
      querySelectorAll: vi.fn(),
      getTextContent: vi.fn(),
      getInnerHTML: vi.fn(),
    },
  } as unknown as RuntimeInterface;

  return { runtime, fetch, create, remove, waitForLoad, executeScript };
}

async function createAdapter(runtime: RuntimeInterface) {
  const adapter = new ToutiaoAdapter();
  await adapter.init(runtime);
  return adapter;
}

describe("ToutiaoAdapter publication inspection", () => {
  it("returns an anonymous confirmed publication while keeping pgcId and itemId distinct", async () => {
    const mocks = createRuntime();
    const adapter = await createAdapter(mocks.runtime);

    const observations = await adapter.inspectPublication(request);

    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      platform: "toutiao",
      externalAccountId: ACCOUNT_ID,
      outcome: "PUBLISHED",
      source: "PUBLIC_PAGE",
      platformPostId: PGC_ID,
      canonicalUrl: PUBLIC_URL,
      title: TITLE,
      publicAccess: { status: "CONFIRMED" },
      internalEvidence: {
        publicItemId: ITEM_ID,
        scanComplete: true,
      },
    });
    expect(observations[0].platformPostId).not.toBe(
      observations[0].internalEvidence?.publicItemId,
    );
    expect(adapter.provePublishedObservation(request, observations[0])).toEqual(
      {
        observedAuthorExternalAccountId: ACCOUNT_ID,
        publicAccess: { status: "CONFIRMED" },
        bodyTruncated: false,
      },
    );
    expect(mocks.create).toHaveBeenCalledWith(
      TOUTIAO_PUBLISHED_LIST_URL,
      false,
    );
    expect(mocks.executeScript).toHaveBeenCalledWith(
      91,
      scanToutiaoPublishedListInPage,
      [PGC_ID, TITLE, 20, 10_000],
      { world: "ISOLATED" },
    );
    expect(mocks.remove).toHaveBeenCalledWith(91);
    expect(mocks.fetch).toHaveBeenCalledWith(
      PUBLIC_URL,
      expect.objectContaining({
        credentials: "omit",
        redirect: "error",
      }),
    );
  });

  it.each([
    {
      name: "hard HTTP 404",
      anonymous: () =>
        responseAt(PUBLIC_URL, "not found", {
          status: 404,
          headers: { "content-type": "text/html" },
        }),
      reasonCode: TOUTIAO_ANONYMOUS_HTTP_404_REASON,
    },
    {
      name: "soft HTTP 404",
      anonymous: () =>
        responseAt(PUBLIC_URL, anonymousSoft404Html, {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
      reasonCode: TOUTIAO_ANONYMOUS_SOFT_404_REASON,
    },
  ])(
    "falls back only after an anonymous $name and preserves its exact blocked reason",
    async ({ anonymous, reasonCode }) => {
      const fetch = vi.fn(
        async (url: string, options?: RequestInit): Promise<Response> => {
          if (url === TOUTIAO_ENDPOINTS.account) return accountResponse();
          if (url !== PUBLIC_URL) throw new Error("unexpected URL");
          if (options?.credentials === "omit") return anonymous();
          if (options?.credentials === "include") {
            return responseAt(PUBLIC_URL, authenticatedArticleHtml, {
              status: 200,
              headers: { "content-type": "text/html; charset=utf-8" },
            });
          }
          throw new Error("unexpected credentials");
        },
      );
      const mocks = createRuntime({ fetch });
      const adapter = await createAdapter(mocks.runtime);

      const [observation] = await adapter.inspectPublication(request);

      expect(observation).toMatchObject({
        outcome: "PUBLISHED",
        source: "AUTHENTICATED_PUBLIC_PAGE",
        platformPostId: PGC_ID,
        canonicalUrl: PUBLIC_URL,
        publicAccess: {
          status: "BLOCKED_BY_PLATFORM",
          reasonCode,
        },
        internalEvidence: { publicItemId: ITEM_ID },
      });
      expect(adapter.provePublishedObservation(request, observation)).toEqual({
        observedAuthorExternalAccountId: ACCOUNT_ID,
        publicAccess: {
          status: "BLOCKED_BY_PLATFORM",
          reasonCode,
        },
        bodyTruncated: false,
      });
      expect(fetch).toHaveBeenCalledTimes(3);
    },
  );

  it("does not create or scan a page when the bound account mismatches", async () => {
    const mocks = createRuntime({
      fetch: vi.fn().mockResolvedValue(accountResponse("7390000000000000099")),
    });
    const adapter = await createAdapter(mocks.runtime);

    await expect(adapter.inspectPublication(request)).resolves.toEqual([
      expect.objectContaining({
        outcome: "ACCOUNT_MISMATCH",
        errorCode: "TOUTIAO_ACCOUNT_MISMATCH",
        platformPostId: PGC_ID,
      }),
    ]);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.executeScript).not.toHaveBeenCalled();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it("returns REVIEW_REQUIRED rather than NOT_FOUND for an incomplete scan", async () => {
    const mocks = createRuntime({
      scan: {
        success: true,
        match: "REVIEW_REQUIRED",
        requestedPgcId: PGC_ID,
        scanComplete: false,
        errorCode: "TOUTIAO_PUBLISHED_SCAN_INCOMPLETE",
      },
    });
    const adapter = await createAdapter(mocks.runtime);

    await expect(adapter.inspectPublication(request)).resolves.toEqual([
      expect.objectContaining({
        outcome: "REVIEW_REQUIRED",
        errorCode: "TOUTIAO_PUBLISHED_SCAN_INCOMPLETE",
      }),
    ]);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.remove).toHaveBeenCalledWith(91);
  });

  it("emits NOT_FOUND only with explicit complete-scan evidence", async () => {
    const mocks = createRuntime({
      scan: {
        success: true,
        match: "NOT_FOUND",
        requestedPgcId: PGC_ID,
        scanComplete: true,
      },
    });
    const adapter = await createAdapter(mocks.runtime);

    await expect(adapter.inspectPublication(request)).resolves.toEqual([
      expect.objectContaining({
        outcome: "NOT_FOUND",
        source: "PUBLISHED_LIST",
        platformPostId: PGC_ID,
        internalEvidence: { scanComplete: true },
      }),
    ]);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it("fails closed when executeScript returns a mismatched or malformed shape", async () => {
    const mocks = createRuntime({
      scan: {
        ...publishedScan,
        requestedPgcId: "7444000000000000099",
      },
    });
    const adapter = await createAdapter(mocks.runtime);

    await expect(adapter.inspectPublication(request)).resolves.toEqual([
      expect.objectContaining({
        outcome: "REVIEW_REQUIRED",
        errorCode: "TOUTIAO_PUBLISHED_SCAN_INVALID",
      }),
    ]);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.remove).toHaveBeenCalledWith(91);
  });

  it("aborts waitForLoad immediately and removes the created background tab", async () => {
    const waitForLoad = vi.fn(
      () =>
        new Promise<void>(() => {
          // Deliberately unresolved: cancellation must not wait for 30 seconds.
        }),
    );
    const mocks = createRuntime({ waitForLoad });
    const adapter = await createAdapter(mocks.runtime);
    const controller = new AbortController();

    const inspection = adapter.inspectPublication(request, {
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(waitForLoad).toHaveBeenCalled());
    controller.abort();

    await expect(inspection).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.remove).toHaveBeenCalledWith(91);
    expect(mocks.executeScript).not.toHaveBeenCalled();
  });

  it("bounds the decoded public HTML stream and cancels it on overflow", async () => {
    const cancel = vi.fn();
    const oversizedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(2 * 1024 * 1024));
        controller.enqueue(new Uint8Array([1]));
      },
      cancel,
    });
    const fetch = vi.fn(async (url: string): Promise<Response> => {
      if (url === TOUTIAO_ENDPOINTS.account) return accountResponse();
      if (url !== PUBLIC_URL) throw new Error("unexpected URL");
      const response = new Response(oversizedBody, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
      Object.defineProperty(response, "url", { value: PUBLIC_URL });
      return response;
    });
    const mocks = createRuntime({ fetch });
    const adapter = await createAdapter(mocks.runtime);

    await expect(adapter.inspectPublication(request)).resolves.toEqual([
      expect.objectContaining({
        outcome: "REVIEW_REQUIRED",
        errorCode: "TOUTIAO_PUBLIC_BODY_TOO_LARGE",
        source: "PUBLIC_PAGE",
      }),
    ]);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("rejects forged canonical identity and unknown blocked reasons in proof", async () => {
    const mocks = createRuntime();
    const adapter = await createAdapter(mocks.runtime);
    const [observation] = await adapter.inspectPublication(request);

    expect(
      adapter.provePublishedObservation(request, {
        ...observation,
        canonicalUrl: `https://www.toutiao.com/article/${PGC_ID}/`,
      }),
    ).toBeNull();
    expect(
      adapter.provePublishedObservation(request, {
        ...observation,
        source: "AUTHENTICATED_PUBLIC_PAGE",
        publicAccess: {
          status: "BLOCKED_BY_PLATFORM",
          reasonCode: "TOUTIAO_UNKNOWN_BLOCK",
        },
      }),
    ).toBeNull();
  });
});

describe("ToutiaoAdapter account binding", () => {
  it("probes one stable account and returns it on a bound draft save", async () => {
    const mocks = createRuntime({
      scan: {
        ok: true,
        pgcId: "7520000000000000001",
      },
    });
    mocks.runtime.tabs!.query = vi.fn().mockResolvedValue([
      {
        id: 42,
        url: "https://mp.toutiao.com/profile_v4/graphic/publish",
      },
    ]);
    const adapter = await createAdapter(mocks.runtime);

    await expect(adapter.probeAccounts()).resolves.toEqual({
      status: "AUTHENTICATED",
      accounts: [
        {
          externalAccountId: ACCOUNT_ID,
          displayName: ACCOUNT_NAME,
          avatarUrl: "https://example.com/avatar.png",
        },
      ],
    });

    const result = await adapter.publish(
      {
        title: "精确账号草稿",
        markdown: "正文",
        html: "<p>正文</p>",
      },
      {
        draftOnly: true,
        accountBinding: { externalAccountId: ACCOUNT_ID },
      },
    );
    expect(result).toMatchObject({
      success: true,
      postId: "7520000000000000001",
      externalAccountId: ACCOUNT_ID,
      draftOnly: true,
    });
  });

  it("stops before every write when the requested account is unavailable", async () => {
    const mocks = createRuntime();
    const adapter = await createAdapter(mocks.runtime);

    const result = await adapter.publish(
      {
        title: "错误账号",
        markdown: "正文",
        html: "<p>正文</p>",
      },
      {
        accountBinding: {
          externalAccountId: "7390000000000000099",
        },
      },
    );

    expect(result).toMatchObject({
      success: false,
      externalAccountId: "7390000000000000099",
      errorCode: "ACCOUNT_BINDING_NOT_FOUND",
    });
    expect(mocks.executeScript).not.toHaveBeenCalled();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
});
