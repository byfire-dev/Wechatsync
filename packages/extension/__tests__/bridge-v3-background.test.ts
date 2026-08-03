import type { AdapterAccountProbe, PlatformAdapter } from "@wechatsync/core";
import {
  PUBLICATION_BRIDGE_CONTRACT_VERSION,
  PUBLICATION_BRIDGE_NAMESPACE,
  PUBLICATION_BRIDGE_PROTOCOL_MAJOR,
  PublicationBridgeV3CommandExchangeSchema,
  PublicationBridgeV3NegotiationExchangeSchema,
  PublicationBridgeV3PublishOperationSnapshotSchema,
  PublicationBridgeV3RequestSchema,
  type PublicationBridgeV3PublishOperationSnapshot,
  type PublicationBridgeV3Request,
  type PublicationBridgeV3Response,
} from "@byfire-dev/publication-bridge-contract/v3";
import { describe, expect, it, vi } from "vitest";

import {
  PublicationBridgeV3Coordinator,
  type PublicationBridgeV3CoordinatorDependencies,
  type PublicationBridgeV3StateStore,
} from "../src/background/bridge-v3";

const NOW = "2026-08-02T08:00:00.000Z";
const OBSERVED_AT = "2026-08-02T07:59:30.000Z";
const PUBLISHED_AT = "2026-08-02T07:58:00.000Z";
const VALID_DIGEST = `sha256:${"1".repeat(64)}`;
const OTHER_DIGEST = `sha256:${"2".repeat(64)}`;

function clone<T>(value: T): T {
  return value === undefined ? value : structuredClone(value);
}

class MemoryStateStore implements PublicationBridgeV3StateStore {
  private value: unknown;
  readonly saves: unknown[] = [];

  constructor(seed?: unknown) {
    this.value = clone(seed);
  }

  async load(): Promise<unknown> {
    return clone(this.value);
  }

  async save(value: unknown): Promise<void> {
    this.value = clone(value);
    this.saves.push(clone(value));
  }

  snapshot<T>(): T {
    return clone(this.value) as T;
  }
}

type PlatformId = "zhihu" | "sohu" | "weixin" | "toutiao";

function authenticatedAccount(
  platform: PlatformId,
  externalAccountId = `${platform}-account`,
): AdapterAccountProbe {
  return {
    status: "AUTHENTICATED",
    accounts: [
      {
        externalAccountId,
        displayName: `${platform} display name`,
      },
    ],
  };
}

function createAdapter(platform: PlatformId): PlatformAdapter {
  const externalAccountId = `${platform}-account`;
  const canonicalUrl = "https://zhuanlan.zhihu.com/p/123456";
  const publicAccess = {
    status: "CONFIRMED" as const,
    checkedUrl: canonicalUrl,
    checkedPublicIdentityKey: "zhihu:post:v1:123456",
    checkedAt: OBSERVED_AT,
    httpStatus: 200,
  };

  return {
    meta: {
      id: platform,
      name: platform,
      icon: `${platform}.svg`,
      homepage: `https://${platform}.example.com`,
      capabilities: ["article", "draft", "account_binding"],
    },
    init: vi.fn().mockResolvedValue(undefined),
    checkAuth: vi.fn().mockResolvedValue({
      isAuthenticated: true,
      userId: externalAccountId,
    }),
    probeAccounts: vi.fn().mockResolvedValue(authenticatedAccount(platform)),
    publish: vi.fn().mockResolvedValue({
      platform,
      success: true,
      outcome: "SUCCEEDED",
      postId: `${platform}-post-1`,
      externalAccountId,
      timestamp: Date.parse(NOW),
    }),
    // Toutiao deliberately has both callables too. Its descriptor, rather
    // than accidental method presence, must keep locator-only inspection off.
    inspectPublication: vi.fn().mockResolvedValue([
      {
        observationKey: "published:123456",
        platform: "zhihu",
        externalAccountId: "zhihu-account",
        outcome: "PUBLISHED",
        source: "PUBLIC_PAGE",
        platformPostId: "123456",
        canonicalUrl,
        title: "Verified Zhihu article",
        publishedAt: PUBLISHED_AT,
        bodyText: "Verified public article body.",
        bodyTruncated: false,
        publicAccess,
        observedAt: OBSERVED_AT,
      },
    ]),
    provePublishedObservation: vi.fn().mockReturnValue({
      observedAuthorExternalAccountId: "zhihu-account",
      publicAccess,
      bodyTruncated: false,
    }),
    ...(platform === "weixin"
      ? {
          openPublicationDraft: vi.fn().mockResolvedValue({ opened: true }),
        }
      : {}),
  };
}

function createAdapters(): Record<PlatformId, PlatformAdapter> {
  return {
    zhihu: createAdapter("zhihu"),
    sohu: createAdapter("sohu"),
    weixin: createAdapter("weixin"),
    toutiao: createAdapter("toutiao"),
  };
}

interface HarnessOptions {
  adapters?: Record<PlatformId, PlatformAdapter>;
  store?: MemoryStateStore;
  syncToPlatform?: PublicationBridgeV3CoordinatorDependencies["syncToPlatform"];
  sha256?: PublicationBridgeV3CoordinatorDependencies["sha256"];
  extensionVersion?: string;
}

function createHarness(options: HarnessOptions = {}) {
  const adapters = options.adapters ?? createAdapters();
  const store = options.store ?? new MemoryStateStore();
  const syncToPlatform =
    options.syncToPlatform ??
    vi.fn<PublicationBridgeV3CoordinatorDependencies["syncToPlatform"]>(
      async (platform, _article, publishOptions) => {
        await publishOptions.beforeDispatch();
        return {
          platform,
          success: true,
          outcome: "SUCCEEDED",
          postId: `${platform}-post-1`,
          externalAccountId: publishOptions.accountBinding.externalAccountId,
          timestamp: Date.parse(NOW),
        };
      },
    );
  const dependencies: PublicationBridgeV3CoordinatorDependencies = {
    extensionVersion: () => options.extensionVersion ?? "2.0.30",
    getAdapter: async (platform) => adapters[platform as PlatformId] ?? null,
    syncToPlatform,
    store,
    now: () => new Date(NOW),
    createId: (prefix) => `${prefix}-fixture`,
    sha256: options.sha256 ?? vi.fn().mockResolvedValue(VALID_DIGEST),
  };
  return {
    adapters,
    store,
    syncToPlatform,
    coordinator: new PublicationBridgeV3Coordinator(dependencies),
    dependencies,
  };
}

function negotiationRequest(requestId = "request-negotiate") {
  return PublicationBridgeV3RequestSchema.parse({
    namespace: PUBLICATION_BRIDGE_NAMESPACE,
    direction: "REQUEST",
    protocolMajor: PUBLICATION_BRIDGE_PROTOCOL_MAJOR,
    command: "bridge.negotiate",
    requestId,
    supportedContractVersions: [PUBLICATION_BRIDGE_CONTRACT_VERSION],
  });
}

function commandRequest(
  sessionId: string,
  command: Exclude<PublicationBridgeV3Request["command"], "bridge.negotiate">,
  fields: Record<string, unknown>,
) {
  return PublicationBridgeV3RequestSchema.parse({
    namespace: PUBLICATION_BRIDGE_NAMESPACE,
    direction: "REQUEST",
    protocolMajor: PUBLICATION_BRIDGE_PROTOCOL_MAJOR,
    contractVersion: PUBLICATION_BRIDGE_CONTRACT_VERSION,
    sessionId,
    command,
    ...fields,
  });
}

function publishRequest(
  sessionId: string,
  overrides: {
    requestId?: string;
    operationId?: string;
    idempotencyKey?: string;
    payloadDigest?: string;
    title?: string;
    targets?: Array<{
      targetId: string;
      platform: PlatformId;
      requestedExternalAccountId: string;
    }>;
  } = {},
) {
  return commandRequest(sessionId, "publication.publishDraft", {
    requestId: overrides.requestId ?? "request-publish-1",
    operationId: overrides.operationId ?? "operation-publish-1",
    payload: {
      idempotencyKey: overrides.idempotencyKey ?? "idempotency-publish-1",
      payloadDigest: overrides.payloadDigest ?? VALID_DIGEST,
      draft: {
        documentId: "article-version-1",
        title: overrides.title ?? "Bridge v3 article",
        body: "<p>Shared-contract publication body.</p>",
        contentFormat: "HTML",
      },
      targets: overrides.targets ?? [
        {
          targetId: "target-zhihu-1",
          platform: "zhihu",
          requestedExternalAccountId: "zhihu-account",
        },
      ],
    },
  });
}

async function exchange(
  coordinator: PublicationBridgeV3Coordinator,
  request: PublicationBridgeV3Request,
): Promise<PublicationBridgeV3Response> {
  const response = await coordinator.handle(request);
  if (request.command === "bridge.negotiate") {
    PublicationBridgeV3NegotiationExchangeSchema.parse({ request, response });
  } else {
    PublicationBridgeV3CommandExchangeSchema.parse({ request, response });
  }
  return response;
}

async function negotiate(
  coordinator: PublicationBridgeV3Coordinator,
): Promise<string> {
  const response = await exchange(coordinator, negotiationRequest());
  if (response.command !== "bridge.negotiate" || !response.ok) {
    throw new Error("Expected a successful Bridge v3 negotiation");
  }
  return response.result.sessionId;
}

interface StoredStateSnapshot {
  sessions: Record<string, unknown>;
  operations: Record<string, PublicationBridgeV3PublishOperationSnapshot>;
  tasks: Record<string, unknown>;
}

describe("PublicationBridgeV3Coordinator negotiation and account resolution", () => {
  it("negotiates the live four-platform publish runtime without overstating Toutiao inspection", async () => {
    const { coordinator } = createHarness();
    const response = await exchange(coordinator, negotiationRequest());

    expect(response).toMatchObject({
      command: "bridge.negotiate",
      ok: true,
      result: {
        selectedContractVersion: "3.0",
        sessionId: "session-fixture",
        runtime: {
          extensionVersion: "2.0.30",
          bridgeCapabilities: expect.arrayContaining([
            "bridge.accounts.resolve",
            "bridge.publication.publish-draft",
            "bridge.publication.operation-query",
            "bridge.publication.inspect",
            "bridge.publication.open-draft",
          ]),
          adapters: expect.arrayContaining(
            (["zhihu", "sohu", "weixin", "toutiao"] as const).map((platform) =>
              expect.objectContaining({
                platform,
                adapterVersion: "1.0.0",
                capabilities: expect.arrayContaining([
                  "adapter.account.identity",
                  "adapter.draft.publish",
                ]),
              }),
            ),
          ),
        },
      },
    });

    if (response.command !== "bridge.negotiate" || !response.ok) return;
    const toutiao = response.result.runtime.adapters.find(
      (adapter) => adapter.platform === "toutiao",
    );
    expect(toutiao?.capabilities).not.toContain("adapter.publication.inspect");
    expect(toutiao?.capabilities).not.toContain(
      "adapter.publication.public-url",
    );
    expect(response.result.runtime.bridgeCapabilities).not.toContain(
      "bridge.publication.operation-events",
    );
  });

  it("projects AVAILABLE, LOGIN_REQUIRED, ACCOUNT_MISMATCH and UNAVAILABLE probes", async () => {
    const adapters = createAdapters();
    adapters.sohu.probeAccounts = vi.fn().mockResolvedValue({
      status: "NOT_AUTHENTICATED",
      accounts: [],
    });
    adapters.weixin.probeAccounts = vi
      .fn()
      .mockResolvedValue(authenticatedAccount("weixin", "another-weixin"));
    adapters.toutiao.probeAccounts = vi.fn().mockResolvedValue({
      status: "PROBE_FAILED",
      accounts: [],
      errorCode: "NETWORK_ERROR",
    });
    const { coordinator } = createHarness({ adapters });
    const sessionId = await negotiate(coordinator);
    const request = commandRequest(sessionId, "accounts.resolve", {
      requestId: "request-accounts-1",
      payload: {
        targets: [
          {
            platform: "zhihu",
            expectedExternalAccountId: "zhihu-account",
          },
          {
            platform: "sohu",
            expectedExternalAccountId: "sohu-account",
          },
          {
            platform: "weixin",
            expectedExternalAccountId: "weixin-account",
          },
          {
            platform: "toutiao",
            expectedExternalAccountId: "toutiao-account",
          },
        ],
      },
    });

    const response = await exchange(coordinator, request);
    expect(response).toMatchObject({
      command: "accounts.resolve",
      ok: true,
      result: {
        probes: [
          {
            platform: "zhihu",
            status: "AVAILABLE",
            account: { externalAccountId: "zhihu-account" },
          },
          {
            platform: "sohu",
            status: "LOGIN_REQUIRED",
            requiredUserAction: "LOGIN",
          },
          {
            platform: "weixin",
            status: "ACCOUNT_MISMATCH",
            observedExternalAccountId: "another-weixin",
            requiredUserAction: "SWITCH_ACCOUNT",
          },
          {
            platform: "toutiao",
            status: "UNAVAILABLE",
            reasonCode: "adapter.network-error",
            requiredUserAction: "REVIEW_MANUALLY",
          },
        ],
      },
    });
  });
});

describe("PublicationBridgeV3Coordinator durable publication lifecycle", () => {
  it("rejects a digest mismatch before creating or dispatching an operation", async () => {
    const { coordinator, store, syncToPlatform } = createHarness();
    const sessionId = await negotiate(coordinator);

    const response = await exchange(
      coordinator,
      publishRequest(sessionId, { payloadDigest: OTHER_DIGEST }),
    );

    expect(response).toMatchObject({
      command: "publication.publishDraft",
      ok: false,
      dispatchState: "NOT_DISPATCHED",
      error: {
        code: "publication.payload-digest-mismatch",
        retryPolicy: "DO_NOT_RETRY",
      },
    });
    expect(syncToPlatform).not.toHaveBeenCalled();
    expect(
      Object.keys(store.snapshot<StoredStateSnapshot>().operations),
    ).toHaveLength(0);
  });

  it("persists ACCEPTED before execution, persists DISPATCHED in beforeDispatch, then completes", async () => {
    const store = new MemoryStateStore();
    const persistenceObserved: Array<{
      phase: string;
      writeState: string;
    }> = [];
    const syncToPlatform = vi.fn<
      PublicationBridgeV3CoordinatorDependencies["syncToPlatform"]
    >(async (platform, _article, options) => {
      const before =
        store.snapshot<StoredStateSnapshot>().operations["operation-publish-1"]
          .targets[0];
      if (before.outcome === "PENDING") {
        persistenceObserved.push({
          phase: before.phase,
          writeState: before.writeState,
        });
      }

      await options.beforeDispatch();

      const after =
        store.snapshot<StoredStateSnapshot>().operations["operation-publish-1"]
          .targets[0];
      if (after.outcome === "PENDING") {
        persistenceObserved.push({
          phase: after.phase,
          writeState: after.writeState,
        });
      }
      return {
        platform,
        success: true,
        outcome: "SUCCEEDED",
        postId: "zhihu-post-verified",
        externalAccountId: options.accountBinding.externalAccountId,
        timestamp: Date.parse(NOW),
      };
    });
    const { coordinator } = createHarness({ store, syncToPlatform });
    const sessionId = await negotiate(coordinator);

    const accepted = await exchange(coordinator, publishRequest(sessionId));
    expect(accepted).toMatchObject({
      command: "publication.publishDraft",
      ok: true,
      result: {
        disposition: "ACCEPTED",
        operation: {
          operationId: "operation-publish-1",
          state: "ACCEPTED",
          targets: [
            {
              outcome: "PENDING",
              phase: "QUEUED",
              writeState: "NOT_DISPATCHED",
            },
          ],
        },
      },
    });
    expect(syncToPlatform).not.toHaveBeenCalled();
    expect(
      store.snapshot<StoredStateSnapshot>().operations["operation-publish-1"]
        .state,
    ).toBe("ACCEPTED");

    const completed = await coordinator.runPublicationOperation(
      "operation-publish-1",
    );
    expect(
      PublicationBridgeV3PublishOperationSnapshotSchema.parse(completed),
    ).toMatchObject({
      operationId: "operation-publish-1",
      state: "COMPLETED",
      targets: [
        {
          outcome: "SUCCEEDED",
          writeState: "DISPATCHED",
          observedExternalAccountId: "zhihu-account",
          platformPostId: "zhihu-post-verified",
        },
      ],
    });
    expect(persistenceObserved).toEqual([
      { phase: "DISPATCHING", writeState: "NOT_DISPATCHED" },
      { phase: "AWAITING_RESULT", writeState: "DISPATCHED" },
    ]);
    expect(
      store.snapshot<StoredStateSnapshot>().tasks["operation-publish-1"],
    ).toBeUndefined();
  });

  it("returns the first operation as REPLAYED for the same key and digest", async () => {
    const { coordinator } = createHarness();
    const sessionId = await negotiate(coordinator);
    await exchange(coordinator, publishRequest(sessionId));

    const replay = await exchange(
      coordinator,
      publishRequest(sessionId, {
        requestId: "request-publish-replay",
        operationId: "operation-replay-envelope",
      }),
    );
    expect(replay).toMatchObject({
      requestId: "request-publish-replay",
      operationId: "operation-replay-envelope",
      ok: true,
      result: {
        disposition: "REPLAYED",
        operation: { operationId: "operation-publish-1" },
      },
    });
  });

  it("retains completed operations as the durable idempotency ledger", async () => {
    const first = createHarness();
    const firstSessionId = await negotiate(first.coordinator);
    await exchange(first.coordinator, publishRequest(firstSessionId));
    await first.coordinator.runPublicationOperation("operation-publish-1");

    const template = first.store.snapshot<StoredStateSnapshot>().operations[
      "operation-publish-1"
    ];
    const operations: StoredStateSnapshot["operations"] = {};
    for (let index = 0; index <= 100; index += 1) {
      const operationId = `operation-history-${index}`;
      operations[operationId] =
        PublicationBridgeV3PublishOperationSnapshotSchema.parse({
          ...template,
          operationId,
          idempotencyKey: `idempotency-history-${index}`,
        });
    }

    const store = new MemoryStateStore({
      sessions: {},
      operations,
      tasks: {},
    });
    const { coordinator } = createHarness({ store });
    const sessionId = await negotiate(coordinator);
    const replay = await exchange(
      coordinator,
      publishRequest(sessionId, {
        requestId: "request-history-replay",
        operationId: "operation-history-replay-envelope",
        idempotencyKey: "idempotency-history-100",
      }),
    );

    expect(replay).toMatchObject({
      ok: true,
      result: {
        disposition: "REPLAYED",
        operation: { operationId: "operation-history-100" },
      },
    });
    expect(
      Object.keys(store.snapshot<StoredStateSnapshot>().operations),
    ).toHaveLength(101);
  });

  it("fails an accepted operation before dispatch when the producer runtime changed", async () => {
    const store = new MemoryStateStore();
    const first = createHarness({ store, extensionVersion: "2.0.30" });
    const firstSessionId = await negotiate(first.coordinator);
    await exchange(first.coordinator, publishRequest(firstSessionId));

    const syncToPlatform = vi.fn<
      PublicationBridgeV3CoordinatorDependencies["syncToPlatform"]
    >();
    const upgraded = createHarness({
      store,
      syncToPlatform,
      extensionVersion: "2.0.31",
    });
    const upgradedSessionId = await negotiate(upgraded.coordinator);
    const replay = await exchange(
      upgraded.coordinator,
      publishRequest(upgradedSessionId, {
        requestId: "request-upgraded-replay",
        operationId: "operation-upgraded-replay-envelope",
      }),
    );
    expect(replay).toMatchObject({
      ok: true,
      result: { disposition: "REPLAYED" },
    });

    const operation = await upgraded.coordinator.runPublicationOperation(
      "operation-publish-1",
    );
    expect(operation).toMatchObject({
      state: "COMPLETED",
      targets: [
        {
          outcome: "FAILED",
          writeState: "NOT_DISPATCHED",
          error: {
            code: "publication.runtime-changed-before-dispatch",
            stage: "CAPABILITY",
            retryPolicy: "SAFE_TO_RETRY",
          },
        },
      ],
    });
    expect(syncToPlatform).not.toHaveBeenCalled();
    expect(
      store.snapshot<StoredStateSnapshot>().tasks["operation-publish-1"],
    ).toBeUndefined();
  });

  it("rejects the same idempotency key with a different canonical payload", async () => {
    const sha256 = vi
      .fn<NonNullable<PublicationBridgeV3CoordinatorDependencies["sha256"]>>()
      .mockResolvedValueOnce(VALID_DIGEST)
      .mockResolvedValueOnce(OTHER_DIGEST);
    const { coordinator } = createHarness({ sha256 });
    const sessionId = await negotiate(coordinator);
    await exchange(coordinator, publishRequest(sessionId));

    const conflict = await exchange(
      coordinator,
      publishRequest(sessionId, {
        requestId: "request-publish-conflict",
        operationId: "operation-publish-conflict",
        title: "Changed title",
        payloadDigest: OTHER_DIGEST,
      }),
    );
    expect(conflict).toMatchObject({
      ok: false,
      dispatchState: "NOT_DISPATCHED",
      error: {
        code: "publication.idempotency-conflict",
        existingOperationId: "operation-publish-1",
        retryPolicy: "DO_NOT_RETRY",
      },
    });
  });

  it("settles a post-dispatch failure as OUTCOME_UNKNOWN and DO_NOT_RETRY", async () => {
    const syncToPlatform = vi.fn<
      PublicationBridgeV3CoordinatorDependencies["syncToPlatform"]
    >(async (platform, _article, options) => {
      await options.beforeDispatch();
      return {
        platform,
        success: false,
        outcome: "FAILED",
        errorCode: "HTTP_ERROR",
        error: "The platform response was not conclusive.",
        timestamp: Date.parse(NOW),
      };
    });
    const { coordinator } = createHarness({ syncToPlatform });
    const sessionId = await negotiate(coordinator);
    await exchange(coordinator, publishRequest(sessionId));

    const operation = await coordinator.runPublicationOperation(
      "operation-publish-1",
    );
    expect(operation).toMatchObject({
      state: "COMPLETED",
      targets: [
        {
          outcome: "OUTCOME_UNKNOWN",
          writeState: "DISPATCHED",
          error: {
            code: "publication.outcome-unknown",
            retryPolicy: "DO_NOT_RETRY",
            requiredUserAction: "REVIEW_MANUALLY",
          },
        },
      ],
    });
  });

  it.each([42, "x".repeat(501)])(
    "settles malformed post-dispatch identifier %s without allowing redispatch",
    async (postId) => {
      const syncToPlatform = vi.fn<
        PublicationBridgeV3CoordinatorDependencies["syncToPlatform"]
      >(async (platform, _article, options) => {
        await options.beforeDispatch();
        return {
          platform,
          success: true,
          outcome: "SUCCEEDED",
          postId: postId as unknown as string,
          externalAccountId: options.accountBinding.externalAccountId,
          timestamp: Date.parse(NOW),
        };
      });
      const { coordinator, store } = createHarness({ syncToPlatform });
      const sessionId = await negotiate(coordinator);
      await exchange(coordinator, publishRequest(sessionId));

      const firstRun = await coordinator.runPublicationOperation(
        "operation-publish-1",
      );
      expect(firstRun).toMatchObject({
        state: "COMPLETED",
        targets: [
          {
            outcome: "OUTCOME_UNKNOWN",
            writeState: "DISPATCHED",
            error: {
              code: "publication.outcome-unknown",
              retryPolicy: "DO_NOT_RETRY",
            },
          },
        ],
      });

      const replay = await coordinator.runPublicationOperation(
        "operation-publish-1",
      );
      expect(replay).toBeNull();
      expect(syncToPlatform).toHaveBeenCalledTimes(1);
      expect(
        store.snapshot<StoredStateSnapshot>().operations[
          "operation-publish-1"
        ],
      ).toEqual(firstRun);
      expect(
        store.snapshot<StoredStateSnapshot>().tasks["operation-publish-1"],
      ).toBeUndefined();
    },
  );

  it("fails closed when post-dispatch result processing throws", async () => {
    const syncToPlatform = vi.fn<
      PublicationBridgeV3CoordinatorDependencies["syncToPlatform"]
    >(async (platform, _article, options) => {
      await options.beforeDispatch();
      const result = {
        platform,
        success: true,
        outcome: "SUCCEEDED" as const,
        postId: "zhihu-post-1",
        externalAccountId: options.accountBinding.externalAccountId,
        timestamp: Date.parse(NOW),
      };
      return new Proxy(result, {
        get(target, property, receiver) {
          if (property === "postId") throw new Error("malformed adapter result");
          return Reflect.get(target, property, receiver);
        },
      });
    });
    const { coordinator, store } = createHarness({ syncToPlatform });
    const sessionId = await negotiate(coordinator);
    await exchange(coordinator, publishRequest(sessionId));

    const operation = await coordinator.runPublicationOperation(
      "operation-publish-1",
    );
    expect(operation).toMatchObject({
      state: "COMPLETED",
      targets: [
        {
          outcome: "OUTCOME_UNKNOWN",
          writeState: "DISPATCHED",
          error: {
            code: "publication.outcome-unknown",
            retryPolicy: "DO_NOT_RETRY",
          },
        },
      ],
    });
    await coordinator.runPublicationOperation("operation-publish-1");
    expect(syncToPlatform).toHaveBeenCalledTimes(1);
    expect(
      store.snapshot<StoredStateSnapshot>().tasks["operation-publish-1"],
    ).toBeUndefined();
  });

  it("settles a failure before dispatch as FAILED and SAFE_TO_RETRY", async () => {
    const syncToPlatform = vi.fn<
      PublicationBridgeV3CoordinatorDependencies["syncToPlatform"]
    >(async (platform) => ({
      platform,
      success: false,
      outcome: "FAILED",
      errorCode: "ACCOUNT_MISMATCH",
      error: "The account validation rejected the write.",
      timestamp: Date.parse(NOW),
    }));
    const { coordinator } = createHarness({ syncToPlatform });
    const sessionId = await negotiate(coordinator);
    await exchange(coordinator, publishRequest(sessionId));

    const operation = await coordinator.runPublicationOperation(
      "operation-publish-1",
    );
    expect(operation).toMatchObject({
      state: "COMPLETED",
      targets: [
        {
          outcome: "FAILED",
          writeState: "NOT_DISPATCHED",
          error: {
            code: "adapter.account-mismatch",
            retryPolicy: "SAFE_TO_RETRY",
            requiredUserAction: "RETRY",
          },
        },
      ],
    });
  });

  it("recovers RUNNING targets according to their persisted dispatch boundary", async () => {
    const first = createHarness();
    const sessionId = await negotiate(first.coordinator);
    const targets = [
      {
        targetId: "target-zhihu-1",
        platform: "zhihu" as const,
        requestedExternalAccountId: "zhihu-account",
      },
      {
        targetId: "target-sohu-1",
        platform: "sohu" as const,
        requestedExternalAccountId: "sohu-account",
      },
    ];
    await exchange(first.coordinator, publishRequest(sessionId, { targets }));

    const seed = first.store.snapshot<StoredStateSnapshot>();
    const accepted = seed.operations["operation-publish-1"];
    seed.operations["operation-publish-1"] =
      PublicationBridgeV3PublishOperationSnapshotSchema.parse({
        ...accepted,
        state: "RUNNING",
        targets: [
          {
            ...targets[0],
            outcome: "PENDING",
            phase: "AWAITING_RESULT",
            writeState: "DISPATCHED",
          },
          {
            ...targets[1],
            outcome: "PENDING",
            phase: "DISPATCHING",
            writeState: "NOT_DISPATCHED",
          },
        ],
      });

    const recoveredStore = new MemoryStateStore(seed);
    const syncToPlatform =
      vi.fn<PublicationBridgeV3CoordinatorDependencies["syncToPlatform"]>();
    const recovered = createHarness({
      store: recoveredStore,
      syncToPlatform,
    });
    const getOperation = commandRequest(sessionId, "publication.getOperation", {
      requestId: "request-get-recovered",
      operationId: "operation-publish-1",
      payload: {},
    });

    const response = await exchange(recovered.coordinator, getOperation);
    expect(response).toMatchObject({
      ok: true,
      result: {
        operation: {
          state: "COMPLETED",
          targets: [
            {
              platform: "zhihu",
              outcome: "OUTCOME_UNKNOWN",
              writeState: "DISPATCHED",
              error: { retryPolicy: "DO_NOT_RETRY" },
            },
            {
              platform: "sohu",
              outcome: "FAILED",
              writeState: "NOT_DISPATCHED",
              error: { retryPolicy: "SAFE_TO_RETRY" },
            },
          ],
        },
      },
    });
    expect(syncToPlatform).not.toHaveBeenCalled();
  });

  it("returns a completed operation through publication.getOperation", async () => {
    const { coordinator } = createHarness();
    const sessionId = await negotiate(coordinator);
    await exchange(coordinator, publishRequest(sessionId));
    await coordinator.runPublicationOperation("operation-publish-1");

    const response = await exchange(
      coordinator,
      commandRequest(sessionId, "publication.getOperation", {
        requestId: "request-get-operation",
        operationId: "operation-publish-1",
        payload: {},
      }),
    );
    expect(response).toMatchObject({
      command: "publication.getOperation",
      ok: true,
      result: {
        runtime: { extensionVersion: "2.0.30" },
        operation: {
          operationId: "operation-publish-1",
          state: "COMPLETED",
        },
      },
    });
  });
});

describe("PublicationBridgeV3Coordinator inspection and draft-open commands", () => {
  it("returns a contract-valid published inspection and rejects Toutiao locator-only inspection", async () => {
    const { coordinator } = createHarness();
    const sessionId = await negotiate(coordinator);
    const inspectZhihu = commandRequest(sessionId, "publication.inspect", {
      requestId: "request-inspect-zhihu",
      operationId: "operation-inspect-zhihu",
      payload: {
        platform: "zhihu",
        requestedExternalAccountId: "zhihu-account",
        locator: {
          platformPostId: "123456",
          publicUrl: "https://zhuanlan.zhihu.com/p/123456",
          publicIdentityKey: "zhihu:post:v1:123456",
        },
      },
    });

    const published = await exchange(coordinator, inspectZhihu);
    expect(published).toMatchObject({
      command: "publication.inspect",
      ok: true,
      result: {
        platform: "zhihu",
        requestedExternalAccountId: "zhihu-account",
        observations: [
          {
            kind: "PUBLISHED",
            matchedLocator: {
              type: "PUBLIC_IDENTITY",
              publicIdentityKey: "zhihu:post:v1:123456",
            },
            platformPostId: "123456",
            canonicalUrl: "https://zhuanlan.zhihu.com/p/123456",
            publicIdentityKey: "zhihu:post:v1:123456",
            observedExternalAccountId: "zhihu-account",
            publicAccess: {
              status: "CONFIRMED",
              httpStatus: 200,
            },
          },
        ],
      },
    });

    const toutiao = await exchange(
      coordinator,
      commandRequest(sessionId, "publication.inspect", {
        requestId: "request-inspect-toutiao",
        operationId: "operation-inspect-toutiao",
        payload: {
          platform: "toutiao",
          requestedExternalAccountId: "toutiao-account",
          locator: { platformPostId: "7522222222222222222" },
        },
      }),
    );
    expect(toutiao).toMatchObject({
      ok: false,
      error: {
        code: "adapter.inspection-unavailable",
        stage: "CAPABILITY",
        retryPolicy: "DO_NOT_RETRY",
      },
    });
  });

  it("opens a Weixin draft without exposing an editor URL and fails closed elsewhere", async () => {
    const { adapters, coordinator } = createHarness();
    const sessionId = await negotiate(coordinator);
    const openWeixin = commandRequest(sessionId, "publication.openDraft", {
      requestId: "request-open-weixin",
      operationId: "operation-open-weixin",
      payload: {
        platform: "weixin",
        requestedExternalAccountId: "weixin-account",
        draftReference: "9001001",
      },
    });

    const opened = await exchange(coordinator, openWeixin);
    expect(opened).toMatchObject({
      command: "publication.openDraft",
      ok: true,
      result: {
        platform: "weixin",
        observedExternalAccountId: "weixin-account",
        draftReference: "9001001",
        opened: true,
      },
    });
    expect(adapters.weixin.openPublicationDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        platform: "weixin",
        externalAccountId: "weixin-account",
        platformPostId: "9001001",
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(JSON.stringify(opened)).not.toContain("token=");

    const unavailable = await exchange(
      coordinator,
      commandRequest(sessionId, "publication.openDraft", {
        requestId: "request-open-sohu",
        operationId: "operation-open-sohu",
        payload: {
          platform: "sohu",
          requestedExternalAccountId: "sohu-account",
          draftReference: "sohu-draft-1",
        },
      }),
    );
    expect(unavailable).toMatchObject({
      ok: false,
      error: {
        code: "adapter.draft-open-unavailable",
        stage: "CAPABILITY",
      },
    });
  });
});
