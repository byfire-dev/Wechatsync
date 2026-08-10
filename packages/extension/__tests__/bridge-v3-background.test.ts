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
import {
  PublicationInspectionTimeoutError,
  withPublicationInspectionDeadline,
} from "../src/background/publication-inspection-runner";

const NOW = "2026-08-02T08:00:00.000Z";
const OBSERVED_AT = "2026-08-02T07:59:30.000Z";
const PUBLISHED_AT = "2026-08-02T07:58:00.000Z";
const VALID_DIGEST = `sha256:${"1".repeat(64)}`;
const OTHER_DIGEST = `sha256:${"2".repeat(64)}`;
const CALLER_A = { tabId: 42, documentId: "document-a" };
const CALLER_B = { tabId: 42, documentId: "document-b" };

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
    openPublicationDraft: vi.fn().mockResolvedValue({ opened: true }),
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

function negotiationRequest(
  requestId = "request-negotiate",
  supportedContractVersions: string[] = [PUBLICATION_BRIDGE_CONTRACT_VERSION],
) {
  return PublicationBridgeV3RequestSchema.parse({
    namespace: PUBLICATION_BRIDGE_NAMESPACE,
    direction: "REQUEST",
    protocolMajor: PUBLICATION_BRIDGE_PROTOCOL_MAJOR,
    command: "bridge.negotiate",
    requestId,
    supportedContractVersions,
  });
}

function commandRequest(
  sessionId: string,
  command: Exclude<PublicationBridgeV3Request["command"], "bridge.negotiate">,
  fields: Record<string, unknown>,
  contractVersion: "3.0" | "3.1" | "3.2" = PUBLICATION_BRIDGE_CONTRACT_VERSION,
) {
  return PublicationBridgeV3RequestSchema.parse({
    namespace: PUBLICATION_BRIDGE_NAMESPACE,
    direction: "REQUEST",
    protocolMajor: PUBLICATION_BRIDGE_PROTOCOL_MAJOR,
    contractVersion,
    sessionId,
    command,
    ...(command === "publication.inspect" && contractVersion === "3.2"
      ? {
          deadlineAt:
            fields.deadlineAt ?? new Date(Date.now() + 32_000).toISOString(),
        }
      : {}),
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
  supportedContractVersions: string[] = [PUBLICATION_BRIDGE_CONTRACT_VERSION],
): Promise<string> {
  const response = await exchange(
    coordinator,
    negotiationRequest("request-negotiate", supportedContractVersions),
  );
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
    const response = await exchange(
      coordinator,
      negotiationRequest("request-negotiate", ["3.0", "3.1"]),
    );

    expect(response).toMatchObject({
      command: "bridge.negotiate",
      ok: true,
      result: {
        selectedContractVersion: "3.1",
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
                adapterVersion:
                  platform === "weixin"
                    ? "1.0.0"
                    : platform === "sohu"
                      ? "1.2.0"
                      : "1.1.0",
                capabilities: expect.arrayContaining([
                  "adapter.account.identity",
                  "adapter.draft.publish",
                  "adapter.draft.open",
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
    expect(response.result.runtime.bridgeCapabilities).not.toContain(
      "bridge.request.cancel",
    );
  });

  it("advertises request cancellation only after selecting wire 3.2", async () => {
    const { coordinator } = createHarness();
    const response = await exchange(
      coordinator,
      negotiationRequest("request-negotiate-v32-capability", ["3.2"]),
    );

    expect(response).toMatchObject({
      command: "bridge.negotiate",
      ok: true,
      result: {
        selectedContractVersion: "3.2",
        runtime: {
          bridgeCapabilities: expect.arrayContaining([
            "bridge.request.cancel",
            "bridge.publication.inspect",
          ]),
        },
      },
    });
  });

  it("binds every command to the contract version selected for its session", async () => {
    const { coordinator } = createHarness();
    const sessionId = await negotiate(coordinator, ["3.0"]);

    const response = await exchange(
      coordinator,
      commandRequest(
        sessionId,
        "accounts.resolve",
        {
          requestId: "request-cross-version-session",
          payload: {
            targets: [
              {
                platform: "zhihu",
                expectedExternalAccountId: "zhihu-account",
              },
            ],
          },
        },
        "3.1",
      ),
    );

    expect(response).toMatchObject({
      contractVersion: "3.1",
      ok: false,
      error: {
        code: "bridge.session-invalid",
        stage: "NEGOTIATION",
      },
    });
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

    const template =
      first.store.snapshot<StoredStateSnapshot>().operations[
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

    const syncToPlatform =
      vi.fn<PublicationBridgeV3CoordinatorDependencies["syncToPlatform"]>();
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
        store.snapshot<StoredStateSnapshot>().operations["operation-publish-1"],
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
          if (property === "postId")
            throw new Error("malformed adapter result");
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

  it("never applies an inspection cancellation to an external publish operation", async () => {
    let releasePublish: (() => void) | undefined;
    const publishGate = new Promise<void>((resolve) => {
      releasePublish = resolve;
    });
    const syncToPlatform = vi.fn<
      PublicationBridgeV3CoordinatorDependencies["syncToPlatform"]
    >(async (platform, _article, options) => {
      await options.beforeDispatch();
      await publishGate;
      return {
        platform,
        success: true,
        outcome: "SUCCEEDED",
        postId: `${platform}-post-1`,
        externalAccountId: options.accountBinding.externalAccountId,
        timestamp: Date.parse(NOW),
      };
    });
    const { coordinator } = createHarness({ syncToPlatform });
    const sessionId = await negotiate(coordinator, ["3.2"]);
    const publish = publishRequest(sessionId);
    await exchange(coordinator, publish);
    const running = coordinator.runPublicationOperation(publish.operationId);
    await vi.waitFor(() => expect(syncToPlatform).toHaveBeenCalledTimes(1));

    const cancellation = commandRequest(
      sessionId,
      "bridge.cancel",
      {
        requestId: "request-cancel-must-not-touch-publish",
        operationId: publish.operationId,
        payload: {
          targetRequestId: publish.requestId,
          targetCommand: "publication.inspect",
          reason: "CALLER_ABORTED",
        },
      },
      "3.2",
    );
    await expect(
      coordinator.handle(cancellation, { caller: CALLER_A }),
    ).resolves.toMatchObject({
      command: "bridge.cancel",
      ok: true,
      result: { disposition: "CANCELLED" },
    });

    releasePublish?.();
    await running;
    const completed = await exchange(
      coordinator,
      commandRequest(sessionId, "publication.getOperation", {
        requestId: "request-get-operation-after-cancel",
        operationId: publish.operationId,
        payload: {},
      }),
    );
    expect(completed).toMatchObject({
      ok: true,
      result: {
        operation: {
          state: "COMPLETED",
          targets: [{ outcome: "SUCCEEDED" }],
        },
      },
    });
  });
});

describe("PublicationBridgeV3Coordinator inspection and draft-open commands", () => {
  it("keeps one active executor per inspection identity and cancels only the matching caller document", async () => {
    const adapters = createAdapters();
    let inspectionSignal: AbortSignal | undefined;
    adapters.zhihu.inspectPublication = vi.fn(
      (_request, context) =>
        new Promise((_resolve, reject) => {
          inspectionSignal = context?.signal;
          context?.signal?.addEventListener(
            "abort",
            () => reject(context.signal?.reason),
            { once: true },
          );
        }),
    );
    const { coordinator } = createHarness({ adapters });
    const sessionId = await negotiate(coordinator, ["3.2"]);
    const inspect = commandRequest(
      sessionId,
      "publication.inspect",
      {
        requestId: "request-inspect-cancellable",
        operationId: "operation-inspect-cancellable",
        deadlineAt: new Date(Date.now() + 30_000).toISOString(),
        payload: {
          platform: "zhihu",
          requestedExternalAccountId: "zhihu-account",
          locator: { platformPostId: "123456" },
        },
      },
      "3.2",
    );
    const pending = coordinator.handle(inspect, { caller: CALLER_A });
    await vi.waitFor(() => {
      expect(adapters.zhihu.inspectPublication).toHaveBeenCalledTimes(1);
    });

    const duplicate = await coordinator.handle(inspect, { caller: CALLER_A });
    expect(duplicate).toMatchObject({
      command: "publication.inspect",
      ok: false,
      error: {
        code: "bridge.request-already-active",
        stage: "PROTOCOL",
        retryPolicy: "DO_NOT_RETRY",
      },
    });
    expect(adapters.zhihu.inspectPublication).toHaveBeenCalledTimes(1);

    const cancel = (requestId: string) =>
      commandRequest(
        sessionId,
        "bridge.cancel",
        {
          requestId,
          operationId: inspect.operationId,
          payload: {
            targetRequestId: inspect.requestId,
            targetCommand: "publication.inspect",
            reason: "CALLER_ABORTED",
          },
        },
        "3.2",
      );

    const wrongCaller = await coordinator.handle(cancel("request-cancel-wrong"), {
      caller: CALLER_B,
    });
    expect(wrongCaller).toMatchObject({
      command: "bridge.cancel",
      ok: true,
      result: { disposition: "CANCELLED" },
    });
    expect(inspectionSignal?.aborted).toBe(false);

    const cancelled = await coordinator.handle(cancel("request-cancel-first"), {
      caller: CALLER_A,
    });
    expect(cancelled).toMatchObject({
      command: "bridge.cancel",
      ok: true,
      result: {
        targetRequestId: inspect.requestId,
        reason: "CALLER_ABORTED",
        disposition: "CANCELLED",
      },
    });
    await expect(pending).resolves.toMatchObject({
      command: "publication.inspect",
      ok: false,
      error: {
        code: "publication.inspection-cancelled",
        stage: "TRANSPORT",
        retryPolicy: "SAFE_TO_RETRY",
      },
    });
    expect(inspectionSignal?.aborted).toBe(true);

    const repeated = await coordinator.handle(cancel("request-cancel-second"), {
      caller: CALLER_A,
    });
    expect(repeated).toMatchObject({
      ok: true,
      result: { disposition: "ALREADY_CANCELLED" },
    });
  });

  it("validates the exact session wire and capability before cancelling an inspection", async () => {
    const adapters = createAdapters();
    const originalInspection = adapters.zhihu.inspectPublication;
    let inspectionSignal: AbortSignal | undefined;
    let releaseInspection: (() => void) | undefined;
    const inspectionGate = new Promise<void>((resolve) => {
      releaseInspection = resolve;
    });
    adapters.zhihu.inspectPublication = vi.fn(async (request, context) => {
      inspectionSignal = context?.signal;
      await inspectionGate;
      return originalInspection?.(request, context) ?? [];
    });
    const { coordinator } = createHarness({ adapters });
    const sessionId = await negotiate(coordinator, ["3.1"]);
    const inspect = commandRequest(
      sessionId,
      "publication.inspect",
      {
        requestId: "request-inspect-v31-not-cancellable",
        operationId: "operation-inspect-v31-not-cancellable",
        payload: {
          platform: "zhihu",
          requestedExternalAccountId: "zhihu-account",
          locator: { platformPostId: "123456" },
        },
      },
      "3.1",
    );
    const pending = coordinator.handle(inspect, { caller: CALLER_A });
    await vi.waitFor(() => {
      expect(adapters.zhihu.inspectPublication).toHaveBeenCalledTimes(1);
    });

    // The cancel envelope itself is valid 3.2, but it deliberately presents
    // the id of a session negotiated on 3.1. It must be rejected before the
    // matching active controller or tombstone can be touched.
    const crossWireCancel = commandRequest(
      sessionId,
      "bridge.cancel",
      {
        requestId: "request-cancel-v31-cross-wire",
        operationId: inspect.operationId,
        payload: {
          targetRequestId: inspect.requestId,
          targetCommand: "publication.inspect",
          reason: "CALLER_ABORTED",
        },
      },
      "3.2",
    );
    await expect(
      coordinator.handle(crossWireCancel, { caller: CALLER_A }),
    ).resolves.toMatchObject({
      command: "bridge.cancel",
      ok: false,
      error: {
        code: "bridge.session-invalid",
        stage: "NEGOTIATION",
      },
    });
    expect(inspectionSignal?.aborted).toBe(false);

    releaseInspection?.();
    await expect(pending).resolves.toMatchObject({
      command: "publication.inspect",
      contractVersion: "3.1",
      ok: true,
    });
  });

  it("honors cancel-before-start without platform I/O and reports terminal inspections", async () => {
    const harness = createHarness();
    const getAdapter = vi.fn(harness.dependencies.getAdapter);
    harness.dependencies.getAdapter = getAdapter;
    const sessionId = await negotiate(harness.coordinator, ["3.2"]);
    const callsAfterNegotiation = getAdapter.mock.calls.length;
    const inspect = commandRequest(
      sessionId,
      "publication.inspect",
      {
        requestId: "request-inspect-cancel-before-start",
        operationId: "operation-inspect-cancel-before-start",
        deadlineAt: new Date(Date.now() + 30_000).toISOString(),
        payload: {
          platform: "zhihu",
          requestedExternalAccountId: "zhihu-account",
          locator: { platformPostId: "123456" },
        },
      },
      "3.2",
    );
    const cancel = commandRequest(
      sessionId,
      "bridge.cancel",
      {
        requestId: "request-cancel-before-start",
        operationId: inspect.operationId,
        payload: {
          targetRequestId: inspect.requestId,
          targetCommand: "publication.inspect",
          reason: "CALLER_ABORTED",
        },
      },
      "3.2",
    );

    await expect(
      harness.coordinator.handle(cancel, { caller: CALLER_A }),
    ).resolves.toMatchObject({
      ok: true,
      result: { disposition: "CANCELLED" },
    });
    const callsAfterCancel = getAdapter.mock.calls.length;
    expect(callsAfterCancel).toBeGreaterThan(callsAfterNegotiation);

    await expect(
      harness.coordinator.handle(inspect, { caller: CALLER_A }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "publication.inspection-cancelled" },
    });
    expect(getAdapter).toHaveBeenCalledTimes(callsAfterCancel);
    expect(harness.adapters.zhihu.probeAccounts).not.toHaveBeenCalled();
    expect(harness.adapters.zhihu.inspectPublication).not.toHaveBeenCalled();

    const terminalInspect = commandRequest(
      sessionId,
      "publication.inspect",
      {
        requestId: "request-inspect-terminal",
        operationId: "operation-inspect-terminal",
        deadlineAt: new Date(Date.now() + 30_000).toISOString(),
        payload: {
          platform: "zhihu",
          requestedExternalAccountId: "zhihu-account",
          locator: { platformPostId: "123456" },
        },
      },
      "3.2",
    );
    await expect(
      harness.coordinator.handle(terminalInspect, { caller: CALLER_A }),
    ).resolves.toMatchObject({ ok: true });
    const cancelTerminal = commandRequest(
      sessionId,
      "bridge.cancel",
      {
        requestId: "request-cancel-terminal",
        operationId: terminalInspect.operationId,
        payload: {
          targetRequestId: terminalInspect.requestId,
          targetCommand: "publication.inspect",
          reason: "DEADLINE_EXCEEDED",
        },
      },
      "3.2",
    );
    await expect(
      harness.coordinator.handle(cancelTerminal, { caller: CALLER_A }),
    ).resolves.toMatchObject({
      ok: true,
      result: { disposition: "ALREADY_TERMINAL" },
    });
  });

  it("rejects an already-expired v3.2 deadline before runtime or adapter I/O", async () => {
    const harness = createHarness();
    const getAdapter = vi.fn(harness.dependencies.getAdapter);
    harness.dependencies.getAdapter = getAdapter;
    const sessionId = await negotiate(harness.coordinator, ["3.2"]);
    const callsAfterNegotiation = getAdapter.mock.calls.length;
    const inspect = commandRequest(
      sessionId,
      "publication.inspect",
      {
        requestId: "request-inspect-expired",
        operationId: "operation-inspect-expired",
        deadlineAt: new Date(Date.now() - 1).toISOString(),
        payload: {
          platform: "zhihu",
          requestedExternalAccountId: "zhihu-account",
          locator: { platformPostId: "123456" },
        },
      },
      "3.2",
    );

    await expect(
      harness.coordinator.handle(inspect, { caller: CALLER_A }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "publication.inspection-timeout",
        stage: "TIMEOUT",
      },
    });
    expect(getAdapter).toHaveBeenCalledTimes(callsAfterNegotiation);
    expect(harness.adapters.zhihu.probeAccounts).not.toHaveBeenCalled();
    expect(harness.adapters.zhihu.inspectPublication).not.toHaveBeenCalled();
  });

  it.each(["3.1", "3.2"] as const)(
    "maps and echoes the v%s publication window without weakening its timestamp",
    async (contractVersion) => {
      const publishedNotBefore = "2026-08-02T07:55:00.000Z";
      const { adapters, coordinator } = createHarness();
      const sessionId = await negotiate(coordinator, [contractVersion]);

      const response = await exchange(
        coordinator,
        commandRequest(
          sessionId,
          "publication.inspect",
          {
            requestId: `request-inspect-v${contractVersion.replace(".", "")}-window`,
            operationId: `operation-inspect-v${contractVersion.replace(".", "")}-window`,
            payload: {
              platform: "zhihu",
              requestedExternalAccountId: "zhihu-account",
              locator: { platformPostId: "123456" },
              publicationWindow: {
                publishedNotBefore,
                basis: "DISPATCH_STARTED_AT",
              },
            },
          },
          contractVersion,
        ),
      );

      expect(adapters.zhihu.inspectPublication).toHaveBeenCalledWith(
        expect.objectContaining({
          draft: expect.objectContaining({
            platformPostId: "123456",
            draftedAt: publishedNotBefore,
          }),
          articleHint: expect.objectContaining({
            publishedAfter: publishedNotBefore,
          }),
        }),
        expect.any(Object),
      );
      expect(response).toMatchObject({
        contractVersion,
        command: "publication.inspect",
        ok: true,
        result: {
          publicationWindow: {
            publishedNotBefore,
            basis: "DISPATCH_STARTED_AT",
          },
        },
      });
      if (response.command !== "publication.inspect" || !response.ok) {
        throw new Error(`Expected a successful v${contractVersion} inspection`);
      }
      if (contractVersion === "3.2") {
        expect(response.result.runtime.bridgeCapabilities).toContain(
          "bridge.request.cancel",
        );
      } else {
        expect(response.result.runtime.bridgeCapabilities).not.toContain(
          "bridge.request.cancel",
        );
      }
    },
  );

  it("keeps v3.0 inspection compatible when no publication window is sent", async () => {
    const { adapters, coordinator } = createHarness();
    const sessionId = await negotiate(coordinator, ["3.0"]);

    const response = await exchange(
      coordinator,
      commandRequest(
        sessionId,
        "publication.inspect",
        {
          requestId: "request-inspect-v30-no-window",
          operationId: "operation-inspect-v30-no-window",
          payload: {
            platform: "zhihu",
            requestedExternalAccountId: "zhihu-account",
            locator: { platformPostId: "123456" },
          },
        },
        "3.0",
      ),
    );

    const inspectPublication = vi.mocked(adapters.zhihu.inspectPublication!);
    const internalRequest = inspectPublication.mock.calls[0]?.[0];
    expect(internalRequest).toMatchObject({
      draft: {
        platformPostId: "123456",
        draftedAt: "1970-01-01T00:00:00.000Z",
      },
    });
    expect(internalRequest?.articleHint).not.toHaveProperty("publishedAfter");
    expect(response).toMatchObject({
      contractVersion: "3.0",
      command: "publication.inspect",
      ok: true,
    });
    if (response.command !== "publication.inspect" || !response.ok) {
      throw new Error("Expected a successful v3.0 inspection");
    }
    expect(response.result).not.toHaveProperty("publicationWindow");
  });

  it("returns a contract-valid published inspection and rejects Toutiao locator-only inspection", async () => {
    const { adapters, coordinator } = createHarness();
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
    expect(adapters.zhihu.probeAccounts).toHaveBeenCalledTimes(1);
    expect(adapters.zhihu.inspectPublication).toHaveBeenCalledWith(
      expect.objectContaining({
        knownPublicLocator: {
          publicUrl: "https://zhuanlan.zhihu.com/p/123456",
          publicIdentityKey: "zhihu:post:v1:123456",
        },
      }),
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        verifiedAccountProbe: authenticatedAccount("zhihu"),
      }),
    );

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

  it.each([
    {
      name: "a public URL and identity key for different articles",
      platform: "zhihu" as const,
      requestedExternalAccountId: "zhihu-account",
      platformPostId: "123456",
      publicUrl: "https://zhuanlan.zhihu.com/p/123456",
      publicIdentityKey: "zhihu:post:v1:654321",
    },
    {
      name: "a non-canonical public URL even when its identity key is correct",
      platform: "sohu" as const,
      requestedExternalAccountId: "sohu-account",
      platformPostId: "1054312481",
      publicUrl: "https://m.sohu.com/a/1054312481_120219780/",
      publicIdentityKey: "sohu:post:v1:1054312481:120219780",
    },
  ])("fails closed before adapter inspection for $name", async (testCase) => {
    const { adapters, coordinator } = createHarness();
    const sessionId = await negotiate(coordinator);

    const response = await exchange(
      coordinator,
      commandRequest(sessionId, "publication.inspect", {
        requestId: `request-inspect-invalid-public-locator-${testCase.platform}`,
        operationId: `operation-inspect-invalid-public-locator-${testCase.platform}`,
        payload: {
          platform: testCase.platform,
          requestedExternalAccountId: testCase.requestedExternalAccountId,
          locator: {
            platformPostId: testCase.platformPostId,
            publicUrl: testCase.publicUrl,
            publicIdentityKey: testCase.publicIdentityKey,
          },
        },
      }),
    );

    expect(response).toMatchObject({
      command: "publication.inspect",
      ok: false,
      error: {
        code: "publication.stable-locator-required",
        stage: "PROTOCOL",
        retryPolicy: "DO_NOT_RETRY",
        requiredUserAction: "REVIEW_MANUALLY",
      },
    });
    expect(
      adapters[testCase.platform].inspectPublication,
    ).not.toHaveBeenCalled();
  });

  it("projects blocked public-access reason codes into the v3 namespace", async () => {
    const adapters = createAdapters();
    const canonicalUrl = "https://zhuanlan.zhihu.com/p/123456";
    const blockedPublicAccess = {
      status: "BLOCKED_BY_PLATFORM" as const,
      checkedUrl: canonicalUrl,
      checkedPublicIdentityKey: "zhihu:post:v1:123456",
      checkedAt: OBSERVED_AT,
      httpStatus: 403,
      reasonCode: "ZHIHU_ANONYMOUS_HTTP_403",
    };
    adapters.zhihu.inspectPublication = vi.fn().mockResolvedValue([
      {
        observationKey: "published:blocked:123456",
        platform: "zhihu",
        externalAccountId: "zhihu-account",
        outcome: "PUBLISHED",
        source: "AUTHENTICATED_PUBLIC_PAGE",
        platformPostId: "123456",
        canonicalUrl,
        title: "Verified Zhihu article",
        publishedAt: PUBLISHED_AT,
        bodyText: "Verified authenticated article body.",
        bodyTruncated: false,
        publicAccess: blockedPublicAccess,
        observedAt: OBSERVED_AT,
      },
    ]);
    adapters.zhihu.provePublishedObservation = vi.fn().mockReturnValue({
      observedAuthorExternalAccountId: "zhihu-account",
      publicAccess: blockedPublicAccess,
      bodyTruncated: false,
    });
    const { coordinator } = createHarness({ adapters });
    const sessionId = await negotiate(coordinator);

    const response = await exchange(
      coordinator,
      commandRequest(sessionId, "publication.inspect", {
        requestId: "request-inspect-zhihu-blocked-public-access",
        operationId: "operation-inspect-zhihu-blocked-public-access",
        payload: {
          platform: "zhihu",
          requestedExternalAccountId: "zhihu-account",
          locator: {
            platformPostId: "123456",
            publicUrl: canonicalUrl,
            publicIdentityKey: "zhihu:post:v1:123456",
          },
        },
      }),
    );

    expect(response).toMatchObject({
      command: "publication.inspect",
      ok: true,
      result: {
        observations: [
          {
            kind: "PUBLISHED",
            source: "AUTHENTICATED_PAGE",
            publicAccess: {
              status: "BLOCKED_BY_PLATFORM",
              reasonCode: "adapter.zhihu-anonymous-http-403",
              httpStatus: 403,
            },
          },
        ],
      },
    });
  });

  it("allows the discovery adapter its full child budget after a slow account probe", async () => {
    vi.useFakeTimers();
    try {
      const adapters = createAdapters();
      adapters.zhihu.probeAccounts = vi.fn(
        () =>
          new Promise<AdapterAccountProbe>((resolve) => {
            setTimeout(() => resolve(authenticatedAccount("zhihu")), 7_900);
          }),
      );
      adapters.zhihu.inspectPublication = vi.fn(
        () =>
          new Promise((resolve) => {
            setTimeout(
              () =>
                resolve([
                  {
                    observationKey: "published:123456",
                    platform: "zhihu",
                    externalAccountId: "zhihu-account",
                    outcome: "PUBLISHED",
                    source: "PUBLIC_PAGE",
                    platformPostId: "123456",
                    canonicalUrl: "https://zhuanlan.zhihu.com/p/123456",
                    title: "Verified Zhihu article",
                    publishedAt: PUBLISHED_AT,
                    bodyText: "Verified public article body.",
                    bodyTruncated: false,
                    publicAccess: {
                      status: "CONFIRMED",
                      checkedUrl: "https://zhuanlan.zhihu.com/p/123456",
                      checkedPublicIdentityKey: "zhihu:post:v1:123456",
                      checkedAt: OBSERVED_AT,
                      httpStatus: 200,
                    },
                    observedAt: OBSERVED_AT,
                  },
                ]),
              21_900,
            );
          }),
      );
      const { coordinator } = createHarness({ adapters });
      const sessionId = await negotiate(coordinator);
      const pending = exchange(
        coordinator,
        commandRequest(sessionId, "publication.inspect", {
          requestId: "request-inspect-discovery-budget",
          operationId: "operation-inspect-discovery-budget",
          payload: {
            platform: "zhihu",
            requestedExternalAccountId: "zhihu-account",
            locator: { platformPostId: "123456" },
          },
        }),
      );

      await vi.advanceTimersByTimeAsync(29_799);
      let settled = false;
      void pending.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toMatchObject({
        ok: true,
        result: { observations: [{ kind: "PUBLISHED" }] },
      });
      expect(adapters.zhihu.probeAccounts).toHaveBeenCalledTimes(1);
      expect(adapters.zhihu.inspectPublication).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns the account-probe timeout metadata at the eight-second boundary", async () => {
    vi.useFakeTimers();
    try {
      const adapters = createAdapters();
      let probeSignal: AbortSignal | undefined;
      adapters.zhihu.probeAccounts = vi.fn(
        (context) =>
          new Promise((_resolve, reject) => {
            probeSignal = context?.signal;
            context?.signal?.addEventListener(
              "abort",
              () => reject(context.signal?.reason),
              { once: true },
            );
          }),
      );
      const { coordinator } = createHarness({ adapters });
      const sessionId = await negotiate(coordinator);
      const pending = exchange(
        coordinator,
        commandRequest(sessionId, "publication.inspect", {
          requestId: "request-inspect-account-timeout",
          operationId: "operation-inspect-account-timeout",
          payload: {
            platform: "zhihu",
            requestedExternalAccountId: "zhihu-account",
            locator: { platformPostId: "123456" },
          },
        }),
      );

      await vi.advanceTimersByTimeAsync(8_000);
      await expect(pending).resolves.toMatchObject({
        ok: false,
        error: {
          code: "adapter.account-probe-timeout",
          stage: "TIMEOUT",
          retryPolicy: "SAFE_TO_RETRY",
          requiredUserAction: "RETRY",
        },
      });
      expect(probeSignal?.aborted).toBe(true);
      expect(adapters.zhihu.inspectPublication).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    {
      name: "known-public",
      timeoutMs: 18_000,
      locator: {
        platformPostId: "123456",
        publicUrl: "https://zhuanlan.zhihu.com/p/123456",
        publicIdentityKey: "zhihu:post:v1:123456",
      },
    },
    {
      name: "discovery",
      timeoutMs: 22_000,
      locator: { platformPostId: "123456" },
    },
  ])(
    "returns typed adapter timeout metadata for $name inspection",
    async ({ name, timeoutMs, locator }) => {
      vi.useFakeTimers();
      try {
        const adapters = createAdapters();
        let inspectionSignal: AbortSignal | undefined;
        adapters.zhihu.inspectPublication = vi.fn(
          (_request, context) =>
            new Promise((_resolve, reject) => {
              inspectionSignal = context?.signal;
              context?.signal?.addEventListener(
                "abort",
                () => reject(context.signal?.reason),
                { once: true },
              );
            }),
        );
        const { coordinator } = createHarness({ adapters });
        const sessionId = await negotiate(coordinator);
        const pending = exchange(
          coordinator,
          commandRequest(sessionId, "publication.inspect", {
            requestId: `request-inspect-${name}-timeout`,
            operationId: `operation-inspect-${name}-timeout`,
            payload: {
              platform: "zhihu",
              requestedExternalAccountId: "zhihu-account",
              locator,
            },
          }),
        );

        await vi.advanceTimersByTimeAsync(timeoutMs);
        await expect(pending).resolves.toMatchObject({
          ok: false,
          error: {
            code: "adapter.publication-inspection-timeout",
            stage: "TIMEOUT",
            retryPolicy: "SAFE_TO_RETRY",
            requiredUserAction: "RETRY",
          },
        });
        expect(inspectionSignal?.aborted).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("returns command-phase timeout metadata when coordinator work exceeds the safety envelope", async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness();
      const sessionId = await negotiate(harness.coordinator);
      let inspectionLookupCount = 0;
      harness.dependencies.getAdapter = vi.fn(async (platform) => {
        if (platform !== "zhihu") {
          return harness.adapters[platform as PlatformId] ?? null;
        }
        inspectionLookupCount += 1;
        // The command first refreshes the runtime snapshot, then probes the
        // account. Stall only the subsequent adapter lookup before execution.
        if (inspectionLookupCount <= 2) return harness.adapters.zhihu;
        return new Promise<PlatformAdapter | null>(() => {});
      });
      const pending = exchange(
        harness.coordinator,
        commandRequest(sessionId, "publication.inspect", {
          requestId: "request-inspect-command-timeout",
          operationId: "operation-inspect-command-timeout",
          payload: {
            platform: "zhihu",
            requestedExternalAccountId: "zhihu-account",
            locator: { platformPostId: "123456" },
          },
        }),
      );

      await vi.advanceTimersByTimeAsync(32_000);
      await expect(pending).resolves.toMatchObject({
        ok: false,
        error: {
          code: "publication.inspection-timeout",
          stage: "TIMEOUT",
          retryPolicy: "SAFE_TO_RETRY",
          requiredUserAction: "RETRY",
        },
      });
      expect(inspectionLookupCount).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves a parent command timeout phase through a child deadline", async () => {
    const parent = new AbortController();
    const pending = withPublicationInspectionDeadline(
      (signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
      {
        timeoutMs: 22_000,
        phase: "ADAPTER_INSPECTION",
        parentSignal: parent.signal,
      },
    );
    const commandTimeout = new PublicationInspectionTimeoutError("COMMAND");

    parent.abort(commandTimeout);

    await expect(pending).rejects.toBe(commandTimeout);
    expect(commandTimeout).toMatchObject({
      code: "PUBLICATION_INSPECTION_TIMEOUT",
      phase: "COMMAND",
    });
  });

  it("does not start work after an inherited deadline has already expired", async () => {
    const operation = vi.fn(async () => "unreachable");

    await expect(
      withPublicationInspectionDeadline(operation, {
        timeoutMs: 22_000,
        phase: "ADAPTER_INSPECTION",
        deadlineAt: Date.now() - 1,
      }),
    ).rejects.toMatchObject({
      code: "PUBLICATION_INSPECTION_TIMEOUT",
      phase: "ADAPTER_INSPECTION",
    });
    expect(operation).not.toHaveBeenCalled();
  });

  it.each([
    ["zhihu" as const, "2067551877672219379"],
    ["sohu" as const, "1058083143"],
    ["weixin" as const, "9001001"],
    ["toutiao" as const, "7669620929504346651"],
  ])(
    "opens a %s draft without exposing an editor URL",
    async (platform, draftReference) => {
      const { adapters, coordinator } = createHarness();
      const sessionId = await negotiate(coordinator);
      const openRequest = commandRequest(sessionId, "publication.openDraft", {
        requestId: `request-open-${platform}`,
        operationId: `operation-open-${platform}`,
        payload: {
          platform,
          requestedExternalAccountId: `${platform}-account`,
          draftReference,
        },
      });

      const opened = await exchange(coordinator, openRequest);
      expect(opened).toMatchObject({
        command: "publication.openDraft",
        ok: true,
        result: {
          platform,
          observedExternalAccountId: `${platform}-account`,
          draftReference,
          opened: true,
        },
      });
      expect(adapters[platform].openPublicationDraft).toHaveBeenCalledWith(
        expect.objectContaining({
          platform,
          externalAccountId: `${platform}-account`,
          platformPostId: draftReference,
        }),
        expect.objectContaining({
          signal: expect.any(AbortSignal),
          verifiedAccountProbe: expect.objectContaining({
            status: "AUTHENTICATED",
          }),
        }),
      );
      expect(JSON.stringify(opened)).not.toContain("token=");
    },
  );

  it("fails closed when the live adapter does not expose draft opening", async () => {
    const adapters = createAdapters();
    delete adapters.sohu.openPublicationDraft;
    const { coordinator } = createHarness({ adapters });
    const sessionId = await negotiate(coordinator);

    const response = await exchange(
      coordinator,
      commandRequest(sessionId, "publication.openDraft", {
        requestId: "request-open-sohu-unavailable",
        operationId: "operation-open-sohu-unavailable",
        payload: {
          platform: "sohu",
          requestedExternalAccountId: "sohu-account",
          draftReference: "1058083143",
        },
      }),
    );

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: "adapter.draft-open-unavailable",
        stage: "CAPABILITY",
      },
    });
  });
});
