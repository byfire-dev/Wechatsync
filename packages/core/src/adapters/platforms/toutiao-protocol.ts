const DECIMAL_ID_PATTERN = /^[1-9]\d{0,31}$/;
const CURSOR_PATTERN = /^\d{1,32}$/;
const MAX_RESPONSE_LENGTH = 1024 * 1024;
const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
export const TOUTIAO_MAX_RESPONSE_BYTES = 1024 * 1024;
export const TOUTIAO_MAX_DRAFT_DETAIL_RESPONSE_BYTES = 1024 * 1024;
export const TOUTIAO_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const TOUTIAO_MAX_CONTENT_HTML_LENGTH = 300_000;
export const TOUTIAO_MAX_CONTENT_TEXT_LENGTH = 150_000;
const MAX_DATA_IMAGE_LENGTH =
  Math.ceil((TOUTIAO_MAX_IMAGE_BYTES * 4) / 3) + 128;
const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

export const TOUTIAO_ENDPOINTS = {
  account: "https://mp.toutiao.com/mp/agw/media/get_media_info",
  loginStatus: "https://mp.toutiao.com/mp/agw/media/user_login_status_api",
  csrf: "https://mp.toutiao.com/ttwid/check/",
  saveDraft:
    "https://mp.toutiao.com/mp/agw/article/publish?source=mp&type=article&aid=1231",
  draftDetail: "https://mp.toutiao.com/mp/agw/article/edit",
  uploadImage:
    "https://mp.toutiao.com/spice/image?upload_source=20020002&aid=1231&device_platform=web",
} as const;

/**
 * Creator-center endpoints observed during the protocol spike. Publication
 * inspection remains paused until response fixtures and account-binding
 * semantics are verified. loginStatus remains as a compatibility alias after
 * being promoted to the production account-probe contract.
 */
export const TOUTIAO_SPIKE_ENDPOINTS = {
  loginStatus: TOUTIAO_ENDPOINTS.loginStatus,
  draftList: "https://mp.toutiao.com/mp/agw/creator_center/draft_list",
  draftCount: "https://mp.toutiao.com/mp/agw/creator_center/draft_count",
} as const;

export const TOUTIAO_ROUTES = {
  editor: "https://mp.toutiao.com/profile_v4/graphic/publish",
  drafts: "https://mp.toutiao.com/profile_v4/manage/draft",
  published: "https://mp.toutiao.com/profile_v4/manage/content/all",
} as const;

export type ToutiaoProtocolErrorCode =
  | "AUTHENTICATION_REQUIRED"
  | "INVALID_RESPONSE"
  | "INVALID_ACCOUNT_ID"
  | "INVALID_DRAFT_ID"
  | "PLATFORM_REJECTED";

export type ToutiaoProtocolResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: ToutiaoProtocolErrorCode };

export interface ToutiaoAccountIdentity {
  userId: string;
  username?: string;
  avatar?: string;
}

export type ToutiaoPageAccountProbeResult =
  | { ok: true; value: ToutiaoAccountIdentity }
  | {
      ok: false;
      code:
        | "NOT_AUTHENTICATED"
        | "TIMEOUT"
        | "NETWORK_ERROR"
        | "HTTP_ERROR"
        | "REDIRECTED"
        | "INVALID_CONTENT_TYPE"
        | "RESPONSE_SCHEMA_MISMATCH"
        | "ACCOUNT_ID_MISSING"
        | "UNTRUSTED_PAGE";
    };

/**
 * Runs inside an already-open Toutiao creator tab via chrome.scripting MAIN
 * world. Keep this function fully self-contained: executeScript serializes the
 * function body and does not carry module closures with it.
 *
 * Only a sanitized account identity or a bounded error enum crosses back to
 * the extension. Raw response text, cookies, headers and exceptions never do.
 */
export async function probeToutiaoAccountInPage(): Promise<ToutiaoPageAccountProbeResult> {
  const expectedOrigin = "https://mp.toutiao.com";
  const accountEndpoint = "https://mp.toutiao.com/mp/agw/media/get_media_info";
  const loginStatusEndpoint =
    "https://mp.toutiao.com/mp/agw/media/user_login_status_api";
  const maxResponseBytes = 1024 * 1024;
  // The extension-level account check has a 10-second budget. Leave enough
  // time for the primary extension probe, tab lookup and result projection.
  const timeoutMs = 5_500;
  const decimalIdPattern = /^[1-9]\d{0,31}$/;
  const maxSafeInteger = BigInt(Number.MAX_SAFE_INTEGER);
  const invalidBodyCode = (
    headers: Headers,
  ): "INVALID_CONTENT_TYPE" | "RESPONSE_SCHEMA_MISMATCH" => {
    const mediaType = headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    return mediaType === "application/json" || mediaType?.endsWith("+json")
      ? "RESPONSE_SCHEMA_MISMATCH"
      : "INVALID_CONTENT_TYPE";
  };
  const readBoundedText = async (
    response: Response,
  ): Promise<string | null> => {
    const declaredLength = response.headers.get("content-length");
    if (
      declaredLength &&
      /^\d+$/.test(declaredLength) &&
      Number(declaredLength) > maxResponseBytes
    ) {
      try {
        await response.body?.cancel();
      } catch {
        // The operation-level abort in finally remains authoritative.
      }
      return null;
    }

    if (!response.body) {
      const text = await response.text();
      return new TextEncoder().encode(text).byteLength <= maxResponseBytes
        ? text
        : null;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let totalBytes = 0;
    let text = "";
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      totalBytes += chunk.value.byteLength;
      if (totalBytes > maxResponseBytes) {
        await reader.cancel();
        return null;
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  };

  if (location.origin !== expectedOrigin) {
    return { ok: false, code: "UNTRUSTED_PAGE" };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(accountEndpoint, {
      method: "GET",
      credentials: "include",
      cache: "no-store",
      redirect: "follow",
      headers: {
        Accept: "application/json",
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      return { ok: false, code: "HTTP_ERROR" };
    }
    if (response.redirected || response.url !== accountEndpoint) {
      return { ok: false, code: "REDIRECTED" };
    }
    const responseText = await readBoundedText(response);
    if (responseText === null || responseText.length === 0) {
      return { ok: false, code: "RESPONSE_SCHEMA_MISMATCH" };
    }

    let normalized = "";
    let index = 0;
    let inString = false;
    let escaped = false;

    while (index < responseText.length) {
      const character = responseText[index];
      if (inString) {
        normalized += character;
        if (escaped) {
          escaped = false;
        } else if (character === "\\") {
          escaped = true;
        } else if (character === '"') {
          inString = false;
        }
        index += 1;
        continue;
      }

      if (character === '"') {
        inString = true;
        normalized += character;
        index += 1;
        continue;
      }

      if (character === "-" || /\d/.test(character)) {
        const match = responseText
          .slice(index)
          .match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
        if (match) {
          const token = match[0];
          let outputToken = token;
          if (/^-?(?:0|[1-9]\d*)$/.test(token)) {
            try {
              const integer = BigInt(token);
              if (integer > maxSafeInteger || integer < -maxSafeInteger) {
                outputToken = JSON.stringify(token);
              }
            } catch {
              // JSON.parse below remains authoritative for malformed JSON.
            }
          }
          normalized += outputToken;
          index += token.length;
          continue;
        }
      }

      normalized += character;
      index += 1;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(normalized);
    } catch {
      return { ok: false, code: invalidBodyCode(response.headers) };
    }

    const asRecord = (value: unknown): Record<string, unknown> | null =>
      value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
    const root = asRecord(payload);
    const data = asRecord(root?.data);
    const user = asRecord(data?.user);
    if (!user) {
      const loginResponse = await fetch(loginStatusEndpoint, {
        method: "GET",
        credentials: "include",
        cache: "no-store",
        redirect: "follow",
        headers: {
          Accept: "application/json",
        },
        signal: controller.signal,
      });
      if (!loginResponse.ok) {
        return { ok: false, code: "HTTP_ERROR" };
      }
      if (
        loginResponse.redirected ||
        loginResponse.url !== loginStatusEndpoint
      ) {
        return { ok: false, code: "REDIRECTED" };
      }
      const loginResponseText = await readBoundedText(loginResponse);
      if (loginResponseText === null || loginResponseText.length === 0) {
        return { ok: false, code: "RESPONSE_SCHEMA_MISMATCH" };
      }

      let loginPayload: unknown;
      try {
        loginPayload = JSON.parse(loginResponseText);
      } catch {
        return { ok: false, code: invalidBodyCode(loginResponse.headers) };
      }
      const loginRoot = asRecord(loginPayload);
      const loginData = asRecord(loginRoot?.data);
      const isLogin = loginData?.is_login ?? loginRoot?.is_login;
      if (isLogin === false || isLogin === 0 || isLogin === "0") {
        return { ok: false, code: "NOT_AUTHENTICATED" };
      }

      // A positive or unknown login-status response without a stable account
      // identity is contract drift, not evidence that the user logged out.
      return { ok: false, code: "RESPONSE_SCHEMA_MISMATCH" };
    }

    const rawUserId = user.id;
    const userId =
      typeof rawUserId === "string"
        ? rawUserId.trim()
        : typeof rawUserId === "number" &&
            Number.isSafeInteger(rawUserId) &&
            rawUserId > 0
          ? String(rawUserId)
          : "";
    if (!decimalIdPattern.test(userId)) {
      return { ok: false, code: "ACCOUNT_ID_MISSING" };
    }

    const username =
      typeof user.screen_name === "string"
        ? user.screen_name.trim().slice(0, 500) || undefined
        : undefined;
    let avatar: string | undefined;
    if (
      typeof user.https_avatar_url === "string" &&
      user.https_avatar_url.length <= 2_000
    ) {
      try {
        const parsedAvatar = new URL(user.https_avatar_url);
        if (
          parsedAvatar.protocol === "https:" &&
          !parsedAvatar.username &&
          !parsedAvatar.password
        ) {
          avatar = parsedAvatar.toString();
        }
      } catch {
        // Avatar is optional and never affects account authentication.
      }
    }

    return {
      ok: true,
      value: {
        userId,
        ...(username ? { username } : {}),
        ...(avatar ? { avatar } : {}),
      },
    };
  } catch {
    return {
      ok: false,
      code: controller.signal.aborted ? "TIMEOUT" : "NETWORK_ERROR",
    };
  } finally {
    controller.abort();
    clearTimeout(timeoutId);
  }
}

export interface ToutiaoDraftIdentity {
  pgcId: string;
}

export interface ToutiaoImageUpload {
  imageUrl: string;
  imageUri: string;
  width: number;
  height: number;
}

export interface ToutiaoDraftListProbe {
  userId: string;
  startCursor?: string;
  endCursor?: string;
  count?: number;
}

export interface ToutiaoDraftFormInput {
  title: string;
  content: string;
  titleId: string;
}

export interface ToutiaoDraftPayload {
  pgc_id: "";
  article_type: 0;
  source: 29;
  extra: string;
  content: string;
  title: string;
  search_creation_info: string;
  title_id: string;
  ic_uri_list: string[];
  appid_list: string[];
  stock_ids: string[];
  concern_list: string[];
  mp_editor_stat: string;
  is_refute_rumor: "0";
  save: 0;
  entrance: "";
  timer_status: 0;
  timer_time: string;
}

export interface ToutiaoDraftDetail {
  pgcId: string;
  title: string;
}

export type ToutiaoPageDraftSaveErrorCode =
  | "FETCH_ERROR"
  | "HTTP_ERROR"
  | "INVALID_REQUEST"
  | "INVALID_RESPONSE"
  | "OUTCOME_UNKNOWN"
  | "PLATFORM_REJECTED"
  | "TRANSPORT_UNAVAILABLE"
  | "UNTRUSTED_PAGE";

export interface ToutiaoDraftSaveDiagnostic {
  transport: "GARR" | "EXTENSION" | "ISOLATED";
  phase: "PREFLIGHT" | "POST" | "CONFIRM";
  httpStatus?: number;
  errorClass?: "ABORT" | "NETWORK" | "TIMEOUT" | "UNKNOWN";
  platformCode?: number;
}

export interface ToutiaoPageDraftSaveFailure {
  ok: false;
  code: ToutiaoPageDraftSaveErrorCode;
  diagnostic?: ToutiaoDraftSaveDiagnostic;
}

export type ToutiaoPageDraftSaveResult =
  | { ok: true; pgcId: string }
  | ToutiaoPageDraftSaveFailure;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function normalizeOptionalText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function normalizeHttpsUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;

  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

function isSuccessCode(value: unknown): boolean {
  return value === 0 || value === "0";
}

/**
 * JSON.parse rounds integer literals larger than Number.MAX_SAFE_INTEGER.
 * Quote only those numeric tokens while they are still lexical source, then
 * parse the otherwise unchanged JSON. Known ID fields can subsequently be
 * validated as decimal strings without relying on field-name regexes.
 */
function parseJsonPreservingLargeIntegers(responseText: string): unknown {
  let normalized = "";
  let index = 0;
  let inString = false;
  let escaped = false;

  while (index < responseText.length) {
    const character = responseText[index];

    if (inString) {
      normalized += character;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      index += 1;
      continue;
    }

    if (character === '"') {
      inString = true;
      normalized += character;
      index += 1;
      continue;
    }

    if (character === "-" || /\d/.test(character)) {
      const match = responseText
        .slice(index)
        .match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);

      if (match) {
        const token = match[0];
        let outputToken = token;

        if (/^-?(?:0|[1-9]\d*)$/.test(token)) {
          try {
            const integer = BigInt(token);
            if (
              integer > MAX_SAFE_INTEGER_BIGINT ||
              integer < -MAX_SAFE_INTEGER_BIGINT
            ) {
              outputToken = JSON.stringify(token);
            }
          } catch {
            // JSON.parse below remains the source of truth for malformed JSON.
          }
        }

        normalized += outputToken;
        index += token.length;
        continue;
      }
    }

    normalized += character;
    index += 1;
  }

  return JSON.parse(normalized);
}

export function normalizeToutiaoId(value: unknown): string | null {
  if (typeof value === "string") {
    const normalized = value.trim();
    return DECIMAL_ID_PATTERN.test(normalized) ? normalized : null;
  }

  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return String(value);
  }

  return null;
}

export function parseToutiaoAccountPayload(
  payload: unknown,
): ToutiaoProtocolResult<ToutiaoAccountIdentity> {
  const root = asRecord(payload);
  const data = asRecord(root?.data);
  const user = asRecord(data?.user);

  if (!user) {
    return { ok: false, code: "AUTHENTICATION_REQUIRED" };
  }

  const userId = normalizeToutiaoId(user.id);
  if (!userId) {
    return { ok: false, code: "INVALID_ACCOUNT_ID" };
  }

  return {
    ok: true,
    value: {
      userId,
      username: normalizeOptionalText(user.screen_name),
      avatar: normalizeHttpsUrl(user.https_avatar_url),
    },
  };
}

export function parseToutiaoAccountResponseText(
  responseText: string,
): ToutiaoProtocolResult<ToutiaoAccountIdentity> {
  if (responseText.length === 0 || responseText.length > MAX_RESPONSE_LENGTH) {
    return { ok: false, code: "INVALID_RESPONSE" };
  }

  try {
    return parseToutiaoAccountPayload(
      parseJsonPreservingLargeIntegers(responseText),
    );
  } catch {
    return { ok: false, code: "INVALID_RESPONSE" };
  }
}

export function parseToutiaoDraftPayload(
  payload: unknown,
): ToutiaoProtocolResult<ToutiaoDraftIdentity> {
  const root = asRecord(payload);
  if (!root) {
    return { ok: false, code: "INVALID_RESPONSE" };
  }

  const resultCode = root.code ?? root.err_no ?? root.errNo;
  if (!isSuccessCode(resultCode)) {
    return { ok: false, code: "PLATFORM_REJECTED" };
  }

  const data = asRecord(root.data);
  if (!data) {
    return { ok: false, code: "INVALID_RESPONSE" };
  }

  const pgcId = normalizeToutiaoId(data.pgc_id ?? data.pgcId);
  if (!pgcId) {
    return { ok: false, code: "INVALID_DRAFT_ID" };
  }

  return { ok: true, value: { pgcId } };
}

/**
 * Parse a bounded raw response while preserving large integer lexemes before
 * JSON.parse can round them.
 */
export function parseToutiaoDraftResponseText(
  responseText: string,
): ToutiaoProtocolResult<ToutiaoDraftIdentity> {
  if (responseText.length === 0 || responseText.length > MAX_RESPONSE_LENGTH) {
    return { ok: false, code: "INVALID_RESPONSE" };
  }

  try {
    return parseToutiaoDraftPayload(
      parseJsonPreservingLargeIntegers(responseText),
    );
  } catch {
    return { ok: false, code: "INVALID_RESPONSE" };
  }
}

export function parseToutiaoDraftDetailPayload(
  payload: unknown,
): ToutiaoProtocolResult<ToutiaoDraftDetail> {
  const root = asRecord(payload);
  if (!root) {
    return { ok: false, code: "INVALID_RESPONSE" };
  }

  const resultCode = root.code ?? root.err_no ?? root.errNo;
  const articlePgc = asRecord(root.article_pgc ?? root.articlePgc);
  if (resultCode !== undefined && !isSuccessCode(resultCode)) {
    return { ok: false, code: "PLATFORM_REJECTED" };
  }
  if (resultCode === undefined && !articlePgc) {
    return { ok: false, code: "INVALID_RESPONSE" };
  }

  const data = asRecord(root.data);
  const article = asRecord(data?.article);
  const detail = article ?? data ?? (articlePgc ? root : null);
  if (!detail) {
    return { ok: false, code: "INVALID_RESPONSE" };
  }

  const rawPgcId =
    detail.pgc_id ??
    detail.pgcId ??
    data?.pgc_id ??
    data?.pgcId ??
    articlePgc?.pgc_id ??
    articlePgc?.pgcId;
  const pgcId = normalizeToutiaoId(rawPgcId);
  if (!pgcId) {
    return { ok: false, code: "INVALID_DRAFT_ID" };
  }

  const title = normalizeOptionalText(detail.title);
  if (!title || [...title].length > 30) {
    return { ok: false, code: "INVALID_RESPONSE" };
  }

  return {
    ok: true,
    value: {
      pgcId,
      title,
    },
  };
}

export function parseToutiaoDraftDetailResponseText(
  responseText: string,
): ToutiaoProtocolResult<ToutiaoDraftDetail> {
  if (responseText.length === 0 || responseText.length > MAX_RESPONSE_LENGTH) {
    return { ok: false, code: "INVALID_RESPONSE" };
  }

  try {
    return parseToutiaoDraftDetailPayload(
      parseJsonPreservingLargeIntegers(responseText),
    );
  } catch {
    return { ok: false, code: "INVALID_RESPONSE" };
  }
}

export function parseToutiaoImagePayload(
  payload: unknown,
): ToutiaoProtocolResult<ToutiaoImageUpload> {
  const root = asRecord(payload);
  if (!root) {
    return { ok: false, code: "INVALID_RESPONSE" };
  }

  if (!isSuccessCode(root.code)) {
    return { ok: false, code: "PLATFORM_REJECTED" };
  }

  const data = asRecord(root.data);
  const imageUrl = normalizeHttpsUrl(data?.image_url);
  const imageUri = normalizeOptionalText(data?.image_uri);
  const width = data?.image_width;
  const height = data?.image_height;

  if (!imageUrl || !imageUri) {
    return { ok: false, code: "INVALID_RESPONSE" };
  }

  return {
    ok: true,
    value: {
      imageUrl,
      imageUri,
      width:
        typeof width === "number" && Number.isSafeInteger(width) && width >= 0
          ? width
          : 0,
      height:
        typeof height === "number" &&
        Number.isSafeInteger(height) &&
        height >= 0
          ? height
          : 0,
    },
  };
}

export function createToutiaoTitleId(
  now = Date.now(),
  random = Math.random(),
): string {
  if (!Number.isSafeInteger(now) || now <= 0) {
    throw new Error("Invalid title timestamp");
  }
  if (!Number.isFinite(random) || random < 0 || random >= 1) {
    throw new Error("Invalid title entropy");
  }

  const entropy = random.toFixed(16).slice(2);

  return `${now}_${entropy}`;
}

function getToutiaoEditorTextLength(content: string): number {
  const decoded = content
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]*>/g, "")
    .replace(
      /&(?:nbsp|amp|lt|gt|quot|apos|#\d{1,7}|#x[\da-f]{1,6});/gi,
      (entity) => {
        const normalized = entity.toLowerCase();
        const named: Record<string, string> = {
          "&nbsp;": " ",
          "&amp;": "&",
          "&lt;": "<",
          "&gt;": ">",
          "&quot;": '"',
          "&apos;": "'",
        };
        if (named[normalized] !== undefined) return named[normalized];

        const numeric = normalized.startsWith("&#x")
          ? Number.parseInt(normalized.slice(3, -1), 16)
          : Number.parseInt(normalized.slice(2, -1), 10);
        try {
          return Number.isInteger(numeric) &&
            numeric >= 0 &&
            numeric <= 0x10ffff
            ? String.fromCodePoint(numeric)
            : entity;
        } catch {
          return entity;
        }
      },
    );
  return decoded.length;
}

function extractToutiaoImageUris(content: string): string[] {
  const imageUris = new Set<string>();
  const attributePattern =
    /\b(?:web_uri|ic-uri)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  let match: RegExpExecArray | null;
  while ((match = attributePattern.exec(content)) !== null) {
    const value = (match[1] ?? match[2] ?? "").trim();
    if (
      value &&
      value.length <= 2_000 &&
      !/[\u0000-\u001f\u007f]/.test(value)
    ) {
      imageUris.add(value);
    }
  }
  return [...imageUris];
}

export function buildToutiaoDraftPayload({
  title,
  content,
  titleId,
}: ToutiaoDraftFormInput): ToutiaoDraftPayload {
  if (!title.trim()) {
    throw new Error("Toutiao draft title is required");
  }
  if ([...title].length > 30) {
    throw new Error("Toutiao draft title is too long");
  }
  if (!/^\d+_\d{1,16}$/.test(titleId)) {
    throw new Error("Invalid Toutiao title ID");
  }
  if (!content || content.length > TOUTIAO_MAX_CONTENT_HTML_LENGTH) {
    throw new Error("Toutiao draft content length is invalid");
  }
  const contentWordCount = getToutiaoEditorTextLength(content);
  if (contentWordCount > TOUTIAO_MAX_CONTENT_TEXT_LENGTH) {
    throw new Error("Toutiao draft text length is invalid");
  }

  return {
    pgc_id: "",
    article_type: 0,
    source: 29,
    extra: JSON.stringify({
      content_source: 100000000402,
      content_word_cnt: contentWordCount,
    }),
    content,
    title,
    search_creation_info: JSON.stringify({
      searchTopOne: 0,
      abstract: "",
      clue_id: "",
    }),
    title_id: titleId,
    ic_uri_list: extractToutiaoImageUris(content),
    appid_list: [],
    stock_ids: [],
    concern_list: [],
    mp_editor_stat: "{}",
    is_refute_rumor: "0",
    save: 0,
    entrance: "",
    timer_status: 0,
    timer_time: "",
  };
}

export function buildToutiaoSaveDraftUrl(abValue: unknown): string {
  const normalizedAbValue =
    typeof abValue === "number" &&
    Number.isSafeInteger(abValue) &&
    abValue >= 0 &&
    abValue <= 9_999
      ? String(abValue)
      : typeof abValue === "string" &&
          /^(?:0|[1-9]\d{0,3})$/.test(abValue.trim())
        ? abValue.trim()
        : "0";
  const url = new URL(TOUTIAO_ENDPOINTS.saveDraft);
  url.searchParams.set("mp_publish_ab_val", normalizedAbValue);
  return url.toString();
}

export function buildToutiaoDraftDetailUrl(pgcId: unknown): string {
  const normalizedPgcId = normalizeToutiaoId(pgcId);
  if (!normalizedPgcId) {
    throw new Error("Invalid Toutiao draft ID");
  }

  const url = new URL(TOUTIAO_ENDPOINTS.draftDetail);
  url.searchParams.set("pgc_id", normalizedPgcId);
  url.searchParams.set("wxstyle", "0");
  url.searchParams.set("format", "json");
  return url.toString();
}

/**
 * Runs inside the current Toutiao graphic-editor tab in chrome.scripting MAIN
 * world. Keep this function self-contained because executeScript serializes it.
 *
 * Toutiao's current draft path uses the page-owned Garr transport. The
 * extension supplies only a strictly shaped draft payload; the fixed endpoint,
 * AB parameter and transport options are resolved inside the trusted page.
 * Raw platform messages, request URLs, headers and exceptions never cross back
 * to the extension.
 */
export async function saveToutiaoDraftInPage(
  payload: ToutiaoDraftPayload,
  transportWaitMs = 5_000,
  postTimeoutMs = 60_000,
): Promise<ToutiaoPageDraftSaveResult> {
  const expectedOrigin = "https://mp.toutiao.com";
  const expectedPathname = "/profile_v4/graphic/publish";
  const saveDraftEndpoint =
    "https://mp.toutiao.com/mp/agw/article/publish?source=mp&type=article&aid=1231";
  const decimalIdPattern = /^[1-9]\d{0,31}$/;
  const expectedPayloadKeys = new Set([
    "pgc_id",
    "article_type",
    "source",
    "extra",
    "content",
    "title",
    "search_creation_info",
    "title_id",
    "ic_uri_list",
    "appid_list",
    "stock_ids",
    "concern_list",
    "mp_editor_stat",
    "is_refute_rumor",
    "save",
    "entrance",
    "timer_status",
    "timer_time",
  ]);
  const asRecord = (value: unknown): Record<string, unknown> | null =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  const normalizePlatformCode = (value: unknown): number | undefined => {
    if (
      typeof value === "number" &&
      Number.isSafeInteger(value) &&
      Math.abs(value) <= 99_999_999
    ) {
      return value;
    }
    if (typeof value === "string" && /^-?\d{1,8}$/.test(value.trim())) {
      const parsed = Number(value);
      return Number.isSafeInteger(parsed) ? parsed : undefined;
    }
    return undefined;
  };
  const normalizeAbValue = (value: unknown): string =>
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 9_999
      ? String(value)
      : typeof value === "string" && /^(?:0|[1-9]\d{0,3})$/.test(value.trim())
        ? value.trim()
        : "0";
  const getHttpStatus = (error: unknown): number | undefined => {
    const errorRecord = asRecord(error);
    const responseRecord = asRecord(errorRecord?.response);
    const candidates = [
      errorRecord?.status,
      errorRecord?.statusCode,
      responseRecord?.status,
      responseRecord?.statusCode,
    ];
    return candidates.find(
      (value): value is number =>
        typeof value === "number" &&
        Number.isInteger(value) &&
        value >= 400 &&
        value <= 599,
    );
  };
  const getErrorClass = (
    error: unknown,
  ): "ABORT" | "NETWORK" | "TIMEOUT" | "UNKNOWN" => {
    const errorRecord = asRecord(error);
    const name =
      error instanceof Error
        ? error.name
        : typeof errorRecord?.name === "string"
          ? errorRecord.name
          : "";
    const code = typeof errorRecord?.code === "string" ? errorRecord.code : "";
    if (/abort/i.test(name) || code === "ERR_CANCELED") return "ABORT";
    if (/timeout/i.test(name) || /TIMED?OUT/i.test(code)) return "TIMEOUT";
    if (
      /network/i.test(name) ||
      name === "TypeError" ||
      code === "ERR_NETWORK"
    ) {
      return "NETWORK";
    }
    return "UNKNOWN";
  };
  const isBoundedStringArray = (
    value: unknown,
    maxItems: number,
  ): value is string[] =>
    Array.isArray(value) &&
    value.length <= maxItems &&
    value.every(
      (item) =>
        typeof item === "string" &&
        item.length > 0 &&
        item.length <= 2_000 &&
        !/[\u0000-\u001f\u007f]/.test(item),
    );
  const extractImageUris = (content: string): string[] => {
    const values = new Set<string>();
    const attributePattern =
      /\b(?:web_uri|ic-uri)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
    let match: RegExpExecArray | null;
    while ((match = attributePattern.exec(content)) !== null) {
      const value = (match[1] ?? match[2] ?? "").trim();
      if (
        value &&
        value.length <= 2_000 &&
        !/[\u0000-\u001f\u007f]/.test(value)
      ) {
        values.add(value);
      }
    }
    return [...values];
  };
  const getEditorTextLength = (content: string): number => {
    const decoded = content
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]*>/g, "")
      .replace(
        /&(?:nbsp|amp|lt|gt|quot|apos|#\d{1,7}|#x[\da-f]{1,6});/gi,
        (entity) => {
          const normalized = entity.toLowerCase();
          const named: Record<string, string> = {
            "&nbsp;": " ",
            "&amp;": "&",
            "&lt;": "<",
            "&gt;": ">",
            "&quot;": '"',
            "&apos;": "'",
          };
          if (named[normalized] !== undefined) return named[normalized];
          const numeric = normalized.startsWith("&#x")
            ? Number.parseInt(normalized.slice(3, -1), 16)
            : Number.parseInt(normalized.slice(2, -1), 10);
          try {
            return Number.isInteger(numeric) &&
              numeric >= 0 &&
              numeric <= 0x10ffff
              ? String.fromCodePoint(numeric)
              : entity;
          } catch {
            return entity;
          }
        },
      );
    return decoded.length;
  };

  if (
    location.origin !== expectedOrigin ||
    location.pathname.replace(/\/+$/, "") !== expectedPathname
  ) {
    return {
      ok: false,
      code: "UNTRUSTED_PAGE",
      diagnostic: { transport: "GARR", phase: "PREFLIGHT" },
    };
  }

  const payloadRecord = asRecord(payload);
  const payloadKeys = payloadRecord ? Object.keys(payloadRecord) : [];
  let extra: Record<string, unknown> | null = null;
  let searchCreationInfo: Record<string, unknown> | null = null;
  let editorStat: Record<string, unknown> | null = null;
  try {
    extra =
      typeof payloadRecord?.extra === "string"
        ? asRecord(JSON.parse(payloadRecord.extra))
        : null;
    searchCreationInfo =
      typeof payloadRecord?.search_creation_info === "string"
        ? asRecord(JSON.parse(payloadRecord.search_creation_info))
        : null;
    editorStat =
      typeof payloadRecord?.mp_editor_stat === "string"
        ? asRecord(JSON.parse(payloadRecord.mp_editor_stat))
        : null;
  } catch {
    // The strict validation below rejects malformed structured fields.
  }
  const expectedWordCount =
    typeof payloadRecord?.content === "string"
      ? getEditorTextLength(payloadRecord.content)
      : -1;
  if (
    !payloadRecord ||
    payloadKeys.length !== expectedPayloadKeys.size ||
    payloadKeys.some((key) => !expectedPayloadKeys.has(key)) ||
    payloadRecord.pgc_id !== "" ||
    payloadRecord.article_type !== 0 ||
    payloadRecord.source !== 29 ||
    payloadRecord.save !== 0 ||
    payloadRecord.entrance !== "" ||
    payloadRecord.timer_status !== 0 ||
    payloadRecord.timer_time !== "" ||
    payloadRecord.is_refute_rumor !== "0" ||
    typeof payloadRecord.title !== "string" ||
    payloadRecord.title.trim().length === 0 ||
    [...payloadRecord.title].length > 30 ||
    typeof payloadRecord.content !== "string" ||
    payloadRecord.content.length === 0 ||
    payloadRecord.content.length > 300_000 ||
    !isBoundedStringArray(payloadRecord.ic_uri_list, 100) ||
    !Array.isArray(payloadRecord.appid_list) ||
    payloadRecord.appid_list.length !== 0 ||
    !Array.isArray(payloadRecord.stock_ids) ||
    payloadRecord.stock_ids.length !== 0 ||
    !Array.isArray(payloadRecord.concern_list) ||
    payloadRecord.concern_list.length !== 0 ||
    JSON.stringify(payloadRecord.ic_uri_list) !==
      JSON.stringify(extractImageUris(payloadRecord.content)) ||
    typeof payloadRecord.extra !== "string" ||
    !extra ||
    Object.keys(extra).length !== 2 ||
    extra.content_source !== 100000000402 ||
    extra.content_word_cnt !== expectedWordCount ||
    expectedWordCount > 150_000 ||
    typeof payloadRecord.search_creation_info !== "string" ||
    !searchCreationInfo ||
    Object.keys(searchCreationInfo).length !== 3 ||
    searchCreationInfo.searchTopOne !== 0 ||
    searchCreationInfo.abstract !== "" ||
    searchCreationInfo.clue_id !== "" ||
    typeof payloadRecord.mp_editor_stat !== "string" ||
    !editorStat ||
    Object.keys(editorStat).length !== 0 ||
    typeof payloadRecord.title_id !== "string" ||
    !/^\d+_\d{1,16}$/.test(payloadRecord.title_id)
  ) {
    return {
      ok: false,
      code: "INVALID_REQUEST",
      diagnostic: { transport: "GARR", phase: "PREFLIGHT" },
    };
  }

  type GarrNetwork = {
    post?: (
      url: string,
      data: Record<string, unknown>,
      options?: { requestId?: string },
    ) => Promise<unknown>;
  };
  type AbTestUtils = {
    getVar?: (key: string, fallback: number) => unknown;
  };
  const pageGlobal = window as typeof window & {
    Garr?: {
      network?: GarrNetwork;
      abTestUtils?: AbTestUtils;
    };
    abTestUtils?: AbTestUtils;
  };
  const waitBudget =
    Number.isInteger(transportWaitMs) &&
    transportWaitMs >= 0 &&
    transportWaitMs <= 10_000
      ? transportWaitMs
      : 0;
  const deadline = Date.now() + waitBudget;
  let network: GarrNetwork | undefined;
  do {
    try {
      network = pageGlobal.Garr?.network;
    } catch {
      network = undefined;
    }
    if (typeof network?.post === "function" || Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (true);

  if (!network || typeof network.post !== "function") {
    return {
      ok: false,
      code: "TRANSPORT_UNAVAILABLE",
      diagnostic: { transport: "GARR", phase: "PREFLIGHT" },
    };
  }

  let abValue = "0";
  const abCandidates: Array<{
    owner: AbTestUtils | undefined;
    getter: AbTestUtils["getVar"];
  }> = [
    {
      owner: pageGlobal.Garr?.abTestUtils,
      getter: pageGlobal.Garr?.abTestUtils?.getVar,
    },
    {
      owner: pageGlobal.abTestUtils,
      getter: pageGlobal.abTestUtils?.getVar,
    },
  ];
  for (const candidate of abCandidates) {
    if (typeof candidate.getter !== "function") continue;
    try {
      abValue = normalizeAbValue(
        await Promise.resolve(
          candidate.getter.call(candidate.owner, "mp_publish", 0),
        ),
      );
      break;
    } catch {
      // The official default is 0. Never expose page exceptions.
    }
  }

  const requestUrl = new URL(saveDraftEndpoint);
  requestUrl.searchParams.set("mp_publish_ab_val", abValue);
  let responsePayload: unknown;
  const boundedPostTimeout =
    Number.isInteger(postTimeoutMs) &&
    postTimeoutMs >= 1 &&
    postTimeoutMs <= 90_000
      ? postTimeoutMs
      : 60_000;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeoutMarker = Symbol("TOUTIAO_POST_TIMEOUT");
    const postPromise = Promise.resolve(
      network.post.call(
        network,
        `${requestUrl.pathname}${requestUrl.search}`,
        payloadRecord,
        { requestId: undefined },
      ),
    );
    const timeoutPromise = new Promise<typeof timeoutMarker>((resolve) => {
      timeoutId = setTimeout(() => resolve(timeoutMarker), boundedPostTimeout);
    });
    const result = await Promise.race([postPromise, timeoutPromise]);
    if (result === timeoutMarker) {
      return {
        ok: false,
        code: "OUTCOME_UNKNOWN",
        diagnostic: {
          transport: "GARR",
          phase: "POST",
          errorClass: "TIMEOUT",
        },
      };
    }
    responsePayload = result;
  } catch (error) {
    const httpStatus = getHttpStatus(error);
    return {
      ok: false,
      code: "OUTCOME_UNKNOWN",
      diagnostic: {
        transport: "GARR",
        phase: "POST",
        ...(httpStatus ? { httpStatus } : {}),
        errorClass: getErrorClass(error),
      },
    };
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }

  const root = asRecord(responsePayload);
  const resultCode = root?.code ?? root?.err_no ?? root?.errNo;
  const isSuccess = resultCode === 0 || resultCode === "0";
  if (!root || resultCode === undefined) {
    return {
      ok: false,
      code: "OUTCOME_UNKNOWN",
      diagnostic: { transport: "GARR", phase: "POST" },
    };
  }
  if (!isSuccess) {
    const platformCode = normalizePlatformCode(resultCode);
    return {
      ok: false,
      code: "PLATFORM_REJECTED",
      diagnostic: {
        transport: "GARR",
        phase: "POST",
        ...(platformCode !== undefined ? { platformCode } : {}),
      },
    };
  }

  const data = asRecord(root.data);
  const rawPgcId = data?.pgc_id ?? data?.pgcId;
  const pgcId =
    typeof rawPgcId === "string"
      ? rawPgcId.trim()
      : typeof rawPgcId === "number" &&
          Number.isSafeInteger(rawPgcId) &&
          rawPgcId > 0
        ? String(rawPgcId)
        : "";
  if (!decimalIdPattern.test(pgcId)) {
    return {
      ok: false,
      code: "OUTCOME_UNKNOWN",
      diagnostic: { transport: "GARR", phase: "POST" },
    };
  }

  return { ok: true, pgcId };
}

/**
 * Confirms the candidate draft from chrome.scripting's ISOLATED world in the
 * same editor tab. Keep this function self-contained: the page must not be
 * able to replace its fetch/parser, and no raw response data may cross back to
 * the extension.
 */
export async function confirmToutiaoDraftInIsolatedWorld(
  pgcId: string,
  expectedTitle: string,
  expectedContent: string,
  timeoutMs = 5_000,
  maxResponseBytes = 1024 * 1024,
): Promise<ToutiaoPageDraftSaveResult> {
  const expectedOrigin = "https://mp.toutiao.com";
  const expectedPathname = "/profile_v4/graphic/publish";
  const decimalIdPattern = /^[1-9]\d{0,31}$/;
  const asRecord = (value: unknown): Record<string, unknown> | null =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  const unknownOutcome = (
    diagnostic?: Omit<ToutiaoDraftSaveDiagnostic, "transport" | "phase">,
  ): ToutiaoPageDraftSaveFailure => ({
    ok: false,
    code: "OUTCOME_UNKNOWN",
    diagnostic: {
      transport: "ISOLATED",
      phase: "CONFIRM",
      ...diagnostic,
    },
  });
  const canonicalizeContent = (value: string): string | null => {
    try {
      const template = document.createElement("template");
      template.innerHTML = value;
      let nodeCount = 0;
      const textParts: string[] = [];
      const media: string[] = [];

      const visit = (node: Node, depth: number): boolean => {
        nodeCount += 1;
        if (nodeCount > 100_000 || depth > 256) return false;
        if (node.nodeType === 3) {
          textParts.push(
            (node.nodeValue ?? "").replace(
              /^\s*[\u200d\ufe0e\ufe0f\u2600-\u27bf\u{1f000}-\u{1faff}]+\s*/u,
              "",
            ),
          );
          return true;
        }
        if (node.nodeType === 8) return true;
        if (node.nodeType !== 1) return false;

        const element = node as Element;
        if (element.localName.toLowerCase() === "img") {
          const stableUri =
            element.getAttribute("web_uri") ??
            element.getAttribute("web-uri") ??
            element.getAttribute("ic_uri") ??
            element.getAttribute("ic-uri");
          const source = element.getAttribute("src");
          if (stableUri?.trim()) {
            media.push(`uri:${stableUri.trim()}`);
          } else if (source?.trim()) {
            try {
              const parsed = new URL(source.trim(), expectedOrigin);
              media.push(`src:${parsed.origin}${parsed.pathname}`);
            } catch {
              media.push(`src:${source.trim().split(/[?#]/, 1)[0]}`);
            }
          } else {
            media.push("img:");
          }
        }
        for (const child of Array.from(element.childNodes)) {
          if (!visit(child, depth + 1)) return false;
        }
        return true;
      };

      for (const child of Array.from(template.content.childNodes)) {
        if (!visit(child, 0)) return null;
      }
      const text = textParts
        .join("")
        .normalize("NFC")
        .replace(/[\u200d\ufe0e\ufe0f]/g, "")
        .replace(/\s+/g, " ")
        .trim();
      return JSON.stringify({ text, media });
    } catch {
      return null;
    }
  };
  const parseJsonPreservingLargeIntegers = (responseText: string): unknown => {
    const maxSafeInteger = BigInt(Number.MAX_SAFE_INTEGER);
    let normalized = "";
    let index = 0;
    let inString = false;
    let escaped = false;

    while (index < responseText.length) {
      const character = responseText[index];
      if (inString) {
        normalized += character;
        if (escaped) {
          escaped = false;
        } else if (character === "\\") {
          escaped = true;
        } else if (character === '"') {
          inString = false;
        }
        index += 1;
        continue;
      }

      if (character === '"') {
        inString = true;
        normalized += character;
        index += 1;
        continue;
      }

      if (character === "-" || /\d/.test(character)) {
        const match = responseText
          .slice(index)
          .match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
        if (match) {
          const token = match[0];
          let outputToken = token;
          if (/^-?(?:0|[1-9]\d*)$/.test(token)) {
            try {
              const integer = BigInt(token);
              if (integer > maxSafeInteger || integer < -maxSafeInteger) {
                outputToken = JSON.stringify(token);
              }
            } catch {
              // JSON.parse below remains authoritative for malformed JSON.
            }
          }
          normalized += outputToken;
          index += token.length;
          continue;
        }
      }

      normalized += character;
      index += 1;
    }

    return JSON.parse(normalized);
  };

  if (
    location.origin !== expectedOrigin ||
    location.pathname.replace(/\/+$/, "") !== expectedPathname ||
    !decimalIdPattern.test(pgcId) ||
    typeof expectedTitle !== "string" ||
    expectedTitle.trim().length === 0 ||
    [...expectedTitle].length > 30 ||
    typeof expectedContent !== "string" ||
    expectedContent.length === 0 ||
    expectedContent.length > 300_000
  ) {
    return unknownOutcome();
  }

  const boundedTimeout =
    Number.isInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 30_000
      ? timeoutMs
      : 5_000;
  const boundedResponseBytes =
    Number.isInteger(maxResponseBytes) &&
    maxResponseBytes >= 1 &&
    maxResponseBytes <= 2 * 1024 * 1024
      ? maxResponseBytes
      : 1024 * 1024;
  const detailUrl = new URL("https://mp.toutiao.com/mp/agw/article/edit");
  detailUrl.searchParams.set("pgc_id", pgcId);
  detailUrl.searchParams.set("wxstyle", "0");
  detailUrl.searchParams.set("format", "json");
  const expectedContentFingerprint = canonicalizeContent(expectedContent);
  if (expectedContentFingerprint === null) return unknownOutcome();
  const normalizeTitle = (value: unknown): string =>
    typeof value === "string"
      ? value
          .normalize("NFC")
          .replace(
            /^\s*[\u200d\ufe0e\ufe0f\u2600-\u27bf\u{1f000}-\u{1faff}]+\s*/u,
            "",
          )
          .replace(/[\u200d\ufe0e\ufe0f]/g, "")
          .replace(/\s+/g, " ")
          .trim()
      : "";
  const expectedTitleFingerprint = normalizeTitle(expectedTitle);
  const retryDelays = [0, 200, 500, 1_000, 1_600, 1_200];
  const deadline = Date.now() + boundedTimeout;
  let lastDiagnostic:
    | Omit<ToutiaoDraftSaveDiagnostic, "transport" | "phase">
    | undefined;

  for (let attempt = 0; attempt < retryDelays.length; attempt += 1) {
    const delay = retryDelays[attempt];
    const beforeDelayRemaining = deadline - Date.now();
    if (beforeDelayRemaining <= 0 || delay >= beforeDelayRemaining) break;
    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    const requestBudget = deadline - Date.now();
    if (requestBudget <= 0) break;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), requestBudget);

    try {
      const response = await fetch(detailUrl.toString(), {
        method: "GET",
        credentials: "include",
        cache: "no-store",
        redirect: "follow",
        headers: {
          Accept: "application/json",
        },
        signal: controller.signal,
      });
      if (response.redirected || response.url !== detailUrl.toString()) {
        return unknownOutcome();
      }
      if (!response.ok) {
        lastDiagnostic =
          response.status >= 400 && response.status <= 599
            ? { httpStatus: response.status }
            : undefined;
        const transientStatus =
          response.status === 404 ||
          response.status === 409 ||
          response.status === 425 ||
          response.status === 429 ||
          response.status >= 500;
        if (transientStatus) continue;
        return unknownOutcome(lastDiagnostic);
      }
      lastDiagnostic = undefined;

      const declaredLength = response.headers.get("content-length");
      if (
        declaredLength &&
        /^\d+$/.test(declaredLength) &&
        Number(declaredLength) > boundedResponseBytes
      ) {
        try {
          await response.body?.cancel();
        } catch {
          // The operation timeout remains authoritative.
        }
        return unknownOutcome();
      }

      let responseText = "";
      if (!response.body) {
        responseText = await response.text();
        if (
          new TextEncoder().encode(responseText).byteLength >
          boundedResponseBytes
        ) {
          return unknownOutcome();
        }
      } else {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let totalBytes = 0;
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          totalBytes += chunk.value.byteLength;
          if (totalBytes > boundedResponseBytes) {
            await reader.cancel();
            return unknownOutcome();
          }
          responseText += decoder.decode(chunk.value, { stream: true });
        }
        responseText += decoder.decode();
      }

      if (!responseText) continue;
      let payload: unknown;
      try {
        payload = parseJsonPreservingLargeIntegers(responseText);
      } catch {
        continue;
      }

      const root = asRecord(payload);
      const articlePgc = asRecord(root?.article_pgc ?? root?.articlePgc);
      const data = asRecord(root?.data);
      const nestedArticle = asRecord(data?.article);
      const resultCode = root?.code ?? root?.err_no ?? root?.errNo;
      if (
        !root ||
        (resultCode !== undefined && resultCode !== 0 && resultCode !== "0")
      ) {
        return unknownOutcome();
      }
      if (!articlePgc && resultCode === undefined) continue;

      const rawPgcId =
        nestedArticle?.pgc_id ??
        nestedArticle?.pgcId ??
        data?.pgc_id ??
        data?.pgcId ??
        root.pgc_id ??
        root.pgcId ??
        articlePgc?.pgc_id ??
        articlePgc?.pgcId;
      const confirmedPgcId =
        typeof rawPgcId === "string"
          ? rawPgcId.trim()
          : typeof rawPgcId === "number" &&
              Number.isSafeInteger(rawPgcId) &&
              rawPgcId > 0
            ? String(rawPgcId)
            : "";
      if (!confirmedPgcId) continue;
      if (confirmedPgcId !== pgcId) return unknownOutcome();

      const rawTitle =
        nestedArticle?.title ?? data?.title ?? root.title ?? articlePgc?.title;
      const rawContent =
        nestedArticle?.content ??
        data?.content ??
        root.content ??
        articlePgc?.content;
      const title = normalizeTitle(rawTitle);
      const content = typeof rawContent === "string" ? rawContent : "";
      if (!title || !content) continue;
      const confirmedContentFingerprint = canonicalizeContent(content);
      if (confirmedContentFingerprint === null) return unknownOutcome();
      if (
        title !== expectedTitleFingerprint ||
        confirmedContentFingerprint !== expectedContentFingerprint
      ) {
        continue;
      }

      return { ok: true, pgcId };
    } catch {
      lastDiagnostic = {
        errorClass: controller.signal.aborted ? "TIMEOUT" : "NETWORK",
      };
    } finally {
      controller.abort();
      clearTimeout(timeoutId);
    }
  }

  return unknownOutcome(lastDiagnostic);
}

export function buildToutiaoDraftUrl(pgcId: string): string {
  const normalizedId = normalizeToutiaoId(pgcId);
  if (!normalizedId) {
    throw new Error("Invalid Toutiao draft ID");
  }

  const url = new URL(TOUTIAO_ROUTES.editor);
  url.searchParams.set("pgc_id", normalizedId);
  return url.toString();
}

export function buildToutiaoDraftListProbeUrl({
  userId,
  startCursor = "0",
  endCursor = "0",
  count = 20,
}: ToutiaoDraftListProbe): string {
  const normalizedUserId = normalizeToutiaoId(userId);
  if (!normalizedUserId) {
    throw new Error("Invalid Toutiao account ID");
  }
  if (!CURSOR_PATTERN.test(startCursor) || !CURSOR_PATTERN.test(endCursor)) {
    throw new Error("Invalid Toutiao draft cursor");
  }
  if (!Number.isInteger(count) || count < 1 || count > 20) {
    throw new Error("Invalid Toutiao draft count");
  }

  const url = new URL(TOUTIAO_SPIKE_ENDPOINTS.draftList);
  url.searchParams.set("end_cursor", endCursor);
  url.searchParams.set("start_cursor", startCursor);
  url.searchParams.set("count", String(count));
  url.searchParams.set("type", "all");
  url.searchParams.set("user_id", normalizedUserId);
  return url.toString();
}

function isPrivateOrReservedIpv4(hostname: string): boolean {
  const parts = hostname.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }

  const [first, second] = parts;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && [0, 88, 168].includes(second)) ||
    (first === 198 && (second === 18 || second === 19 || second === 51)) ||
    (first === 203 && second === 0) ||
    first >= 224
  );
}

export function isSafeToutiaoImageSourceUrl(value: string): boolean {
  if (value.length === 0 || value.length > MAX_DATA_IMAGE_LENGTH) {
    return false;
  }

  if (value.startsWith("data:")) {
    return /^data:image\/(?:png|jpeg|gif|webp);base64,/i.test(value);
  }

  try {
    const url = new URL(value);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.port
    ) {
      return false;
    }

    const hostname = url.hostname.toLowerCase().replace(/\.+$/, "");
    if (
      !hostname.includes(".") ||
      hostname.includes(":") ||
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname.endsWith(".local") ||
      hostname.endsWith(".internal") ||
      hostname.endsWith(".lan") ||
      hostname.endsWith(".home") ||
      hostname.endsWith(".home.arpa") ||
      isPrivateOrReservedIpv4(hostname)
    ) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

export function isSupportedToutiaoImageMime(
  value: string | null | undefined,
): boolean {
  if (!value) return false;
  const mimeType = value.split(";", 1)[0].trim().toLowerCase();
  return SUPPORTED_IMAGE_MIME_TYPES.has(mimeType);
}

export function isTrustedToutiaoPageUrl(value: string | undefined): boolean {
  if (!value) return false;

  try {
    const url = new URL(value);
    return (
      url.origin === "https://mp.toutiao.com" && !url.username && !url.password
    );
  } catch {
    return false;
  }
}

export function isToutiaoEditorPageUrl(value: string | undefined): boolean {
  if (!isTrustedToutiaoPageUrl(value)) return false;

  try {
    const url = new URL(value as string);
    return url.pathname.replace(/\/+$/, "") === "/profile_v4/graphic/publish";
  } catch {
    return false;
  }
}
