const DECIMAL_ID_PATTERN = /^[1-9]\d{0,31}$/;
const CURSOR_PATTERN = /^\d{1,32}$/;
const MAX_RESPONSE_LENGTH = 1024 * 1024;
const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
export const TOUTIAO_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
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
  csrf: "https://mp.toutiao.com/ttwid/check/",
  saveDraft:
    "https://mp.toutiao.com/mp/agw/article/publish?source=mp&type=article&aid=1231",
  uploadImage:
    "https://mp.toutiao.com/spice/image?upload_source=20020002&aid=1231&device_platform=web",
} as const;

/**
 * Creator-center endpoints observed during the protocol spike. They are not
 * called by the production adapter yet; publication inspection remains paused
 * until response fixtures and account-binding semantics are verified.
 */
export const TOUTIAO_SPIKE_ENDPOINTS = {
  loginStatus: "https://mp.toutiao.com/mp/agw/media/user_login_status_api",
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

  if (!isSuccessCode(root.err_no)) {
    return { ok: false, code: "PLATFORM_REJECTED" };
  }

  const data = asRecord(root.data);
  if (!data) {
    return { ok: false, code: "INVALID_RESPONSE" };
  }

  const pgcId = normalizeToutiaoId(data.pgc_id);
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

export function buildToutiaoDraftForm({
  title,
  content,
  titleId,
}: ToutiaoDraftFormInput): URLSearchParams {
  if (!title.trim()) {
    throw new Error("Toutiao draft title is required");
  }
  if (!/^\d+_\d{1,16}$/.test(titleId)) {
    throw new Error("Invalid Toutiao title ID");
  }

  return new URLSearchParams({
    pgc_id: "0",
    source: "29",
    extra: JSON.stringify({
      content_source: 100000000402,
      content_word_cnt: content.length,
      is_multi_title: 0,
      sub_titles: [],
      gd_ext: {
        entrance: "",
        from_page: "publisher_mp",
        enter_from: "PC",
        device_platform: "mp",
        is_message: 0,
      },
    }),
    content,
    title,
    search_creation_info: JSON.stringify({
      searchTopOne: 0,
      abstract: "",
      clue_id: "",
    }),
    title_id: titleId,
    mp_editor_stat: "{}",
    is_refute_rumor: "0",
    save: "0",
    timer_status: "0",
    timer_time: "",
    educluecard: "",
    draft_form_data: JSON.stringify({ coverType: 3 }),
    pgc_feed_covers: "[]",
    article_ad_type: "3",
    is_fans_article: "0",
    govern_forward: "0",
    praise: "0",
    disable_praise: "0",
    tree_plan_article: "0",
    activity_tag: "0",
    trends_writing_tag: "0",
    claim_exclusive: "0",
  });
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
