import {
  publicationBridgeV3IdempotencyConflictResponseFixture,
  publicationBridgeV3PublishAcceptedResponseFixture,
  publicationBridgeV3PublishRequestFixture,
  publicationBridgeV32CancelRequestFixture,
  publicationBridgeV32CancelResponseFixture,
} from "@byfire-dev/publication-bridge-contract/v3/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { chromeMock } from "../vitest.setup";

interface ContentWindowHarness {
  addEventListener: ReturnType<typeof vi.fn>;
  location: { origin: string };
  postMessage: ReturnType<typeof vi.fn>;
  top: ContentWindowHarness;
}

const originalWindow = globalThis.window;
const originalDocument = globalThis.document;

function installContentGlobals(): ContentWindowHarness {
  const windowObject = {
    addEventListener: vi.fn(),
    location: { origin: "http://localhost" },
    postMessage: vi.fn(),
  } as unknown as ContentWindowHarness;
  windowObject.top = windowObject;

  Object.assign(globalThis, {
    window: windowObject,
    document: {
      readyState: "loading",
      addEventListener: vi.fn(),
    },
  });
  return windowObject;
}

async function loadHandler() {
  vi.resetModules();
  return (await import("../src/content/api")).handlePublicationBridgeRequestV3;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  if (originalWindow === undefined) {
    Reflect.deleteProperty(globalThis, "window");
  } else {
    globalThis.window = originalWindow;
  }
  if (originalDocument === undefined) {
    Reflect.deleteProperty(globalThis, "document");
  } else {
    globalThis.document = originalDocument;
  }
});

describe("content publication Bridge v3 relay", () => {
  it("relays a v3.2 cancellation as a normal contract exchange", async () => {
    const windowObject = installContentGlobals();
    chromeMock.runtime.sendMessage.mockImplementation(
      (_message: unknown, callback?: (response: unknown) => void) => {
        callback?.(publicationBridgeV32CancelResponseFixture);
      },
    );
    const handleRequest = await loadHandler();

    await handleRequest({
      source: windowObject,
      origin: windowObject.location.origin,
      data: publicationBridgeV32CancelRequestFixture,
    } as unknown as MessageEvent);

    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith(
      {
        type: "BRIDGE_CALL_V3",
        request: publicationBridgeV32CancelRequestFixture,
      },
      expect.any(Function),
    );
    expect(windowObject.postMessage).toHaveBeenCalledWith(
      publicationBridgeV32CancelResponseFixture,
      windowObject.location.origin,
    );
    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("posts acceptance first, then opens a long-lived operation runner message", async () => {
    const windowObject = installContentGlobals();
    const runnerCallbacks: unknown[] = [];
    chromeMock.runtime.sendMessage.mockImplementation(
      (message: { type?: string }, callback?: (response: unknown) => void) => {
        if (message.type === "BRIDGE_CALL_V3") {
          callback?.(publicationBridgeV3PublishAcceptedResponseFixture);
        } else if (message.type === "BRIDGE_RUN_PUBLICATION_OPERATION_V3") {
          runnerCallbacks.push(callback);
        }
      },
    );
    const handleRequest = await loadHandler();

    await handleRequest({
      source: windowObject,
      origin: windowObject.location.origin,
      data: publicationBridgeV3PublishRequestFixture,
    } as unknown as MessageEvent);

    expect(chromeMock.runtime.sendMessage).toHaveBeenNthCalledWith(
      1,
      {
        type: "BRIDGE_CALL_V3",
        request: publicationBridgeV3PublishRequestFixture,
      },
      expect.any(Function),
    );
    expect(windowObject.postMessage).toHaveBeenCalledWith(
      publicationBridgeV3PublishAcceptedResponseFixture,
      windowObject.location.origin,
    );
    expect(chromeMock.runtime.sendMessage).toHaveBeenNthCalledWith(
      2,
      {
        type: "BRIDGE_RUN_PUBLICATION_OPERATION_V3",
        operationId:
          publicationBridgeV3PublishAcceptedResponseFixture.result.operation
            .operationId,
      },
      expect.any(Function),
    );
    expect(runnerCallbacks).toHaveLength(1);

    const initialCallOrder =
      chromeMock.runtime.sendMessage.mock.invocationCallOrder[0];
    const postOrder = windowObject.postMessage.mock.invocationCallOrder[0];
    const runnerCallOrder =
      chromeMock.runtime.sendMessage.mock.invocationCallOrder[1];
    expect(initialCallOrder).toBeLessThan(postOrder);
    expect(postOrder).toBeLessThan(runnerCallOrder);
  });

  it("relays contract ok:false without starting an operation runner", async () => {
    const windowObject = installContentGlobals();
    const request = {
      ...publicationBridgeV3PublishRequestFixture,
      requestId:
        publicationBridgeV3IdempotencyConflictResponseFixture.requestId,
      operationId:
        publicationBridgeV3IdempotencyConflictResponseFixture.operationId,
    };
    chromeMock.runtime.sendMessage.mockImplementation(
      (_message: unknown, callback?: (response: unknown) => void) => {
        callback?.(publicationBridgeV3IdempotencyConflictResponseFixture);
      },
    );
    const handleRequest = await loadHandler();

    await handleRequest({
      source: windowObject,
      origin: windowObject.location.origin,
      data: request,
    } as unknown as MessageEvent);

    expect(windowObject.postMessage).toHaveBeenCalledWith(
      publicationBridgeV3IdempotencyConflictResponseFixture,
      windowObject.location.origin,
    );
    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("returns an immediate transport failure when the runtime response is invalid", async () => {
    const windowObject = installContentGlobals();
    chromeMock.runtime.sendMessage.mockImplementation(
      (_message: unknown, callback?: (response: unknown) => void) => {
        callback?.(undefined);
      },
    );
    const handleRequest = await loadHandler();

    await handleRequest({
      source: windowObject,
      origin: windowObject.location.origin,
      data: publicationBridgeV3PublishRequestFixture,
    } as unknown as MessageEvent);

    expect(windowObject.postMessage).toHaveBeenCalledWith(
      {
        namespace: publicationBridgeV3PublishRequestFixture.namespace,
        direction: "TRANSPORT_ERROR",
        protocolMajor: publicationBridgeV3PublishRequestFixture.protocolMajor,
        requestId: publicationBridgeV3PublishRequestFixture.requestId,
        command: publicationBridgeV3PublishRequestFixture.command,
        error: {
          code: "BRIDGE_RUNTIME_ERROR",
          message: "The Publication Bridge transport failed.",
        },
      },
      windowObject.location.origin,
    );
  });

  it("rejects a foreign source or non-matching page origin before runtime I/O", async () => {
    const windowObject = installContentGlobals();
    const handleRequest = await loadHandler();

    await handleRequest({
      source: { foreign: true },
      origin: windowObject.location.origin,
      data: publicationBridgeV3PublishRequestFixture,
    } as unknown as MessageEvent);
    await handleRequest({
      source: windowObject,
      origin: "https://evil.example",
      data: publicationBridgeV3PublishRequestFixture,
    } as unknown as MessageEvent);

    expect(chromeMock.runtime.sendMessage).not.toHaveBeenCalled();
    expect(windowObject.postMessage).not.toHaveBeenCalled();
  });
});
