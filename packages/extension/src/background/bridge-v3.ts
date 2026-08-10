import type {
  AdapterAccountProbe,
  AdapterOperationContext,
  Article,
  PlatformAdapter,
  SyncResult,
} from "@wechatsync/core";
import {
  PublicationInspectionRequestSchema,
  PublicationPublishedProofSchema,
  derivePublicationPublicIdentity,
  parsePublicationUrl,
  type PublicationInspectionObservation,
  type PublicationInspectionPublicAccess,
  type PublicationInspectionRequest,
} from "@wechatsync/core/publication-inspection";
import {
  PUBLICATION_BRIDGE_NAMESPACE,
  PUBLICATION_BRIDGE_PROTOCOL_MAJOR,
  SUPPORTED_PUBLICATION_BRIDGE_CONTRACT_VERSIONS,
  DraftReferenceSchema,
  ExternalAccountIdSchema,
  PlatformPostIdSchema,
  PublicationBridgeV3CommandExchangeSchema,
  PublicationBridgeV3CommandRequestSchema,
  PublicationBridgeV3NegotiationExchangeSchema,
  PublicationBridgeV3PublishDraftPayloadSchema,
  PublicationBridgeV3PublishOperationSnapshotSchema,
  PublicationBridgeV3PublicAccessSchema,
  PublicationBridgeV3RequestSchema,
  PublicationBridgeV3ResponseSchema,
  PublicationBridgeV3RuntimeSnapshotSchema,
  SupportedBridgeV3ContractVersionSchema,
  canonicalizePublicationBridgeV3PublishPayload,
  getPublicationBridgeV3CommandPolicy,
  publicationBridgeV3RuntimeSnapshotsEqual,
  selectPublicationBridgeContractVersion,
  type PublicationBridgeV3AccountProbe,
  type PublicationBridgeV3CancellationReason,
  type PublicationBridgeV3CancelDisposition,
  type PublicationBridgeV3CommandRequest,
  type PublicationBridgeV3Error,
  type PublicationBridgeV3EvidenceSource,
  type PublicationBridgeV3InspectLocator,
  type PublicationBridgeV3MatchedLocator,
  type PublicationBridgeV3Observation,
  type PublicationBridgeV3PublishDraftPayload,
  type PublicationBridgeV3PublishOperationSnapshot,
  type PublicationBridgeV3PublishTargetSnapshot,
  type PublicationBridgeV3PublicAccess,
  type PublicationBridgeV3Request,
  type PublicationBridgeV3Response,
  type PublicationBridgeV3RuntimeSnapshot,
  type PublicationBridgeV3NegotiationResult,
} from "@byfire-dev/publication-bridge-contract/v3";

import {
  PUBLICATION_BRIDGE_V3_PLATFORM_IDS,
  buildPublicationBridgeRuntimeSnapshotV3,
  derivePublicationAdapterSnapshotV3,
  type PublicationBridgeV3PlatformId,
} from "../bridge/publication-capabilities-v3";
import { runOpenPublicationDraft } from "./bridge-v2";
import {
  isPublicationInspectionTimeoutError,
  runInternalPublicationInspection,
  withPublicationInspectionDeadline,
} from "./publication-inspection-runner";

const STORAGE_KEY = "publicationBridgeV3State";
const MAX_SESSIONS = 32;
const ACCOUNT_PROBE_TIMEOUT_MS = 8_000;
const KNOWN_PUBLIC_INSPECTION_TIMEOUT_MS = 18_000;
const DISCOVERY_INSPECTION_TIMEOUT_MS = 22_000;
const INSPECTION_COMMAND_RESERVE_MS = 2_000;
const INSPECTION_COMMAND_TIMEOUT_MS =
  ACCOUNT_PROBE_TIMEOUT_MS +
  DISCOVERY_INSPECTION_TIMEOUT_MS +
  INSPECTION_COMMAND_RESERVE_MS;
const INSPECTION_TOMBSTONE_TTL_MS = 2 * 60_000;

interface StoredSession {
  createdAt: string;
  contractVersion: PublicationBridgeV3NegotiationResult["selectedContractVersion"];
  runtime: PublicationBridgeV3RuntimeSnapshot;
}

interface StoredPublishTask {
  payload: PublicationBridgeV3PublishDraftPayload;
}

interface StoredBridgeState {
  sessions: Record<string, StoredSession>;
  operations: Record<string, PublicationBridgeV3PublishOperationSnapshot>;
  tasks: Record<string, StoredPublishTask>;
}

export interface PublicationBridgeV3StateStore {
  load(): Promise<unknown>;
  save(value: unknown): Promise<void>;
}

export interface PublicationBridgeV3CoordinatorDependencies {
  extensionVersion(): string;
  getAdapter(platform: string): Promise<PlatformAdapter | null>;
  syncToPlatform(
    platform: string,
    article: Article,
    options: {
      draftOnly: boolean;
      accountBinding: { externalAccountId: string };
      beforeDispatch: () => void | Promise<void>;
    },
  ): Promise<SyncResult>;
  store: PublicationBridgeV3StateStore;
  now?: () => Date;
  createId?: (prefix: string) => string;
  sha256?: (value: string) => Promise<string>;
}

export interface PublicationBridgeV3Caller {
  tabId: number;
  documentId: string;
}

export interface PublicationBridgeV3HandleContext {
  caller: PublicationBridgeV3Caller;
  signal?: AbortSignal;
}

interface ActiveInspection {
  controller: AbortController;
}

interface InspectionTombstone {
  state: "CANCELLED" | "TERMINAL";
  expiresAt: number;
}

class PublicationInspectionCancelledError extends Error {
  constructor(readonly cancellationReason: PublicationBridgeV3CancellationReason) {
    super(`Publication inspection cancelled: ${cancellationReason}`);
    this.name = "PublicationInspectionCancelledError";
  }
}

function emptyState(): StoredBridgeState {
  return { sessions: {}, operations: {}, tasks: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStoredState(value: unknown): StoredBridgeState {
  if (!isRecord(value)) return emptyState();
  const state = emptyState();

  if (isRecord(value.sessions)) {
    for (const [sessionId, candidate] of Object.entries(value.sessions)) {
      if (!isRecord(candidate) || typeof candidate.createdAt !== "string")
        continue;
      const runtime = PublicationBridgeV3RuntimeSnapshotSchema.safeParse(
        candidate.runtime,
      );
      // Sessions created by 2.0.32 and earlier did not persist the negotiated
      // version; they can only have spoken the legacy 3.0 wire contract.
      const contractVersion = SupportedBridgeV3ContractVersionSchema.safeParse(
        candidate.contractVersion ?? "3.0",
      );
      if (
        runtime.success &&
        contractVersion.success &&
        Number.isFinite(Date.parse(candidate.createdAt))
      ) {
        state.sessions[sessionId] = {
          createdAt: candidate.createdAt,
          contractVersion: contractVersion.data,
          runtime: runtime.data,
        };
      }
    }
  }

  if (isRecord(value.operations)) {
    for (const [operationId, candidate] of Object.entries(value.operations)) {
      const operation =
        PublicationBridgeV3PublishOperationSnapshotSchema.safeParse(candidate);
      if (operation.success && operation.data.operationId === operationId) {
        state.operations[operationId] = operation.data;
      }
    }
  }

  if (isRecord(value.tasks)) {
    for (const [operationId, candidate] of Object.entries(value.tasks)) {
      if (!isRecord(candidate) || !state.operations[operationId]) continue;
      const payload = PublicationBridgeV3PublishDraftPayloadSchema.safeParse(
        candidate.payload,
      );
      if (payload.success) {
        state.tasks[operationId] = { payload: payload.data };
      }
    }
  }

  return state;
}

export function createChromePublicationBridgeV3StateStore(
  storage: chrome.storage.StorageArea,
): PublicationBridgeV3StateStore {
  return {
    async load() {
      const stored = await storage.get(STORAGE_KEY);
      return stored[STORAGE_KEY];
    },
    async save(value) {
      await storage.set({ [STORAGE_KEY]: value });
    },
  };
}

function genericId(prefix: string): string {
  const random = globalThis.crypto?.randomUUID?.();
  return `${prefix}-${random ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}

async function defaultSha256(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return `sha256:${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

function bridgeError(
  code: string,
  stage: PublicationBridgeV3Error["stage"],
  message: string,
  retryPolicy: PublicationBridgeV3Error["retryPolicy"],
  requiredUserAction?: PublicationBridgeV3Error["requiredUserAction"],
  existingOperationId?: string,
): PublicationBridgeV3Error {
  return {
    code,
    stage,
    message,
    retryPolicy,
    ...(requiredUserAction ? { requiredUserAction } : {}),
    ...(existingOperationId ? { existingOperationId } : {}),
  };
}

function adapterCode(value: string | undefined, fallback: string): string {
  const suffix = (value ?? fallback)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
  return `adapter.${suffix || fallback}`;
}

function safeMessage(value: string | undefined, fallback: string): string {
  const normalized = value
    ?.replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return (normalized || fallback).slice(0, 500);
}

/**
 * Project the internal inspection-domain access evidence into the versioned
 * Bridge v3 wire contract. Internal adapters intentionally use stable
 * UPPER_SNAKE_CASE reason codes, while v3 requires namespaced lower-case
 * codes. Keep that translation at this contract boundary so v2 and future
 * adapters can retain their internal vocabulary without leaking it onto the
 * v3 wire.
 */
function projectPublicAccessV3(
  value: PublicationInspectionPublicAccess,
): PublicationBridgeV3PublicAccess | null {
  const projected = PublicationBridgeV3PublicAccessSchema.safeParse(
    value.status === "CONFIRMED"
      ? value
      : {
          ...value,
          reasonCode: adapterCode(value.reasonCode, "public-access-blocked"),
        },
  );
  return projected.success ? projected.data : null;
}

function toArticle(payload: PublicationBridgeV3PublishDraftPayload): Article {
  const { draft } = payload;
  const isHtml = draft.contentFormat === "HTML";
  return {
    title: draft.title,
    markdown: isHtml ? "" : draft.body,
    ...(isHtml ? { html: draft.body } : {}),
    ...(draft.summary ? { summary: draft.summary } : {}),
    ...(draft.coverUrls?.[0] ? { cover: draft.coverUrls[0] } : {}),
  };
}

function stableSuccessfulLocator(
  platform: string,
  result: SyncResult,
): { draftReference: string } | { platformPostId: string } | null {
  const schema =
    platform === "weixin" ? DraftReferenceSchema : PlatformPostIdSchema;
  const parsed = schema.safeParse((result as { postId?: unknown }).postId);
  if (!parsed.success) return null;
  return platform === "weixin"
    ? { draftReference: parsed.data }
    : { platformPostId: parsed.data };
}

function terminalFailure(
  target: Extract<
    PublicationBridgeV3PublishTargetSnapshot,
    { outcome: "PENDING" }
  >,
  error: PublicationBridgeV3Error,
): PublicationBridgeV3PublishTargetSnapshot {
  return {
    targetId: target.targetId,
    platform: target.platform,
    requestedExternalAccountId: target.requestedExternalAccountId,
    outcome: "FAILED",
    writeState: "NOT_DISPATCHED",
    error,
  };
}

function terminalOutcomeUnknown(
  target: Extract<
    PublicationBridgeV3PublishTargetSnapshot,
    { outcome: "PENDING" }
  >,
  message: string,
): PublicationBridgeV3PublishTargetSnapshot {
  return {
    targetId: target.targetId,
    platform: target.platform,
    requestedExternalAccountId: target.requestedExternalAccountId,
    outcome: "OUTCOME_UNKNOWN",
    writeState: "DISPATCHED",
    error: bridgeError(
      "publication.outcome-unknown",
      "ADAPTER",
      message,
      "DO_NOT_RETRY",
      "REVIEW_MANUALLY",
    ),
  };
}

function interruptedAfterDispatch(
  target: Extract<
    PublicationBridgeV3PublishTargetSnapshot,
    { outcome: "PENDING" }
  >,
): PublicationBridgeV3PublishTargetSnapshot {
  return {
    targetId: target.targetId,
    platform: target.platform,
    requestedExternalAccountId: target.requestedExternalAccountId,
    outcome: "OUTCOME_UNKNOWN",
    writeState: "DISPATCHED",
    error: bridgeError(
      "publication.outcome-unknown",
      "UNKNOWN",
      "The extension restarted after dispatch; verify the platform before any retry.",
      "DO_NOT_RETRY",
      "REVIEW_MANUALLY",
    ),
  };
}

export class PublicationBridgeV3Coordinator {
  private state: StoredBridgeState | null = null;
  private mutationQueue: Promise<void> = Promise.resolve();
  private readonly activeOperations = new Set<string>();
  private readonly activeInspections = new Map<string, ActiveInspection>();
  private readonly inspectionTombstones = new Map<
    string,
    InspectionTombstone
  >();

  constructor(
    private readonly dependencies: PublicationBridgeV3CoordinatorDependencies,
  ) {}

  private now(): Date {
    return this.dependencies.now?.() ?? new Date();
  }

  private createId(prefix: string): string {
    return this.dependencies.createId?.(prefix) ?? genericId(prefix);
  }

  private inspectionKey(
    caller: PublicationBridgeV3Caller,
    sessionId: string,
    operationId: string,
    requestId: string,
  ): string {
    return JSON.stringify([
      caller.tabId,
      caller.documentId,
      sessionId,
      operationId,
      requestId,
    ]);
  }

  private caller(context?: PublicationBridgeV3HandleContext): PublicationBridgeV3Caller {
    return context?.caller ?? { tabId: -1, documentId: "direct-coordinator-call" };
  }

  private pruneInspectionTombstones(now = Date.now()): void {
    for (const [key, tombstone] of this.inspectionTombstones) {
      if (tombstone.expiresAt <= now) this.inspectionTombstones.delete(key);
    }
  }

  private writeInspectionTombstone(
    key: string,
    state: InspectionTombstone["state"],
  ): void {
    this.inspectionTombstones.set(key, {
      state,
      expiresAt: Date.now() + INSPECTION_TOMBSTONE_TTL_MS,
    });
  }

  private runtimeWithoutIo(
    sessionId: string,
    contractVersion: StoredSession["contractVersion"],
  ): PublicationBridgeV3RuntimeSnapshot {
    const session = this.state?.sessions[sessionId];
    return (
      (session?.contractVersion === contractVersion
        ? session.runtime
        : undefined) ??
      buildPublicationBridgeRuntimeSnapshotV3(
        this.dependencies.extensionVersion(),
        [],
        contractVersion,
      )
    );
  }

  private contractVersionForRuntime(
    runtime: PublicationBridgeV3RuntimeSnapshot,
  ): StoredSession["contractVersion"] {
    // 3.0 and 3.1 share the same producer capability set. Cancellation is
    // the first runtime capability gated specifically to wire 3.2.
    return runtime.bridgeCapabilities.includes("bridge.request.cancel")
      ? "3.2"
      : "3.1";
  }

  private async exclusive<T>(operation: () => Promise<T> | T): Promise<T> {
    const previous = this.mutationQueue;
    let release!: () => void;
    this.mutationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async ensureState(): Promise<StoredBridgeState> {
    if (this.state) return this.state;
    const state = parseStoredState(await this.dependencies.store.load());
    let recovered = false;
    const completedAt = this.now().toISOString();

    for (const [operationId, operation] of Object.entries(state.operations)) {
      if (operation.state === "RUNNING") {
        state.operations[operationId] =
          PublicationBridgeV3PublishOperationSnapshotSchema.parse({
            ...operation,
            state: "COMPLETED",
            targets: operation.targets.map((target) =>
              target.outcome !== "PENDING"
                ? target
                : target.writeState === "DISPATCHED"
                  ? interruptedAfterDispatch(target)
                  : terminalFailure(
                      target,
                      bridgeError(
                        "publication.worker-interrupted-before-dispatch",
                        "TRANSPORT",
                        "The extension restarted before this target was dispatched.",
                        "SAFE_TO_RETRY",
                        "RETRY",
                      ),
                    ),
            ),
            updatedAt: completedAt,
            completedAt,
          });
        delete state.tasks[operationId];
        recovered = true;
      } else if (operation.state === "ACCEPTED" && !state.tasks[operationId]) {
        state.operations[operationId] =
          PublicationBridgeV3PublishOperationSnapshotSchema.parse({
            ...operation,
            state: "COMPLETED",
            targets: operation.targets.map((target) =>
              target.outcome === "PENDING"
                ? terminalFailure(
                    target,
                    bridgeError(
                      "publication.operation-payload-missing",
                      "TRANSPORT",
                      "The accepted operation cannot be resumed because its payload is missing.",
                      "REVIEW_BEFORE_RETRY",
                      "REVIEW_MANUALLY",
                    ),
                  )
                : target,
            ),
            updatedAt: completedAt,
            completedAt,
          });
        recovered = true;
      }
    }

    this.state = state;
    if (recovered) await this.persist();
    return state;
  }

  private prune(state: StoredBridgeState): void {
    const sessionIds = Object.entries(state.sessions)
      .sort(
        (left, right) =>
          Date.parse(right[1].createdAt) - Date.parse(left[1].createdAt),
      )
      .map(([sessionId]) => sessionId);
    for (const sessionId of sessionIds.slice(MAX_SESSIONS)) {
      delete state.sessions[sessionId];
    }

    // Completed operations are the durable idempotency ledger required by the
    // public contract. The extension has unlimitedStorage permission, so they
    // must not be evicted by a count-based cache policy and made publishable
    // again under the same idempotency key.
  }

  private async persist(): Promise<void> {
    if (!this.state) return;
    this.prune(this.state);
    await this.dependencies.store.save(this.state);
  }

  private async runtime(
    contractVersion: StoredSession["contractVersion"],
    signal?: AbortSignal,
  ): Promise<PublicationBridgeV3RuntimeSnapshot> {
    const adapters = [];
    for (const platform of PUBLICATION_BRIDGE_V3_PLATFORM_IDS) {
      signal?.throwIfAborted();
      const adapter = await this.dependencies.getAdapter(platform);
      signal?.throwIfAborted();
      const snapshot = derivePublicationAdapterSnapshotV3(platform, adapter);
      if (snapshot) adapters.push(snapshot);
    }
    return buildPublicationBridgeRuntimeSnapshotV3(
      this.dependencies.extensionVersion(),
      adapters,
      contractVersion,
    );
  }

  private finalize(
    request: PublicationBridgeV3Request,
    response: unknown,
  ): PublicationBridgeV3Response {
    const parsed = PublicationBridgeV3ResponseSchema.parse(response);
    if (request.command === "bridge.negotiate") {
      PublicationBridgeV3NegotiationExchangeSchema.parse({
        request,
        response: parsed,
      });
    } else {
      PublicationBridgeV3CommandExchangeSchema.parse({
        request,
        response: parsed,
      });
    }
    return parsed;
  }

  private commandFailure(
    request: PublicationBridgeV3CommandRequest,
    runtime: PublicationBridgeV3RuntimeSnapshot,
    error: PublicationBridgeV3Error,
  ): PublicationBridgeV3Response {
    return this.finalize(request, {
      namespace: PUBLICATION_BRIDGE_NAMESPACE,
      direction: "RESPONSE",
      protocolMajor: PUBLICATION_BRIDGE_PROTOCOL_MAJOR,
      contractVersion: request.contractVersion,
      sessionId: request.sessionId,
      requestId: request.requestId,
      ...(request.command === "accounts.resolve"
        ? {}
        : { operationId: request.operationId }),
      command: request.command,
      ok: false,
      ...(request.command === "publication.publishDraft"
        ? { dispatchState: "NOT_DISPATCHED" }
        : {}),
      runtime,
      error,
    });
  }

  private async validateSession(
    request: PublicationBridgeV3CommandRequest,
    signal?: AbortSignal,
  ): Promise<
    | { ok: true; runtime: PublicationBridgeV3RuntimeSnapshot }
    | { ok: false; response: PublicationBridgeV3Response }
  > {
    signal?.throwIfAborted();
    const currentRuntime = await this.runtime(request.contractVersion, signal);
    signal?.throwIfAborted();
    const state = await this.exclusive(() => this.ensureState());
    signal?.throwIfAborted();
    const session = state.sessions[request.sessionId];
    if (!session || request.contractVersion !== session.contractVersion) {
      return {
        ok: false,
        response: this.commandFailure(
          request,
          currentRuntime,
          bridgeError(
            "bridge.session-invalid",
            "NEGOTIATION",
            "The Bridge session is missing or no longer valid; negotiate again.",
            "SAFE_TO_RETRY",
            "RETRY",
          ),
        ),
      };
    }
    if (
      !publicationBridgeV3RuntimeSnapshotsEqual(session.runtime, currentRuntime)
    ) {
      return {
        ok: false,
        response: this.commandFailure(
          request,
          currentRuntime,
          bridgeError(
            "bridge.runtime-changed",
            "CAPABILITY",
            "The extension capability snapshot changed; negotiate a new session.",
            "SAFE_TO_RETRY",
            "RETRY",
          ),
        ),
      };
    }
    const policy = getPublicationBridgeV3CommandPolicy(request.command);
    if (
      policy.requiredBridgeCapability &&
      !currentRuntime.bridgeCapabilities.includes(
        policy.requiredBridgeCapability,
      )
    ) {
      return {
        ok: false,
        response: this.commandFailure(
          request,
          currentRuntime,
          bridgeError(
            "bridge.capability-unavailable",
            "CAPABILITY",
            "The negotiated Bridge does not implement this command.",
            "DO_NOT_RETRY",
            "INSTALL_OR_UPGRADE_EXTENSION",
          ),
        ),
      };
    }
    return { ok: true, runtime: currentRuntime };
  }

  async handle(
    untrustedRequest: unknown,
    context?: PublicationBridgeV3HandleContext,
  ): Promise<PublicationBridgeV3Response> {
    const request = PublicationBridgeV3RequestSchema.parse(untrustedRequest);
    if (request.command === "bridge.negotiate") return this.negotiate(request);
    if (request.command === "bridge.cancel") {
      return this.cancelInspection(request, context);
    }
    if (request.command === "publication.inspect") {
      return this.handleInspection(request, context);
    }

    const session = await this.validateSession(request, context?.signal);
    if (!session.ok) return session.response;

    switch (request.command) {
      case "accounts.resolve":
        return this.resolveAccounts(request, session.runtime);
      case "publication.publishDraft":
        return this.acceptPublication(request, session.runtime);
      case "publication.getOperation":
        return this.getOperation(request, session.runtime);
      case "publication.openDraft":
        return this.openDraft(request, session.runtime);
    }
  }

  private async cancelInspection(
    request: Extract<
      PublicationBridgeV3CommandRequest,
      { command: "bridge.cancel" }
    >,
    context?: PublicationBridgeV3HandleContext,
  ): Promise<PublicationBridgeV3Response> {
    // A cancellation request is allowed to mutate inspection state only after
    // it has proven that it belongs to the exact negotiated session and wire.
    // In particular, a syntactically valid 3.2 cancel must not be able to use
    // a 3.1/3.0 session id to abort an older-wire inspection.
    const session = await this.validateSession(request, context?.signal);
    if (!session.ok) return session.response;

    this.pruneInspectionTombstones();
    const key = this.inspectionKey(
      this.caller(context),
      request.sessionId,
      request.operationId,
      request.payload.targetRequestId,
    );
    const active = this.activeInspections.get(key);
    const prior = this.inspectionTombstones.get(key);
    let disposition: PublicationBridgeV3CancelDisposition;

    if (active && !active.controller.signal.aborted) {
      active.controller.abort(
        new PublicationInspectionCancelledError(request.payload.reason),
      );
      this.writeInspectionTombstone(key, "CANCELLED");
      disposition = "CANCELLED";
    } else if (prior?.state === "CANCELLED" || active?.controller.signal.aborted) {
      disposition = "ALREADY_CANCELLED";
    } else if (prior?.state === "TERMINAL") {
      disposition = "ALREADY_TERMINAL";
    } else {
      // A cancel message can overtake the original request between the page
      // and the service worker. Keep a short tombstone so the later inspect
      // request is rejected before any platform I/O starts.
      this.writeInspectionTombstone(key, "CANCELLED");
      disposition = "CANCELLED";
    }

    return this.finalize(request, {
      namespace: PUBLICATION_BRIDGE_NAMESPACE,
      direction: "RESPONSE",
      protocolMajor: PUBLICATION_BRIDGE_PROTOCOL_MAJOR,
      contractVersion: request.contractVersion,
      sessionId: request.sessionId,
      requestId: request.requestId,
      operationId: request.operationId,
      command: request.command,
      ok: true,
      result: {
        runtime: session.runtime,
        targetRequestId: request.payload.targetRequestId,
        targetCommand: request.payload.targetCommand,
        reason: request.payload.reason,
        disposition,
      },
    });
  }

  private async negotiate(
    request: Extract<
      PublicationBridgeV3Request,
      { command: "bridge.negotiate" }
    >,
  ): Promise<PublicationBridgeV3Response> {
    const selected = SupportedBridgeV3ContractVersionSchema.safeParse(
      selectPublicationBridgeContractVersion(
        request.supportedContractVersions,
        SUPPORTED_PUBLICATION_BRIDGE_CONTRACT_VERSIONS,
      ),
    );
    if (!selected.success) {
      return this.finalize(request, {
        namespace: PUBLICATION_BRIDGE_NAMESPACE,
        direction: "RESPONSE",
        protocolMajor: PUBLICATION_BRIDGE_PROTOCOL_MAJOR,
        command: "bridge.negotiate",
        requestId: request.requestId,
        ok: false,
        error: bridgeError(
          "bridge.contract-version-unsupported",
          "NEGOTIATION",
          "No exact Bridge v3 contract version is shared by both peers.",
          "DO_NOT_RETRY",
          "INSTALL_OR_UPGRADE_EXTENSION",
        ),
      });
    }

    const runtime = await this.runtime(selected.data);
    const sessionId = this.createId("session");
    await this.exclusive(async () => {
      const state = await this.ensureState();
      state.sessions[sessionId] = {
        createdAt: this.now().toISOString(),
        contractVersion: selected.data,
        runtime,
      };
      await this.persist();
    });

    return this.finalize(request, {
      namespace: PUBLICATION_BRIDGE_NAMESPACE,
      direction: "RESPONSE",
      protocolMajor: PUBLICATION_BRIDGE_PROTOCOL_MAJOR,
      command: "bridge.negotiate",
      requestId: request.requestId,
      ok: true,
      result: { selectedContractVersion: selected.data, sessionId, runtime },
    });
  }

  private async probeAccount(
    platform: string,
    expectedExternalAccountId?: string,
    context?: AdapterOperationContext,
    onVerifiedProbe?: (probe: AdapterAccountProbe) => void,
  ): Promise<PublicationBridgeV3AccountProbe> {
    try {
      const resolution = await withPublicationInspectionDeadline(
        async (signal, deadlineAt) => {
          const adapter = await this.dependencies.getAdapter(platform);
          if (!adapter?.probeAccounts) {
            return { kind: "UNAVAILABLE" as const };
          }
          const probe = await adapter.probeAccounts({
            ...context,
            signal,
            deadlineAt,
          });
          return { kind: "PROBE" as const, probe };
        },
        {
          timeoutMs: ACCOUNT_PROBE_TIMEOUT_MS,
          phase: "ACCOUNT_PROBE",
          parentSignal: context?.signal,
          deadlineAt: context?.deadlineAt,
        },
      );
      if (resolution.kind === "UNAVAILABLE") {
        return {
          platform,
          status: "UNAVAILABLE",
          reasonCode: "adapter.account-identity-unavailable",
          requiredUserAction: "OPEN_PLATFORM",
        };
      }
      const probe = resolution.probe;
      if (probe.status === "NOT_AUTHENTICATED") {
        return {
          platform,
          status: "LOGIN_REQUIRED",
          requiredUserAction: "LOGIN",
        };
      }
      if (probe.status !== "AUTHENTICATED" || probe.accounts.length === 0) {
        return {
          platform,
          status: "UNAVAILABLE",
          reasonCode: adapterCode(
            probe.status === "PROBE_FAILED" ? probe.errorCode : undefined,
            "account-probe-failed",
          ),
          requiredUserAction: "REVIEW_MANUALLY",
        };
      }
      onVerifiedProbe?.(probe);
      const selected = expectedExternalAccountId
        ? probe.accounts.find(
            (account) =>
              account.externalAccountId === expectedExternalAccountId,
          )
        : probe.accounts.length === 1
          ? probe.accounts[0]
          : undefined;
      if (!selected) {
        if (expectedExternalAccountId) {
          return {
            platform,
            status: "ACCOUNT_MISMATCH",
            observedExternalAccountId: probe.accounts[0].externalAccountId,
            requiredUserAction: "SWITCH_ACCOUNT",
          };
        }
        return {
          platform,
          status: "UNAVAILABLE",
          reasonCode: "adapter.account-selection-required",
          requiredUserAction: "REVIEW_MANUALLY",
        };
      }
      return {
        platform,
        status: "AVAILABLE",
        account: {
          externalAccountId: selected.externalAccountId,
          ...(selected.displayName
            ? { displayName: safeMessage(selected.displayName, platform) }
            : {}),
        },
      };
    } catch (error) {
      return {
        platform,
        status: "UNAVAILABLE",
        reasonCode: isPublicationInspectionTimeoutError(error)
          ? "adapter.account-probe-timeout"
          : "adapter.account-probe-failed",
        requiredUserAction: "REVIEW_MANUALLY",
      };
    }
  }

  private async resolveAccounts(
    request: Extract<
      PublicationBridgeV3CommandRequest,
      { command: "accounts.resolve" }
    >,
    runtime: PublicationBridgeV3RuntimeSnapshot,
  ): Promise<PublicationBridgeV3Response> {
    const probes = await Promise.all(
      request.payload.targets.map((target) =>
        this.probeAccount(target.platform, target.expectedExternalAccountId),
      ),
    );
    return this.finalize(request, {
      namespace: PUBLICATION_BRIDGE_NAMESPACE,
      direction: "RESPONSE",
      protocolMajor: PUBLICATION_BRIDGE_PROTOCOL_MAJOR,
      contractVersion: request.contractVersion,
      sessionId: request.sessionId,
      requestId: request.requestId,
      command: request.command,
      ok: true,
      result: { runtime, probes },
    });
  }

  private async acceptPublication(
    request: Extract<
      PublicationBridgeV3CommandRequest,
      { command: "publication.publishDraft" }
    >,
    runtime: PublicationBridgeV3RuntimeSnapshot,
  ): Promise<PublicationBridgeV3Response> {
    const canonical = canonicalizePublicationBridgeV3PublishPayload({
      draft: request.payload.draft,
      targets: request.payload.targets,
    });
    const digest = await (this.dependencies.sha256 ?? defaultSha256)(canonical);
    if (digest !== request.payload.payloadDigest) {
      return this.commandFailure(
        request,
        runtime,
        bridgeError(
          "publication.payload-digest-mismatch",
          "PROTOCOL",
          "The publication payload digest does not match its canonical content.",
          "DO_NOT_RETRY",
          "REVIEW_MANUALLY",
        ),
      );
    }

    for (const target of request.payload.targets) {
      const adapter = runtime.adapters.find(
        (candidate) => candidate.platform === target.platform,
      );
      if (!adapter?.capabilities.includes("adapter.draft.publish")) {
        return this.commandFailure(
          request,
          runtime,
          bridgeError(
            "adapter.publish-unavailable",
            "CAPABILITY",
            `Draft publication is unavailable for ${target.platform}.`,
            "DO_NOT_RETRY",
            "INSTALL_OR_UPGRADE_EXTENSION",
          ),
        );
      }
    }

    return this.exclusive(async () => {
      const state = await this.ensureState();
      const existing = Object.values(state.operations).find(
        (operation) =>
          operation.idempotencyKey === request.payload.idempotencyKey,
      );
      if (existing) {
        if (existing.payloadDigest !== request.payload.payloadDigest) {
          return this.commandFailure(
            request,
            runtime,
            bridgeError(
              "publication.idempotency-conflict",
              "PROTOCOL",
              "This idempotency key is already bound to different publication content.",
              "DO_NOT_RETRY",
              "REVIEW_MANUALLY",
              existing.operationId,
            ),
          );
        }
        return this.finalize(request, {
          namespace: PUBLICATION_BRIDGE_NAMESPACE,
          direction: "RESPONSE",
          protocolMajor: PUBLICATION_BRIDGE_PROTOCOL_MAJOR,
          contractVersion: request.contractVersion,
          sessionId: request.sessionId,
          requestId: request.requestId,
          operationId: request.operationId,
          command: request.command,
          ok: true,
          result: { disposition: "REPLAYED", runtime, operation: existing },
        });
      }

      if (state.operations[request.operationId]) {
        return this.commandFailure(
          request,
          runtime,
          bridgeError(
            "publication.operation-id-conflict",
            "PROTOCOL",
            "The requested operation id is already in use.",
            "DO_NOT_RETRY",
            "REVIEW_MANUALLY",
          ),
        );
      }

      const createdAt = this.now().toISOString();
      const operation = PublicationBridgeV3PublishOperationSnapshotSchema.parse(
        {
          operationId: request.operationId,
          idempotencyKey: request.payload.idempotencyKey,
          documentId: request.payload.draft.documentId,
          payloadDigest: request.payload.payloadDigest,
          state: "ACCEPTED",
          runtime,
          targets: request.payload.targets.map((target) => ({
            ...target,
            outcome: "PENDING",
            phase: "QUEUED",
            writeState: "NOT_DISPATCHED",
          })),
          createdAt,
          updatedAt: createdAt,
        },
      );
      state.operations[request.operationId] = operation;
      state.tasks[request.operationId] = { payload: request.payload };
      await this.persist();

      return this.finalize(request, {
        namespace: PUBLICATION_BRIDGE_NAMESPACE,
        direction: "RESPONSE",
        protocolMajor: PUBLICATION_BRIDGE_PROTOCOL_MAJOR,
        contractVersion: request.contractVersion,
        sessionId: request.sessionId,
        requestId: request.requestId,
        operationId: request.operationId,
        command: request.command,
        ok: true,
        result: { disposition: "ACCEPTED", runtime, operation },
      });
    });
  }

  private async updateTarget(
    operationId: string,
    targetId: string,
    update: (
      target: PublicationBridgeV3PublishTargetSnapshot,
    ) => PublicationBridgeV3PublishTargetSnapshot,
  ): Promise<void> {
    await this.exclusive(async () => {
      const state = await this.ensureState();
      const operation = state.operations[operationId];
      if (!operation || operation.state === "COMPLETED") return;
      const updatedAt = this.now().toISOString();
      const targets = operation.targets.map((target) =>
        target.targetId === targetId ? update(target) : target,
      );
      const completed = targets.every((target) => target.outcome !== "PENDING");
      state.operations[operationId] =
        PublicationBridgeV3PublishOperationSnapshotSchema.parse({
          ...operation,
          state: completed ? "COMPLETED" : "RUNNING",
          targets,
          updatedAt,
          ...(completed ? { completedAt: updatedAt } : {}),
        });
      if (completed) delete state.tasks[operationId];
      await this.persist();
    });
  }

  private async settleUnexpectedRunnerFailure(
    operationId: string,
  ): Promise<PublicationBridgeV3PublishOperationSnapshot | null> {
    return this.exclusive(async () => {
      const state = await this.ensureState();
      const operation = state.operations[operationId];
      if (!operation) return null;
      if (operation.state === "COMPLETED") return operation;

      const completedAt = this.now().toISOString();
      const completed = PublicationBridgeV3PublishOperationSnapshotSchema.parse(
        {
          ...operation,
          state: "COMPLETED",
          targets: operation.targets.map((target) => {
            if (target.outcome !== "PENDING") return target;
            if (target.writeState === "DISPATCHED") {
              return terminalOutcomeUnknown(
                target,
                "The publication runner failed after a platform write was dispatched.",
              );
            }
            return terminalFailure(
              target,
              bridgeError(
                "publication.runner-failed-before-dispatch",
                "ADAPTER",
                "The publication runner failed before the platform write boundary.",
                "SAFE_TO_RETRY",
                "RETRY",
              ),
            );
          }),
          updatedAt: completedAt,
          completedAt,
        },
      );
      state.operations[operationId] = completed;
      delete state.tasks[operationId];
      await this.persist();
      return completed;
    });
  }

  async runPublicationOperation(
    operationId: string,
  ): Promise<PublicationBridgeV3PublishOperationSnapshot | null> {
    if (this.activeOperations.has(operationId)) {
      const state = await this.exclusive(() => this.ensureState());
      return state.operations[operationId] ?? null;
    }
    this.activeOperations.add(operationId);

    try {
      const acceptedRuntime = await this.exclusive(async () => {
        const state = await this.ensureState();
        return state.operations[operationId]?.runtime ?? null;
      });
      if (!acceptedRuntime) return null;
      const currentRuntime = await this.runtime(
        this.contractVersionForRuntime(acceptedRuntime),
      );
      const start = await this.exclusive(
        async (): Promise<
          | { kind: "MISSING" }
          | {
              kind: "COMPLETED";
              operation: PublicationBridgeV3PublishOperationSnapshot;
            }
          | { kind: "RUN"; task: StoredPublishTask }
        > => {
          const state = await this.ensureState();
          const operation = state.operations[operationId];
          const storedTask = state.tasks[operationId];
          if (!operation || !storedTask || operation.state === "COMPLETED")
            return { kind: "MISSING" };

          if (
            !publicationBridgeV3RuntimeSnapshotsEqual(
              operation.runtime,
              currentRuntime,
            )
          ) {
            const completedAt = this.now().toISOString();
            const completed =
              PublicationBridgeV3PublishOperationSnapshotSchema.parse({
                ...operation,
                state: "COMPLETED",
                targets: operation.targets.map((target) =>
                  target.outcome === "PENDING"
                    ? terminalFailure(
                        target,
                        bridgeError(
                          "publication.runtime-changed-before-dispatch",
                          "CAPABILITY",
                          "The producer runtime changed before dispatch; start a new publication operation.",
                          "SAFE_TO_RETRY",
                          "RETRY",
                        ),
                      )
                    : target,
                ),
                updatedAt: completedAt,
                completedAt,
              });
            state.operations[operationId] = completed;
            delete state.tasks[operationId];
            await this.persist();
            return { kind: "COMPLETED", operation: completed };
          }

          const updatedAt = this.now().toISOString();
          state.operations[operationId] =
            PublicationBridgeV3PublishOperationSnapshotSchema.parse({
              ...operation,
              state: "RUNNING",
              updatedAt,
            });
          await this.persist();
          return { kind: "RUN", task: storedTask };
        },
      );
      if (start.kind === "MISSING") return null;
      if (start.kind === "COMPLETED") return start.operation;
      const task = start.task;

      const article = toArticle(task.payload);
      for (const requestedTarget of task.payload.targets) {
        const current = await this.exclusive(async () => {
          const state = await this.ensureState();
          return state.operations[operationId]?.targets.find(
            (target) => target.targetId === requestedTarget.targetId,
          );
        });
        if (!current || current.outcome !== "PENDING") continue;
        if (current.writeState === "DISPATCHED") {
          await this.updateTarget(
            operationId,
            requestedTarget.targetId,
            (target) =>
              target.outcome === "PENDING"
                ? terminalOutcomeUnknown(
                    target,
                    "The extension recovered after dispatch without a proven terminal platform result.",
                  )
                : target,
          );
          continue;
        }

        await this.updateTarget(
          operationId,
          requestedTarget.targetId,
          (target) => ({
            ...target,
            outcome: "PENDING",
            phase: "DISPATCHING",
            writeState: "NOT_DISPATCHED",
          }),
        );

        let dispatched = false;
        let result: SyncResult;
        try {
          result = await this.dependencies.syncToPlatform(
            requestedTarget.platform,
            article,
            {
              draftOnly: true,
              accountBinding: {
                externalAccountId: requestedTarget.requestedExternalAccountId,
              },
              beforeDispatch: async () => {
                await this.updateTarget(
                  operationId,
                  requestedTarget.targetId,
                  (target) => ({
                    ...target,
                    outcome: "PENDING",
                    phase: "AWAITING_RESULT",
                    writeState: "DISPATCHED",
                  }),
                );
                dispatched = true;
              },
            },
          );
        } catch {
          result = {
            platform: requestedTarget.platform,
            success: false,
            errorCode: "BRIDGE_ADAPTER_EXCEPTION",
            error: "The platform adapter failed unexpectedly.",
            timestamp: Date.now(),
          };
        }

        await this.updateTarget(
          operationId,
          requestedTarget.targetId,
          (target) => {
            const base = {
              targetId: target.targetId,
              platform: target.platform,
              requestedExternalAccountId: target.requestedExternalAccountId,
            };
            const locator = stableSuccessfulLocator(target.platform, result);
            const parsedExternalAccountId = ExternalAccountIdSchema.safeParse(
              (result as { externalAccountId?: unknown }).externalAccountId,
            );
            const observedExternalAccountId = parsedExternalAccountId.success
              ? parsedExternalAccountId.data
              : undefined;
            const resultErrorCode =
              typeof result.errorCode === "string"
                ? result.errorCode
                : undefined;
            const resultError =
              typeof result.error === "string" ? result.error : undefined;
            if (
              dispatched &&
              result.outcome !== "OUTCOME_UNKNOWN" &&
              result.success &&
              locator &&
              observedExternalAccountId === target.requestedExternalAccountId
            ) {
              return {
                ...base,
                outcome: "SUCCEEDED",
                writeState: "DISPATCHED",
                observedExternalAccountId,
                ...locator,
              };
            }
            if (dispatched) {
              return {
                ...base,
                outcome: "OUTCOME_UNKNOWN",
                writeState: "DISPATCHED",
                ...(observedExternalAccountId
                  ? { observedExternalAccountId }
                  : {}),
                error: bridgeError(
                  "publication.outcome-unknown",
                  resultErrorCode?.includes("TIMEOUT") ? "TIMEOUT" : "ADAPTER",
                  "A platform write was dispatched without a fully proven terminal result.",
                  "DO_NOT_RETRY",
                  "REVIEW_MANUALLY",
                ),
              };
            }
            return {
              ...base,
              outcome: "FAILED",
              writeState: "NOT_DISPATCHED",
              ...(observedExternalAccountId
                ? { observedExternalAccountId }
                : {}),
              error: bridgeError(
                adapterCode(resultErrorCode, "publish-not-dispatched"),
                "ADAPTER",
                safeMessage(
                  resultError,
                  "The adapter rejected the publication before dispatch.",
                ),
                "SAFE_TO_RETRY",
                "RETRY",
              ),
            };
          },
        );
      }

      return this.exclusive(async () => {
        const state = await this.ensureState();
        const operation = state.operations[operationId];
        if (!operation) return null;
        if (operation.state === "COMPLETED") return operation;
        const completedAt = this.now().toISOString();
        const completed =
          PublicationBridgeV3PublishOperationSnapshotSchema.parse({
            ...operation,
            state: "COMPLETED",
            updatedAt: completedAt,
            completedAt,
          });
        state.operations[operationId] = completed;
        delete state.tasks[operationId];
        await this.persist();
        return completed;
      });
    } catch {
      return await this.settleUnexpectedRunnerFailure(operationId);
    } finally {
      this.activeOperations.delete(operationId);
    }
  }

  private async getOperation(
    request: Extract<
      PublicationBridgeV3CommandRequest,
      { command: "publication.getOperation" }
    >,
    runtime: PublicationBridgeV3RuntimeSnapshot,
  ): Promise<PublicationBridgeV3Response> {
    const state = await this.exclusive(() => this.ensureState());
    const operation = state.operations[request.operationId];
    if (!operation) {
      return this.commandFailure(
        request,
        runtime,
        bridgeError(
          "publication.operation-not-found",
          "PROTOCOL",
          "No publication operation exists for this id.",
          "DO_NOT_RETRY",
          "REVIEW_MANUALLY",
        ),
      );
    }
    return this.finalize(request, {
      namespace: PUBLICATION_BRIDGE_NAMESPACE,
      direction: "RESPONSE",
      protocolMajor: PUBLICATION_BRIDGE_PROTOCOL_MAJOR,
      contractVersion: request.contractVersion,
      sessionId: request.sessionId,
      requestId: request.requestId,
      operationId: request.operationId,
      command: request.command,
      ok: true,
      result: { runtime, operation },
    });
  }

  private matchedLocator(
    locator: PublicationBridgeV3InspectLocator,
    publicIdentityKey?: string,
  ): PublicationBridgeV3MatchedLocator | null {
    if (publicIdentityKey && locator.publicIdentityKey === publicIdentityKey) {
      return { type: "PUBLIC_IDENTITY", publicIdentityKey };
    }
    if (locator.platformPostId) {
      return {
        type: "PLATFORM_POST_ID",
        platformPostId: locator.platformPostId,
      };
    }
    if (locator.draftReference) {
      return {
        type: "DRAFT_REFERENCE",
        draftReference: locator.draftReference,
      };
    }
    if (locator.publicIdentityKey) {
      return {
        type: "PUBLIC_IDENTITY",
        publicIdentityKey: locator.publicIdentityKey,
      };
    }
    return null;
  }

  private toInternalInspectionRequest(
    request: Extract<
      PublicationBridgeV3CommandRequest,
      { command: "publication.inspect" }
    >,
  ): PublicationInspectionRequest | null {
    const parsedPublicUrl = request.payload.locator.publicUrl
      ? parsePublicationUrl(
          request.payload.platform as PublicationBridgeV3PlatformId,
          request.payload.locator.publicUrl,
        )
      : null;
    const knownPublicIdentity = request.payload.locator.publicUrl
      ? derivePublicationPublicIdentity(
          request.payload.platform as PublicationBridgeV3PlatformId,
          request.payload.locator.publicUrl,
        )
      : null;
    if (
      request.payload.locator.publicUrl &&
      (!knownPublicIdentity ||
        knownPublicIdentity.canonicalUrl !==
          request.payload.locator.publicUrl ||
        knownPublicIdentity.key !== request.payload.locator.publicIdentityKey)
    ) {
      return null;
    }
    const platformPostId =
      request.payload.locator.platformPostId ??
      request.payload.locator.draftReference ??
      parsedPublicUrl?.postId;
    if (!platformPostId) return null;

    const publishedNotBefore =
      request.contractVersion !== "3.0"
        ? request.payload.publicationWindow?.publishedNotBefore
        : undefined;
    const candidate = PublicationInspectionRequestSchema.safeParse({
      requestId: request.requestId,
      platform: request.payload.platform,
      externalAccountId: request.payload.requestedExternalAccountId,
      draft: {
        platformPostId,
        draftedAt: publishedNotBefore ?? new Date(0).toISOString(),
      },
      articleHint: {
        title: `Stable locator ${platformPostId}`,
        ...(publishedNotBefore ? { publishedAfter: publishedNotBefore } : {}),
      },
      ...(knownPublicIdentity
        ? {
            knownPublicLocator: {
              publicUrl: knownPublicIdentity.canonicalUrl,
              publicIdentityKey: knownPublicIdentity.key,
            },
          }
        : {}),
      limit: 20,
    });
    return candidate.success ? candidate.data : null;
  }

  private projectObservation(
    request: Extract<
      PublicationBridgeV3CommandRequest,
      { command: "publication.inspect" }
    >,
    internalRequest: PublicationInspectionRequest,
    observation: PublicationInspectionObservation,
    adapter: PlatformAdapter,
  ): PublicationBridgeV3Observation | null {
    const source: PublicationBridgeV3EvidenceSource =
      observation.source === "PUBLIC_PAGE"
        ? "PUBLIC_PAGE"
        : observation.source === "AUTHENTICATED_PUBLIC_PAGE"
          ? "AUTHENTICATED_PAGE"
          : observation.source === "PUBLISHED_LIST"
            ? "PUBLISHED_LIST"
            : "DRAFT_PAGE";
    const key = observation.observationKey.slice(0, 200);

    if (observation.outcome === "PUBLISHED") {
      if (!adapter.provePublishedObservation || !observation.canonicalUrl)
        return null;
      const proof = PublicationPublishedProofSchema.safeParse(
        adapter.provePublishedObservation(internalRequest, observation),
      );
      if (!proof.success) return null;
      const publicAccess = projectPublicAccessV3(proof.data.publicAccess);
      const identity = derivePublicationPublicIdentity(
        request.payload.platform as PublicationBridgeV3PlatformId,
        observation.canonicalUrl,
      );
      if (
        !publicAccess ||
        !identity ||
        proof.data.observedAuthorExternalAccountId !==
          request.payload.requestedExternalAccountId ||
        proof.data.publicAccess.checkedPublicIdentityKey !== identity.key ||
        !observation.platformPostId ||
        !observation.publishedAt ||
        !observation.title?.trim() ||
        !observation.bodyText?.trim() ||
        typeof observation.bodyTruncated !== "boolean"
      ) {
        return null;
      }
      const matchedLocator = this.matchedLocator(
        request.payload.locator,
        identity.key,
      );
      if (!matchedLocator) return null;
      return {
        key,
        platform: request.payload.platform,
        kind: "PUBLISHED",
        observedAt: observation.observedAt,
        source,
        matchedLocator,
        ...(request.payload.locator.draftReference
          ? { draftReference: request.payload.locator.draftReference }
          : {}),
        platformPostId: observation.platformPostId,
        canonicalUrl: identity.canonicalUrl,
        publicIdentityKey: identity.key,
        publishedAt: observation.publishedAt,
        observedExternalAccountId: proof.data.observedAuthorExternalAccountId,
        publicAccess,
        title: observation.title.trim(),
        body: observation.bodyText,
        bodyTruncated: proof.data.bodyTruncated,
      };
    }

    const matchedLocator = this.matchedLocator(request.payload.locator);
    if (!matchedLocator) return null;
    const base = {
      key,
      platform: request.payload.platform,
      observedAt: observation.observedAt,
      source,
      matchedLocator,
    };
    const draftReference =
      request.payload.locator.draftReference ?? observation.platformPostId;

    switch (observation.outcome) {
      case "DRAFT_PRESENT":
        return draftReference
          ? { ...base, kind: "DRAFT_PRESENT", draftReference }
          : null;
      case "PENDING_REVIEW":
        return {
          ...base,
          kind: "PENDING_REVIEW",
          ...(draftReference ? { draftReference } : {}),
          ...(observation.platformPostId
            ? { platformPostId: observation.platformPostId }
            : {}),
        };
      case "REJECTED":
        return {
          ...base,
          kind: "REJECTED",
          ...(draftReference ? { draftReference } : {}),
          ...(observation.platformPostId
            ? { platformPostId: observation.platformPostId }
            : {}),
          reasonCode: adapterCode(
            observation.errorCode,
            "publication-rejected",
          ),
          ...(observation.errorMessage
            ? {
                message: safeMessage(
                  observation.errorMessage,
                  "Publication rejected.",
                ),
              }
            : {}),
        };
      case "NOT_FOUND":
        return { ...base, kind: "NOT_FOUND" };
      case "DELETED": {
        const identity = observation.canonicalUrl
          ? derivePublicationPublicIdentity(
              request.payload.platform as PublicationBridgeV3PlatformId,
              observation.canonicalUrl,
            )
          : null;
        return {
          ...base,
          kind: "DELETED",
          ...(observation.platformPostId
            ? { platformPostId: observation.platformPostId }
            : {}),
          ...(identity
            ? {
                canonicalUrl: identity.canonicalUrl,
                publicIdentityKey: identity.key,
              }
            : {}),
        };
      }
      case "ACCOUNT_MISMATCH":
        return null;
      case "LOGIN_REQUIRED":
        return { ...base, kind: "LOGIN_REQUIRED", requiredUserAction: "LOGIN" };
      case "UNSUPPORTED":
        return {
          ...base,
          kind: "UNSUPPORTED",
          reasonCode: adapterCode(
            observation.errorCode,
            "inspection-unsupported",
          ),
        };
      case "FETCH_ERROR":
        return {
          ...base,
          kind: "FETCH_ERROR",
          errorCode: adapterCode(
            observation.errorCode,
            "inspection-fetch-error",
          ),
          retryable: true,
          ...(observation.errorMessage
            ? {
                message: safeMessage(
                  observation.errorMessage,
                  "Inspection fetch failed.",
                ),
              }
            : {}),
        };
      case "PARSE_ERROR":
        return {
          ...base,
          kind: "PARSE_ERROR",
          errorCode: adapterCode(
            observation.errorCode,
            "inspection-parse-error",
          ),
          ...(observation.errorMessage
            ? {
                message: safeMessage(
                  observation.errorMessage,
                  "Inspection parsing failed.",
                ),
              }
            : {}),
        };
      case "SCHEDULED":
      case "REVIEW_REQUIRED":
        return {
          ...base,
          kind: "REVIEW_REQUIRED",
          reasonCode: adapterCode(observation.errorCode, "review-required"),
          ...(observation.errorMessage
            ? {
                message: safeMessage(
                  observation.errorMessage,
                  "Manual review is required.",
                ),
              }
            : {}),
        };
    }
  }

  private async handleInspection(
    request: Extract<
      PublicationBridgeV3CommandRequest,
      { command: "publication.inspect" }
    >,
    context?: PublicationBridgeV3HandleContext,
  ): Promise<PublicationBridgeV3Response> {
    this.pruneInspectionTombstones();
    const caller = this.caller(context);
    const key = this.inspectionKey(
      caller,
      request.sessionId,
      request.operationId,
      request.requestId,
    );
    const prior = this.inspectionTombstones.get(key);
    if (prior?.state === "CANCELLED") {
      return this.commandFailure(
        request,
        this.runtimeWithoutIo(request.sessionId, request.contractVersion),
        bridgeError(
          "publication.inspection-cancelled",
          "TRANSPORT",
          "The caller cancelled the platform inspection before it started.",
          "SAFE_TO_RETRY",
          "RETRY",
        ),
      );
    }
    if (prior?.state === "TERMINAL") {
      this.inspectionTombstones.delete(key);
    }

    // This check and the registration below are intentionally synchronous.
    // JavaScript cannot interleave a second handler between them, so an exact
    // duplicate can never replace the controller that bridge.cancel targets.
    // Rejecting the duplicate also guarantees that only the registered
    // executor is allowed to write the inspection's terminal tombstone.
    if (this.activeInspections.has(key)) {
      return this.commandFailure(
        request,
        this.runtimeWithoutIo(request.sessionId, request.contractVersion),
        bridgeError(
          "bridge.request-already-active",
          "PROTOCOL",
          "An inspection with the same request identity is already running.",
          "DO_NOT_RETRY",
          "REVIEW_MANUALLY",
        ),
      );
    }

    const requestedDeadlineAt =
      request.contractVersion === "3.2"
        ? Date.parse(request.deadlineAt as string)
        : Date.now() + INSPECTION_COMMAND_TIMEOUT_MS;
    const controller = new AbortController();
    const abortFromParent = () => {
      if (!controller.signal.aborted) {
        controller.abort(
          context?.signal?.reason ??
            new PublicationInspectionCancelledError("CALLER_ABORTED"),
        );
      }
    };
    if (context?.signal?.aborted) {
      abortFromParent();
    } else {
      context?.signal?.addEventListener("abort", abortFromParent, {
        once: true,
      });
    }

    const active: ActiveInspection = { controller };
    this.activeInspections.set(key, active);
    let runtime = this.runtimeWithoutIo(
      request.sessionId,
      request.contractVersion,
    );
    try {
      return await withPublicationInspectionDeadline(
        async (signal, deadlineAt) => {
          const session = await this.validateSession(request, signal);
          if (!session.ok) return session.response;
          runtime = session.runtime;
          return this.inspectPublicationWithinDeadline(
            request,
            runtime,
            signal,
            deadlineAt,
          );
        },
        {
          timeoutMs: Math.max(0, requestedDeadlineAt - Date.now()),
          phase: "COMMAND",
          parentSignal: controller.signal,
          deadlineAt: requestedDeadlineAt,
        },
      );
    } catch (error) {
      const timedOut = isPublicationInspectionTimeoutError(error);
      const cancelled =
        error instanceof PublicationInspectionCancelledError ||
        (!timedOut && controller.signal.aborted);
      return this.commandFailure(
        request,
        runtime,
        bridgeError(
          cancelled
            ? "publication.inspection-cancelled"
            : timedOut
            ? "publication.inspection-timeout"
            : "publication.inspection-failed",
          cancelled ? "TRANSPORT" : timedOut ? "TIMEOUT" : "ADAPTER",
          cancelled
            ? "The caller cancelled the platform inspection."
            : timedOut
            ? "The platform inspection exceeded its end-to-end deadline."
            : "The platform inspection failed unexpectedly.",
          cancelled || timedOut ? "SAFE_TO_RETRY" : "REVIEW_BEFORE_RETRY",
          cancelled || timedOut ? "RETRY" : "REVIEW_MANUALLY",
        ),
      );
    } finally {
      context?.signal?.removeEventListener("abort", abortFromParent);
      if (this.activeInspections.get(key) === active) {
        this.activeInspections.delete(key);
      }
      if (this.inspectionTombstones.get(key)?.state !== "CANCELLED") {
        this.writeInspectionTombstone(key, "TERMINAL");
      }
    }
  }

  private async inspectPublicationWithinDeadline(
    request: Extract<
      PublicationBridgeV3CommandRequest,
      { command: "publication.inspect" }
    >,
    runtime: PublicationBridgeV3RuntimeSnapshot,
    signal: AbortSignal,
    commandDeadlineAt: number,
  ): Promise<PublicationBridgeV3Response> {
    signal.throwIfAborted();
    const adapterSnapshot = runtime.adapters.find(
      (candidate) => candidate.platform === request.payload.platform,
    );
    if (
      !adapterSnapshot?.capabilities.includes("adapter.publication.inspect")
    ) {
      return this.commandFailure(
        request,
        runtime,
        bridgeError(
          "adapter.inspection-unavailable",
          "CAPABILITY",
          "This platform does not implement stable-locator Bridge v3 inspection.",
          "DO_NOT_RETRY",
          "INSTALL_OR_UPGRADE_EXTENSION",
        ),
      );
    }

    let verifiedAccountProbe: AdapterAccountProbe | undefined;
    const account = await this.probeAccount(
      request.payload.platform,
      request.payload.requestedExternalAccountId,
      {
        signal,
        deadlineAt: commandDeadlineAt - INSPECTION_COMMAND_RESERVE_MS,
      },
      (probe) => {
        verifiedAccountProbe = probe;
      },
    );
    signal.throwIfAborted();
    if (account.status !== "AVAILABLE") {
      const accountTimedOut =
        account.status === "UNAVAILABLE" &&
        account.reasonCode === "adapter.account-probe-timeout";
      return this.commandFailure(
        request,
        runtime,
        bridgeError(
          accountTimedOut
            ? "adapter.account-probe-timeout"
            : account.status === "LOGIN_REQUIRED"
              ? "adapter.login-required"
              : account.status === "ACCOUNT_MISMATCH"
                ? "adapter.account-mismatch"
                : account.status === "UNAVAILABLE"
                  ? account.reasonCode
                  : "adapter.account-probe-failed",
          accountTimedOut ? "TIMEOUT" : "ADAPTER",
          accountTimedOut
            ? "The platform account probe exceeded its deadline."
            : "The requested platform account is not available for inspection.",
          accountTimedOut ? "SAFE_TO_RETRY" : "REVIEW_BEFORE_RETRY",
          accountTimedOut
            ? "RETRY"
            : account.status === "LOGIN_REQUIRED"
              ? "LOGIN"
              : account.status === "ACCOUNT_MISMATCH"
                ? "SWITCH_ACCOUNT"
                : "REVIEW_MANUALLY",
        ),
      );
    }

    const internalRequest = this.toInternalInspectionRequest(request);
    signal.throwIfAborted();
    const adapter = await this.dependencies.getAdapter(
      request.payload.platform,
    );
    signal.throwIfAborted();
    if (!internalRequest || !adapter) {
      return this.commandFailure(
        request,
        runtime,
        bridgeError(
          "publication.stable-locator-required",
          "PROTOCOL",
          "The inspection request does not contain a usable stable platform locator.",
          "DO_NOT_RETRY",
          "REVIEW_MANUALLY",
        ),
      );
    }

    const inspection = await runInternalPublicationInspection(
      internalRequest,
      adapter,
      {
        timeoutMs: request.payload.locator.publicUrl
          ? KNOWN_PUBLIC_INSPECTION_TIMEOUT_MS
          : DISCOVERY_INSPECTION_TIMEOUT_MS,
        operationContext: {
          signal,
          verifiedAccountProbe,
          deadlineAt: commandDeadlineAt - INSPECTION_COMMAND_RESERVE_MS,
        },
      },
    );
    signal.throwIfAborted();
    if (!inspection.ok) {
      const timedOut = inspection.code === "PUBLICATION_INSPECTION_TIMEOUT";
      return this.commandFailure(
        request,
        runtime,
        bridgeError(
          timedOut
            ? "adapter.publication-inspection-timeout"
            : adapterCode(inspection.code, "inspection-failed"),
          timedOut ? "TIMEOUT" : "ADAPTER",
          timedOut
            ? "The platform adapter inspection exceeded its deadline."
            : "The platform inspection could not produce trusted evidence.",
          timedOut ? "SAFE_TO_RETRY" : "REVIEW_BEFORE_RETRY",
          timedOut ? "RETRY" : "REVIEW_MANUALLY",
        ),
      );
    }

    const observations = inspection.observations.map((observation) =>
      this.projectObservation(request, internalRequest, observation, adapter),
    );
    if (observations.some((observation) => observation === null)) {
      return this.commandFailure(
        request,
        runtime,
        bridgeError(
          "adapter.inspection-evidence-invalid",
          "PROTOCOL",
          "The adapter returned evidence that cannot satisfy the shared v3 contract.",
          "DO_NOT_RETRY",
          "INSTALL_OR_UPGRADE_EXTENSION",
        ),
      );
    }

    return this.finalize(request, {
      namespace: PUBLICATION_BRIDGE_NAMESPACE,
      direction: "RESPONSE",
      protocolMajor: PUBLICATION_BRIDGE_PROTOCOL_MAJOR,
      contractVersion: request.contractVersion,
      sessionId: request.sessionId,
      requestId: request.requestId,
      operationId: request.operationId,
      command: request.command,
      ok: true,
      result: {
        runtime,
        platform: request.payload.platform,
        requestedExternalAccountId: request.payload.requestedExternalAccountId,
        locator: request.payload.locator,
        ...(request.payload.publicationWindow
          ? { publicationWindow: request.payload.publicationWindow }
          : {}),
        observations,
      },
    });
  }

  private async openDraft(
    request: Extract<
      PublicationBridgeV3CommandRequest,
      { command: "publication.openDraft" }
    >,
    runtime: PublicationBridgeV3RuntimeSnapshot,
  ): Promise<PublicationBridgeV3Response> {
    const adapterSnapshot = runtime.adapters.find(
      (candidate) => candidate.platform === request.payload.platform,
    );
    if (!adapterSnapshot?.capabilities.includes("adapter.draft.open")) {
      return this.commandFailure(
        request,
        runtime,
        bridgeError(
          "adapter.draft-open-unavailable",
          "CAPABILITY",
          "This platform does not support opening a private draft through Bridge v3.",
          "DO_NOT_RETRY",
          "OPEN_PLATFORM",
        ),
      );
    }

    const adapter = await this.dependencies.getAdapter(
      request.payload.platform,
    );
    try {
      await runOpenPublicationDraft(
        {
          requestId: request.requestId,
          platform: request.payload.platform as PublicationBridgeV3PlatformId,
          externalAccountId: request.payload.requestedExternalAccountId,
          platformPostId: request.payload.draftReference,
        },
        adapter,
      );
    } catch (error) {
      const code = error instanceof Error ? error.message : undefined;
      return this.commandFailure(
        request,
        runtime,
        bridgeError(
          adapterCode(code, "draft-open-failed"),
          "ADAPTER",
          "The authenticated platform draft could not be opened.",
          "REVIEW_BEFORE_RETRY",
          code === "LOGIN_REQUIRED"
            ? "LOGIN"
            : code === "ACCOUNT_MISMATCH"
              ? "SWITCH_ACCOUNT"
              : "OPEN_PLATFORM",
        ),
      );
    }

    return this.finalize(request, {
      namespace: PUBLICATION_BRIDGE_NAMESPACE,
      direction: "RESPONSE",
      protocolMajor: PUBLICATION_BRIDGE_PROTOCOL_MAJOR,
      contractVersion: request.contractVersion,
      sessionId: request.sessionId,
      requestId: request.requestId,
      operationId: request.operationId,
      command: request.command,
      ok: true,
      result: {
        runtime,
        platform: request.payload.platform,
        observedExternalAccountId: request.payload.requestedExternalAccountId,
        draftReference: request.payload.draftReference,
        opened: true,
      },
    });
  }
}

export function assertPublicationBridgeV3Request(
  value: unknown,
): PublicationBridgeV3Request {
  return PublicationBridgeV3RequestSchema.parse(value);
}

export function assertPublicationBridgeV3CommandRequest(
  value: unknown,
): PublicationBridgeV3CommandRequest {
  return PublicationBridgeV3CommandRequestSchema.parse(value);
}
