import {
  PUBLICATION_CONTRACT_VERSION_V3,
  PUBLICATION_REQUEST_ID_MAX_LENGTH_V3,
  PublicationBridgeInfoV3Schema,
  PublicationInspectRequestV3Schema,
  PublicationInspectResultV3Schema,
  type PublicationBridgeInfoV3,
  type PublicationInspectRequestV3,
  type PublicationInspectResultV3,
} from "@wechatsync/publication-contract/v3";

import {
  BRIDGE_DIRECTIONS,
  BRIDGE_NAMESPACE,
  DEFAULT_BRIDGE_ALLOWED_ORIGINS,
  isAllowedBridgeOrigin,
  type BridgeMessageEventLike,
  type BridgeParseResult,
} from "./protocol";

export const PUBLICATION_BRIDGE_API_VERSION_V3 =
  PUBLICATION_CONTRACT_VERSION_V3;

export const PUBLICATION_BRIDGE_METHODS_V3 = [
  "getPublicationBridgeInfoV3",
  "inspectPublicationV3",
] as const;

export type PublicationBridgeMethodV3 =
  (typeof PUBLICATION_BRIDGE_METHODS_V3)[number];

export interface PublicationBridgeRequestPayloadMapV3 {
  getPublicationBridgeInfoV3: Record<string, never>;
  inspectPublicationV3: PublicationInspectRequestV3;
}

export interface PublicationBridgeResponseResultMapV3 {
  getPublicationBridgeInfoV3: PublicationBridgeInfoV3;
  inspectPublicationV3: PublicationInspectResultV3;
}

export type PublicationBridgeRequestForV3<M extends PublicationBridgeMethodV3> =
  {
    namespace: typeof BRIDGE_NAMESPACE;
    apiVersion: typeof PUBLICATION_BRIDGE_API_VERSION_V3;
    direction: typeof BRIDGE_DIRECTIONS.request;
    requestId: string;
    method: M;
    payload: PublicationBridgeRequestPayloadMapV3[M];
  };

export type PublicationBridgeRequestV3 = {
  [M in PublicationBridgeMethodV3]: PublicationBridgeRequestForV3<M>;
}[PublicationBridgeMethodV3];

export type PublicationBridgeSuccessResponseForV3<
  M extends PublicationBridgeMethodV3,
> = {
  namespace: typeof BRIDGE_NAMESPACE;
  apiVersion: typeof PUBLICATION_BRIDGE_API_VERSION_V3;
  direction: typeof BRIDGE_DIRECTIONS.response;
  requestId: string;
  method: M;
  ok: true;
  result: PublicationBridgeResponseResultMapV3[M];
};

export interface PublicationBridgeErrorV3 {
  code: string;
  message: string;
}

export type PublicationBridgeErrorResponseForV3<
  M extends PublicationBridgeMethodV3,
> = {
  namespace: typeof BRIDGE_NAMESPACE;
  apiVersion: typeof PUBLICATION_BRIDGE_API_VERSION_V3;
  direction: typeof BRIDGE_DIRECTIONS.response;
  requestId: string;
  method: M;
  ok: false;
  error: PublicationBridgeErrorV3;
};

export type PublicationBridgeSuccessResponseV3 = {
  [M in PublicationBridgeMethodV3]: PublicationBridgeSuccessResponseForV3<M>;
}[PublicationBridgeMethodV3];

export type PublicationBridgeErrorResponseV3 = {
  [M in PublicationBridgeMethodV3]: PublicationBridgeErrorResponseForV3<M>;
}[PublicationBridgeMethodV3];

export type PublicationBridgeResponseV3 =
  | PublicationBridgeSuccessResponseV3
  | PublicationBridgeErrorResponseV3;

const REQUEST_ENVELOPE_KEYS = new Set([
  "namespace",
  "apiVersion",
  "direction",
  "requestId",
  "method",
  "payload",
]);
const RESPONSE_SUCCESS_KEYS = new Set([
  "namespace",
  "apiVersion",
  "direction",
  "requestId",
  "method",
  "ok",
  "result",
]);
const RESPONSE_ERROR_KEYS = new Set([
  "namespace",
  "apiVersion",
  "direction",
  "requestId",
  "method",
  "ok",
  "error",
]);
const ERROR_KEYS = new Set(["code", "message"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>,
): boolean {
  return (
    Object.getOwnPropertySymbols(value).length === 0 &&
    Object.keys(value).every((key) => allowedKeys.has(key))
  );
}

function normalizePublicationBridgeRequestIdV3(value: unknown): string | null {
  if (typeof value !== "string") return null;

  const normalized = value.trim();
  return normalized.length > 0 &&
    normalized.length <= PUBLICATION_REQUEST_ID_MAX_LENGTH_V3
    ? normalized
    : null;
}

function isPublicationBridgeMethodV3(
  value: unknown,
): value is PublicationBridgeMethodV3 {
  return (
    typeof value === "string" &&
    (PUBLICATION_BRIDGE_METHODS_V3 as readonly string[]).includes(value)
  );
}

function parseInfoRequestPayloadV3(
  value: unknown,
): Record<string, never> | null {
  if (typeof value === "undefined") return {};
  if (!isRecord(value) || Object.keys(value).length !== 0) return null;
  return {};
}

function parseRequestPayloadV3<M extends PublicationBridgeMethodV3>(
  method: M,
  value: unknown,
  requestId: string,
): PublicationBridgeRequestPayloadMapV3[M] | null {
  if (method === "getPublicationBridgeInfoV3") {
    return parseInfoRequestPayloadV3(value) as
      | PublicationBridgeRequestPayloadMapV3[M]
      | null;
  }

  const parsed = PublicationInspectRequestV3Schema.safeParse(value);
  if (!parsed.success || parsed.data.requestId !== requestId) return null;
  return parsed.data as PublicationBridgeRequestPayloadMapV3[M];
}

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

export function parsePublicationBridgeRequestEventV3(
  event: BridgeMessageEventLike,
  expectedSource: unknown,
  allowedOrigins: readonly string[] = DEFAULT_BRIDGE_ALLOWED_ORIGINS,
): BridgeParseResult<PublicationBridgeRequestV3> {
  const boundaryFailure = validateEventBoundary(
    event,
    expectedSource,
    allowedOrigins,
  );
  if (boundaryFailure) return boundaryFailure;

  if (
    !isRecord(event.data) ||
    !hasOnlyKeys(event.data, REQUEST_ENVELOPE_KEYS)
  ) {
    return { success: false, code: "INVALID_ENVELOPE" };
  }

  const { data } = event;
  const requestId = normalizePublicationBridgeRequestIdV3(data.requestId);
  if (
    data.namespace !== BRIDGE_NAMESPACE ||
    data.apiVersion !== PUBLICATION_BRIDGE_API_VERSION_V3 ||
    data.direction !== BRIDGE_DIRECTIONS.request ||
    requestId === null
  ) {
    return { success: false, code: "INVALID_ENVELOPE" };
  }
  if (!isPublicationBridgeMethodV3(data.method)) {
    return { success: false, code: "METHOD_NOT_ALLOWED" };
  }

  const payload = parseRequestPayloadV3(data.method, data.payload, requestId);
  if (payload === null) {
    return { success: false, code: "INVALID_PAYLOAD" };
  }

  return {
    success: true,
    data: {
      namespace: BRIDGE_NAMESPACE,
      apiVersion: PUBLICATION_BRIDGE_API_VERSION_V3,
      direction: BRIDGE_DIRECTIONS.request,
      requestId,
      method: data.method,
      payload,
    } as PublicationBridgeRequestV3,
  };
}

function parseResponseResultV3<M extends PublicationBridgeMethodV3>(
  method: M,
  value: unknown,
  requestId: string,
): PublicationBridgeResponseResultMapV3[M] | null {
  if (method === "getPublicationBridgeInfoV3") {
    const parsed = PublicationBridgeInfoV3Schema.safeParse(value);
    return parsed.success
      ? (parsed.data as PublicationBridgeResponseResultMapV3[M])
      : null;
  }

  const parsed = PublicationInspectResultV3Schema.safeParse(value);
  if (!parsed.success || parsed.data.requestId !== requestId) return null;
  return parsed.data as PublicationBridgeResponseResultMapV3[M];
}

function parseBridgeErrorV3(value: unknown): PublicationBridgeErrorV3 | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ERROR_KEYS)) return null;
  if (
    typeof value.code !== "string" ||
    value.code.length === 0 ||
    value.code.length > 100 ||
    typeof value.message !== "string" ||
    value.message.length === 0 ||
    value.message.length > 2_000
  ) {
    return null;
  }
  return { code: value.code, message: value.message };
}

export function parsePublicationBridgeResponseEventV3(
  event: BridgeMessageEventLike,
  expectedSource: unknown,
  allowedOrigins: readonly string[] = DEFAULT_BRIDGE_ALLOWED_ORIGINS,
): BridgeParseResult<PublicationBridgeResponseV3> {
  const boundaryFailure = validateEventBoundary(
    event,
    expectedSource,
    allowedOrigins,
  );
  if (boundaryFailure) return boundaryFailure;
  if (!isRecord(event.data)) {
    return { success: false, code: "INVALID_ENVELOPE" };
  }

  const { data } = event;
  const requestId = normalizePublicationBridgeRequestIdV3(data.requestId);
  const expectedKeys =
    data.ok === true ? RESPONSE_SUCCESS_KEYS : RESPONSE_ERROR_KEYS;
  if (
    !hasOnlyKeys(data, expectedKeys) ||
    data.namespace !== BRIDGE_NAMESPACE ||
    data.apiVersion !== PUBLICATION_BRIDGE_API_VERSION_V3 ||
    data.direction !== BRIDGE_DIRECTIONS.response ||
    requestId === null
  ) {
    return { success: false, code: "INVALID_ENVELOPE" };
  }
  if (!isPublicationBridgeMethodV3(data.method)) {
    return { success: false, code: "METHOD_NOT_ALLOWED" };
  }

  if (data.ok === true) {
    const result = parseResponseResultV3(data.method, data.result, requestId);
    if (result === null) {
      return { success: false, code: "INVALID_PAYLOAD" };
    }
    return {
      success: true,
      data: {
        namespace: BRIDGE_NAMESPACE,
        apiVersion: PUBLICATION_BRIDGE_API_VERSION_V3,
        direction: BRIDGE_DIRECTIONS.response,
        requestId,
        method: data.method,
        ok: true,
        result,
      } as PublicationBridgeSuccessResponseV3,
    };
  }

  if (data.ok !== false) {
    return { success: false, code: "INVALID_ENVELOPE" };
  }
  const error = parseBridgeErrorV3(data.error);
  if (!error) return { success: false, code: "INVALID_PAYLOAD" };

  return {
    success: true,
    data: {
      namespace: BRIDGE_NAMESPACE,
      apiVersion: PUBLICATION_BRIDGE_API_VERSION_V3,
      direction: BRIDGE_DIRECTIONS.response,
      requestId,
      method: data.method,
      ok: false,
      error,
    } as PublicationBridgeErrorResponseV3,
  };
}

export function createPublicationBridgeSuccessResponseV3<
  M extends PublicationBridgeMethodV3,
>(
  request: PublicationBridgeRequestForV3<M>,
  result: PublicationBridgeResponseResultMapV3[M],
): PublicationBridgeSuccessResponseForV3<M> {
  const parsedResult = parseResponseResultV3(
    request.method,
    result,
    request.requestId,
  );
  if (parsedResult === null) {
    throw new TypeError(
      `Invalid result for publication bridge method ${request.method}`,
    );
  }

  return {
    namespace: BRIDGE_NAMESPACE,
    apiVersion: PUBLICATION_BRIDGE_API_VERSION_V3,
    direction: BRIDGE_DIRECTIONS.response,
    requestId: request.requestId,
    method: request.method,
    ok: true,
    result: parsedResult,
  };
}

export function createPublicationBridgeErrorResponseV3<
  M extends PublicationBridgeMethodV3,
>(
  request: PublicationBridgeRequestForV3<M>,
  error: PublicationBridgeErrorV3,
): PublicationBridgeErrorResponseForV3<M> {
  const parsedError = parseBridgeErrorV3(error);
  if (!parsedError) throw new TypeError("Invalid publication bridge error");

  return {
    namespace: BRIDGE_NAMESPACE,
    apiVersion: PUBLICATION_BRIDGE_API_VERSION_V3,
    direction: BRIDGE_DIRECTIONS.response,
    requestId: request.requestId,
    method: request.method,
    ok: false,
    error: parsedError,
  };
}
