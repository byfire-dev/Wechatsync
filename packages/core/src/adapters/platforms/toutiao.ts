import { CodeAdapter, type ImageUploadResult } from "../code-adapter";
import type {
  Article,
  AuthProbeErrorCode,
  AuthResult,
  PlatformMeta,
  SyncResult,
} from "../../types";
import type {
  AdapterAccountProbe,
  AdapterOperationContext,
  PublicationPublishedProof,
  PublishOptions,
} from "../types";
import {
  adapterAccountSelectionErrorMessage,
  normalizeAdapterAccountBinding,
  resolveAdapterAccountBinding,
} from "../account-binding";
import { createLogger } from "../../lib/logger";
import { parseMarkdownImages } from "../../lib/markdown-images";
import {
  PublicationInspectionObservationSchema,
  type PublicationInspectionObservation,
  type PublicationInspectionRequest,
} from "../../publication-inspection/domain";
import {
  TOUTIAO_ANONYMOUS_BLOCKED_REASONS,
  TOUTIAO_ANONYMOUS_HTTP_404_REASON,
  TOUTIAO_ANONYMOUS_SOFT_404_REASON,
  TOUTIAO_PUBLIC_PAGE_MAX_BYTES,
  TOUTIAO_PUBLISHED_LIST_URL,
  isToutiaoHtmlContentType,
  isToutiaoSoft404Html,
  normalizeToutiaoPublicArticleUrl,
  parseToutiaoPublicArticleHtml,
  resolveToutiaoPgcId,
  scanToutiaoPublishedListInPage,
  validateToutiaoPublishedListScanResult,
  type ToutiaoPublicArticleHtmlResult,
  type ToutiaoPublishedListScanResult,
} from "../../publication-inspection/toutiao";
import {
  discardResponseBody,
  fetchWithValidatedNoRedirects,
  readBoundedResponseText,
} from "../../lib/safe-http";
import {
  TOUTIAO_ENDPOINTS,
  TOUTIAO_MAX_IMAGE_BYTES,
  TOUTIAO_MAX_RESPONSE_BYTES,
  TOUTIAO_ROUTES,
  buildToutiaoDraftPayload,
  buildToutiaoDraftUrl,
  createToutiaoTitleId,
  isSafeToutiaoImageSourceUrl,
  isSupportedToutiaoImageMime,
  isToutiaoEditorPageUrl,
  isTrustedToutiaoPageUrl,
  normalizeToutiaoId,
  parseToutiaoAccountResponseText,
  parseToutiaoImagePayload,
  probeToutiaoAccountInPage,
  saveToutiaoDraftInPage,
  type ToutiaoAccountIdentity,
  type ToutiaoDraftPayload,
  type ToutiaoPageAccountProbeResult,
  type ToutiaoPageDraftSaveFailure,
  type ToutiaoPageDraftSaveResult,
} from "./toutiao-protocol";

const logger = createLogger("Toutiao");

class ToutiaoAdapterError extends Error {}

type ToutiaoPublicPageFetchResult =
  | {
      success: true;
      article: Extract<ToutiaoPublicArticleHtmlResult, { success: true }>;
    }
  | {
      success: false;
      anonymousNotFound: boolean;
      blockedReasonCode?: (typeof TOUTIAO_ANONYMOUS_BLOCKED_REASONS)[number];
      outcome: "FETCH_ERROR" | "REVIEW_REQUIRED";
      errorCode: string;
      errorMessage: string;
    };

function classifyToutiaoInvalidBody(
  contentType: string | null,
): AuthProbeErrorCode {
  const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "application/json" || mediaType?.endsWith("+json")
    ? "RESPONSE_SCHEMA_MISMATCH"
    : "INVALID_CONTENT_TYPE";
}

async function readBoundedToutiaoResponseText(
  response: Response,
  maxBytes = TOUTIAO_MAX_RESPONSE_BYTES,
): Promise<string | null> {
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength &&
    /^\d+$/.test(declaredLength) &&
    Number(declaredLength) > maxBytes
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
    return new TextEncoder().encode(text).byteLength <= maxBytes ? text : null;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = "";

  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    totalBytes += chunk.value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      return null;
    }
    text += decoder.decode(chunk.value, { stream: true });
  }

  return text + decoder.decode();
}

export class ToutiaoAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: "toutiao",
    name: "头条",
    icon: "https://mp.toutiao.com/favicon.ico",
    homepage: TOUTIAO_ROUTES.editor,
    capabilities: [
      "article",
      "draft",
      "image_upload",
      "cover",
      "account_binding",
    ],
  };

  readonly preprocessConfig = {
    outputFormat: "html" as const,
    removeLinks: true,
    removeEmptyImages: true,
    removeDataAttributes: true,
    flattenNestedBold: true,
    unwrapSingleChildSpans: true,
  };

  private readonly HEADER_RULES = [
    {
      urlFilter: "*://mp.toutiao.com/*",
      headers: {
        Origin: "https://mp.toutiao.com",
        Referer: TOUTIAO_ROUTES.editor,
      },
      resourceTypes: ["xmlhttprequest"],
    },
  ];

  private authFailure(
    code: AuthProbeErrorCode,
    source: "EXTENSION" | "MAIN_WORLD",
    primaryErrorCode?: AuthProbeErrorCode,
  ): AuthResult {
    const error =
      code === "PAGE_CONTEXT_UNAVAILABLE"
        ? "请打开头条创作中心并确认登录后重试"
        : code === "TIMEOUT"
          ? "头条账号状态检测超时，请稍后重试"
          : "头条账号状态读取失败，请确认已登录后重试";

    return {
      isAuthenticated: false,
      error,
      probeStatus: "PROBE_FAILED",
      probeSource: source,
      probeErrorCode: code,
      ...(primaryErrorCode ? { primaryProbeErrorCode: primaryErrorCode } : {}),
    };
  }

  private unauthenticated(
    source: "EXTENSION" | "MAIN_WORLD",
    primaryErrorCode?: AuthProbeErrorCode,
  ): AuthResult {
    return {
      isAuthenticated: false,
      probeStatus: "NOT_AUTHENTICATED",
      probeSource: source,
      ...(primaryErrorCode ? { primaryProbeErrorCode: primaryErrorCode } : {}),
    };
  }

  private authenticated(
    account: ToutiaoAccountIdentity,
    source: "EXTENSION" | "MAIN_WORLD",
    primaryErrorCode?: AuthProbeErrorCode,
  ): AuthResult {
    return {
      isAuthenticated: true,
      userId: account.userId,
      username: account.username,
      avatar: account.avatar,
      probeStatus: "AUTHENTICATED",
      probeSource: source,
      ...(primaryErrorCode ? { primaryProbeErrorCode: primaryErrorCode } : {}),
    };
  }

  private async probeAccountInExtension(
    context?: AdapterOperationContext,
  ): Promise<AuthResult> {
    context?.signal?.throwIfAborted();
    const controller = new AbortController();
    const abortFromContext = () => controller.abort();
    context?.signal?.addEventListener("abort", abortFromContext, {
      once: true,
    });
    const timeoutId = setTimeout(() => controller.abort(), 3_000);
    try {
      return await this.withHeaderRules(this.HEADER_RULES, async () => {
        const response = await this.runtime.fetch(TOUTIAO_ENDPOINTS.account, {
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
          return this.authFailure("HTTP_ERROR", "EXTENSION");
        }

        if (response.redirected || response.url !== TOUTIAO_ENDPOINTS.account) {
          return this.authFailure("REDIRECTED", "EXTENSION");
        }
        const responseText = await readBoundedToutiaoResponseText(response);
        if (responseText === null || responseText.length === 0) {
          return this.authFailure("RESPONSE_SCHEMA_MISMATCH", "EXTENSION");
        }
        const parsed = parseToutiaoAccountResponseText(responseText);
        if (!parsed.ok) {
          if (parsed.code === "INVALID_RESPONSE") {
            return this.authFailure(
              classifyToutiaoInvalidBody(response.headers.get("content-type")),
              "EXTENSION",
            );
          }
          if (parsed.code === "AUTHENTICATION_REQUIRED") {
            return this.unauthenticated("EXTENSION");
          }
          return this.authFailure(
            parsed.code === "INVALID_ACCOUNT_ID"
              ? "ACCOUNT_ID_MISSING"
              : "RESPONSE_SCHEMA_MISMATCH",
            "EXTENSION",
          );
        }

        return this.authenticated(parsed.value, "EXTENSION");
      });
    } catch {
      context?.signal?.throwIfAborted();
      logger.debug("Extension account status request failed");
      return this.authFailure(
        controller.signal.aborted ? "TIMEOUT" : "NETWORK_ERROR",
        "EXTENSION",
      );
    } finally {
      controller.abort();
      clearTimeout(timeoutId);
      context?.signal?.removeEventListener("abort", abortFromContext);
    }
  }

  private normalizePageAccountProbe(
    result: ToutiaoPageAccountProbeResult | undefined,
    primary: AuthResult,
  ): AuthResult {
    const primaryErrorCode = primary.probeErrorCode;
    if (!result || typeof result !== "object") {
      return this.authFailure(
        "RESPONSE_SCHEMA_MISMATCH",
        "MAIN_WORLD",
        primaryErrorCode,
      );
    }

    if (result.ok) {
      const userId = normalizeToutiaoId(result.value?.userId);
      if (!userId) {
        return this.authFailure(
          "ACCOUNT_ID_MISSING",
          "MAIN_WORLD",
          primaryErrorCode,
        );
      }

      const username =
        typeof result.value.username === "string"
          ? result.value.username.trim().slice(0, 500) || undefined
          : undefined;
      let avatar: string | undefined;
      if (
        typeof result.value.avatar === "string" &&
        result.value.avatar.length <= 2_000
      ) {
        try {
          const parsedAvatar = new URL(result.value.avatar);
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

      return this.authenticated(
        {
          userId,
          ...(username ? { username } : {}),
          ...(avatar ? { avatar } : {}),
        },
        "MAIN_WORLD",
        primaryErrorCode,
      );
    }

    if (result.code === "NOT_AUTHENTICATED") {
      return this.unauthenticated("MAIN_WORLD", primaryErrorCode);
    }

    const safeFailureCodes = new Set<AuthProbeErrorCode>([
      "TIMEOUT",
      "NETWORK_ERROR",
      "HTTP_ERROR",
      "REDIRECTED",
      "INVALID_CONTENT_TYPE",
      "RESPONSE_SCHEMA_MISMATCH",
      "ACCOUNT_ID_MISSING",
      "UNTRUSTED_PAGE",
    ]);
    return this.authFailure(
      safeFailureCodes.has(result.code)
        ? (result.code as AuthProbeErrorCode)
        : "UNKNOWN_ERROR",
      "MAIN_WORLD",
      primaryErrorCode,
    );
  }

  private async probeAccountInMainWorld(
    primary: AuthResult,
    context?: AdapterOperationContext,
  ): Promise<AuthResult> {
    context?.signal?.throwIfAborted();
    if (!this.runtime.tabs) {
      return this.authFailure(
        "PAGE_CONTEXT_UNAVAILABLE",
        "MAIN_WORLD",
        primary.probeErrorCode,
      );
    }

    try {
      const tabs = await this.runtime.tabs.query("https://mp.toutiao.com/*");
      const trustedTab = tabs.find(
        (tab) => Number.isInteger(tab.id) && isTrustedToutiaoPageUrl(tab.url),
      );
      if (!trustedTab) {
        return this.authFailure(
          "PAGE_CONTEXT_UNAVAILABLE",
          "MAIN_WORLD",
          primary.probeErrorCode,
        );
      }

      const result = await this.runtime.tabs.executeScript<
        ToutiaoPageAccountProbeResult | undefined,
        []
      >(trustedTab.id, probeToutiaoAccountInPage, []);
      context?.signal?.throwIfAborted();
      return this.normalizePageAccountProbe(result, primary);
    } catch {
      context?.signal?.throwIfAborted();
      logger.debug("MAIN-world account status request failed");
      return this.authFailure(
        "UNKNOWN_ERROR",
        "MAIN_WORLD",
        primary.probeErrorCode,
      );
    }
  }

  async checkAuth(context?: AdapterOperationContext): Promise<AuthResult> {
    const primary = await this.probeAccountInExtension(context);
    if (primary.isAuthenticated) {
      return primary;
    }

    return this.probeAccountInMainWorld(primary, context);
  }

  async probeAccounts(
    context?: AdapterOperationContext,
  ): Promise<AdapterAccountProbe> {
    const auth = await this.checkAuth(context);
    if (!auth.isAuthenticated) {
      return auth.probeStatus === "NOT_AUTHENTICATED"
        ? { status: "NOT_AUTHENTICATED", accounts: [] }
        : {
            status: "PROBE_FAILED",
            accounts: [],
            errorCode: auth.probeErrorCode ?? "UNKNOWN_ERROR",
          };
    }

    const externalAccountId = normalizeToutiaoId(auth.userId);
    const displayName =
      typeof auth.username === "string"
        ? auth.username.replace(/\s+/g, " ").trim()
        : "";
    if (
      !externalAccountId ||
      displayName.length === 0 ||
      displayName.length > 500
    ) {
      return {
        status: "PROBE_FAILED",
        accounts: [],
        errorCode: externalAccountId
          ? "RESPONSE_SCHEMA_MISMATCH"
          : "ACCOUNT_ID_MISSING",
      };
    }

    return {
      status: "AUTHENTICATED",
      accounts: [
        {
          externalAccountId,
          displayName,
          ...(auth.avatar ? { avatarUrl: auth.avatar } : {}),
        },
      ],
    };
  }

  private createInspectionError(
    request: PublicationInspectionRequest,
    outcome:
      | "ACCOUNT_MISMATCH"
      | "LOGIN_REQUIRED"
      | "UNSUPPORTED"
      | "FETCH_ERROR"
      | "PARSE_ERROR"
      | "REVIEW_REQUIRED",
    errorCode: string,
    errorMessage: string,
    platformPostId?: string,
    source: PublicationInspectionObservation["source"] = "PUBLISHED_LIST",
    publicItemId?: string,
  ): PublicationInspectionObservation {
    return PublicationInspectionObservationSchema.parse({
      observationKey: `toutiao:${request.requestId}:${source
        .toLowerCase()
        .replace(/_/g, "-")}`,
      platform: "toutiao",
      externalAccountId: request.externalAccountId,
      outcome,
      source,
      ...(platformPostId ? { platformPostId } : {}),
      observedAt: new Date().toISOString(),
      errorCode,
      errorMessage,
      ...(publicItemId ? { internalEvidence: { publicItemId } } : {}),
    });
  }

  private async scanPublishedList(
    pgcId: string,
    expectedTitle: string,
    limit: number,
    context?: AdapterOperationContext,
  ): Promise<ToutiaoPublishedListScanResult> {
    const tabs = this.runtime.tabs;
    if (!tabs?.remove) {
      return {
        success: false,
        errorCode: "TOUTIAO_PUBLISHED_DOM_UNAVAILABLE",
      };
    }

    let createdTabId: number | undefined;
    const raceWithAbort = async <T>(operation: Promise<T>): Promise<T> => {
      const signal = context?.signal;
      if (!signal) return operation;
      signal.throwIfAborted();
      return new Promise<T>((resolve, reject) => {
        const abort = () =>
          reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
        signal.addEventListener("abort", abort, { once: true });
        operation.then(
          (value) => {
            signal.removeEventListener("abort", abort);
            resolve(value);
          },
          (error) => {
            signal.removeEventListener("abort", abort);
            reject(error);
          },
        );
      });
    };
    try {
      context?.signal?.throwIfAborted();
      const tab = await tabs.create(TOUTIAO_PUBLISHED_LIST_URL, false);
      createdTabId = tab.id;
      context?.signal?.throwIfAborted();
      await raceWithAbort(tabs.waitForLoad(tab.id, 30_000));
      context?.signal?.throwIfAborted();
      const result = await raceWithAbort(
        tabs.executeScript<
          ToutiaoPublishedListScanResult | undefined,
          [string, string, number, number]
        >(
          tab.id,
          scanToutiaoPublishedListInPage,
          [pgcId, expectedTitle, limit, 10_000],
          { world: "ISOLATED" },
        ),
      );
      context?.signal?.throwIfAborted();
      return (
        validateToutiaoPublishedListScanResult(result, pgcId) ?? {
          success: false,
          errorCode: "TOUTIAO_PUBLISHED_SCAN_INVALID",
        }
      );
    } catch {
      context?.signal?.throwIfAborted();
      return {
        success: false,
        errorCode: "TOUTIAO_PUBLISHED_DOM_UNAVAILABLE",
      };
    } finally {
      if (createdTabId !== undefined) {
        try {
          await tabs.remove(createdTabId);
        } catch {
          // The inspection result stays fail-closed if Chrome already removed
          // the short-lived background tab.
        }
      }
    }
  }

  private async fetchPublicArticlePage(
    publicArticleUrl: string,
    publicItemId: string,
    displayName: string,
    credentials: "omit" | "include",
    context?: AdapterOperationContext,
  ): Promise<ToutiaoPublicPageFetchResult> {
    context?.signal?.throwIfAborted();
    const fetched = await fetchWithValidatedNoRedirects({
      fetch: (url, options) => this.runtime.fetch(url, options),
      initialUrl: publicArticleUrl,
      validateUrl: (url) => normalizeToutiaoPublicArticleUrl(url, publicItemId),
      request: {
        method: "GET",
        credentials,
        cache: "no-store",
        signal: context?.signal,
        headers: {
          Accept: "text/html,application/xhtml+xml",
        },
      },
    });
    if (!fetched.success) {
      context?.signal?.throwIfAborted();
      return {
        success: false,
        anonymousNotFound: false,
        outcome: "FETCH_ERROR",
        errorCode: "TOUTIAO_PUBLIC_PAGE_FETCH_ERROR",
        errorMessage: "The Toutiao public-page request failed.",
      };
    }

    const response = fetched.response;
    if (response.status === 404) {
      await discardResponseBody(response);
      return {
        success: false,
        anonymousNotFound: credentials === "omit",
        ...(credentials === "omit"
          ? { blockedReasonCode: TOUTIAO_ANONYMOUS_HTTP_404_REASON }
          : {}),
        outcome: "REVIEW_REQUIRED",
        errorCode:
          credentials === "omit"
            ? TOUTIAO_ANONYMOUS_HTTP_404_REASON
            : "TOUTIAO_AUTHENTICATED_HTTP_404",
        errorMessage:
          credentials === "omit"
            ? "The anonymous Toutiao page returned HTTP 404."
            : "The authenticated Toutiao page returned HTTP 404.",
      };
    }
    if (!response.ok) {
      await discardResponseBody(response);
      return {
        success: false,
        anonymousNotFound: false,
        outcome: "REVIEW_REQUIRED",
        errorCode: "TOUTIAO_PUBLIC_PAGE_HTTP_ERROR",
        errorMessage: `The Toutiao public page returned HTTP ${response.status}.`,
      };
    }
    if (!isToutiaoHtmlContentType(response.headers)) {
      await discardResponseBody(response);
      return {
        success: false,
        anonymousNotFound: false,
        outcome: "REVIEW_REQUIRED",
        errorCode: "TOUTIAO_PUBLIC_CONTENT_TYPE_INVALID",
        errorMessage: "The Toutiao public page did not return HTML.",
      };
    }

    const body = await readBoundedResponseText(
      response,
      TOUTIAO_PUBLIC_PAGE_MAX_BYTES,
    );
    if (!body.success) {
      context?.signal?.throwIfAborted();
      return {
        success: false,
        anonymousNotFound: false,
        outcome: "REVIEW_REQUIRED",
        errorCode:
          body.errorCode === "SAFE_RESPONSE_BODY_TOO_LARGE"
            ? "TOUTIAO_PUBLIC_BODY_TOO_LARGE"
            : "TOUTIAO_PUBLIC_BODY_READ_ERROR",
        errorMessage: "The Toutiao public-page body could not be verified.",
      };
    }

    if (isToutiaoSoft404Html(body.text)) {
      return {
        success: false,
        anonymousNotFound: credentials === "omit",
        ...(credentials === "omit"
          ? { blockedReasonCode: TOUTIAO_ANONYMOUS_SOFT_404_REASON }
          : {}),
        outcome: "REVIEW_REQUIRED",
        errorCode:
          credentials === "omit"
            ? TOUTIAO_ANONYMOUS_SOFT_404_REASON
            : "TOUTIAO_AUTHENTICATED_SOFT_404",
        errorMessage:
          credentials === "omit"
            ? "The anonymous Toutiao page returned its not-found shell."
            : "The authenticated Toutiao page returned its not-found shell.",
      };
    }

    const article = parseToutiaoPublicArticleHtml(
      body.text,
      publicItemId,
      displayName,
    );
    if (!article.success) {
      return {
        success: false,
        anonymousNotFound: false,
        outcome: "REVIEW_REQUIRED",
        errorCode: article.errorCode,
        errorMessage: "The Toutiao public article evidence was incomplete.",
      };
    }

    return { success: true, article };
  }

  async inspectPublication(
    request: PublicationInspectionRequest,
    context?: AdapterOperationContext,
  ): Promise<PublicationInspectionObservation[]> {
    context?.signal?.throwIfAborted();
    if (request.platform !== "toutiao") {
      return [
        this.createInspectionError(
          request,
          "UNSUPPORTED",
          "TOUTIAO_PLATFORM_REQUIRED",
          "This inspector only supports Toutiao.",
        ),
      ];
    }

    const pgcResolution = resolveToutiaoPgcId(
      request.draft.platformPostId,
      request.draft.draftUrl,
    );
    if (!pgcResolution.success) {
      return [
        this.createInspectionError(
          request,
          "PARSE_ERROR",
          pgcResolution.errorCode,
          "The Toutiao draft identity is missing or inconsistent.",
        ),
      ];
    }
    const pgcId = pgcResolution.pgcId;

    let probe: AdapterAccountProbe;
    try {
      probe = await this.probeAccounts(context);
    } catch {
      context?.signal?.throwIfAborted();
      return [
        this.createInspectionError(
          request,
          "FETCH_ERROR",
          "TOUTIAO_ACCOUNT_PROBE_FAILED",
          "The Toutiao account could not be verified.",
          pgcId,
        ),
      ];
    }
    const selection = resolveAdapterAccountBinding(probe, {
      externalAccountId: request.externalAccountId,
    });
    if (!selection.ok) {
      const isLoggedOut = selection.errorCode === "ACCOUNT_NOT_AUTHENTICATED";
      const isMismatch = selection.errorCode === "ACCOUNT_BINDING_NOT_FOUND";
      return [
        this.createInspectionError(
          request,
          isLoggedOut
            ? "LOGIN_REQUIRED"
            : isMismatch
              ? "ACCOUNT_MISMATCH"
              : "FETCH_ERROR",
          isLoggedOut
            ? "TOUTIAO_LOGIN_REQUIRED"
            : isMismatch
              ? "TOUTIAO_ACCOUNT_MISMATCH"
              : "TOUTIAO_ACCOUNT_PROBE_FAILED",
          isLoggedOut
            ? "Log in to Toutiao before inspecting this publication."
            : isMismatch
              ? "The active Toutiao account does not match the bound account."
              : "The Toutiao account could not be verified.",
          pgcId,
        ),
      ];
    }

    const scan = await this.scanPublishedList(
      pgcId,
      request.articleHint.title,
      request.limit,
      context,
    );
    if (!scan.success) {
      return [
        this.createInspectionError(
          request,
          "REVIEW_REQUIRED",
          scan.errorCode,
          "The Toutiao published list could not be verified completely.",
          pgcId,
        ),
      ];
    }
    if (scan.match === "REVIEW_REQUIRED") {
      return [
        this.createInspectionError(
          request,
          "REVIEW_REQUIRED",
          scan.errorCode,
          "The Toutiao published-list evidence requires manual review.",
          pgcId,
        ),
      ];
    }
    if (scan.match === "NOT_FOUND") {
      return [
        PublicationInspectionObservationSchema.parse({
          observationKey: `toutiao:${request.requestId}:published-list`,
          platform: "toutiao",
          externalAccountId: request.externalAccountId,
          outcome: "NOT_FOUND",
          source: "PUBLISHED_LIST",
          platformPostId: pgcId,
          observedAt: new Date().toISOString(),
          internalEvidence: { scanComplete: true },
        }),
      ];
    }

    const anonymousPage = await this.fetchPublicArticlePage(
      scan.publicArticleUrl,
      scan.publicItemId,
      selection.account.displayName,
      "omit",
      context,
    );
    let page = anonymousPage;
    let source: "PUBLIC_PAGE" | "AUTHENTICATED_PUBLIC_PAGE" = "PUBLIC_PAGE";
    let blockedReasonCode:
      | (typeof TOUTIAO_ANONYMOUS_BLOCKED_REASONS)[number]
      | undefined;
    if (!anonymousPage.success && anonymousPage.anonymousNotFound) {
      blockedReasonCode = anonymousPage.blockedReasonCode;
      if (!blockedReasonCode) {
        return [
          this.createInspectionError(
            request,
            "REVIEW_REQUIRED",
            "TOUTIAO_ANONYMOUS_BLOCK_REASON_MISSING",
            "The anonymous Toutiao access result was incomplete.",
            pgcId,
            "PUBLIC_PAGE",
            scan.publicItemId,
          ),
        ];
      }
      page = await this.fetchPublicArticlePage(
        scan.publicArticleUrl,
        scan.publicItemId,
        selection.account.displayName,
        "include",
        context,
      );
      source = "AUTHENTICATED_PUBLIC_PAGE";
    }
    if (!page.success) {
      return [
        this.createInspectionError(
          request,
          page.outcome,
          page.errorCode,
          page.errorMessage,
          pgcId,
          source,
          scan.publicItemId,
        ),
      ];
    }

    const expectedTitle = request.articleHint.title.replace(/\s+/g, " ").trim();
    if (page.article.title !== expectedTitle) {
      return [
        this.createInspectionError(
          request,
          "REVIEW_REQUIRED",
          "TOUTIAO_PUBLIC_TITLE_MISMATCH",
          "The Toutiao public article title does not match the requested article.",
          pgcId,
          source,
          scan.publicItemId,
        ),
      ];
    }
    const publishedAt = Date.parse(page.article.publishedAt);
    const publishedAfter = request.articleHint.publishedAfter
      ? Date.parse(request.articleHint.publishedAfter)
      : undefined;
    const publishedBefore = request.articleHint.publishedBefore
      ? Date.parse(request.articleHint.publishedBefore)
      : undefined;
    if (
      (publishedAfter !== undefined && publishedAt < publishedAfter) ||
      (publishedBefore !== undefined && publishedAt > publishedBefore)
    ) {
      return [
        this.createInspectionError(
          request,
          "REVIEW_REQUIRED",
          "TOUTIAO_PUBLIC_TIME_MISMATCH",
          "The Toutiao publication time is outside the requested inspection window.",
          pgcId,
          source,
          scan.publicItemId,
        ),
      ];
    }

    return [
      PublicationInspectionObservationSchema.parse({
        observationKey: `toutiao:${request.requestId}:public-page`,
        platform: "toutiao",
        externalAccountId: request.externalAccountId,
        outcome: "PUBLISHED",
        source,
        platformPostId: pgcId,
        canonicalUrl: page.article.canonicalUrl,
        title: page.article.title,
        publishedAt: page.article.publishedAt,
        bodyText: page.article.bodyText,
        bodyTruncated: page.article.bodyTruncated,
        publicAccess:
          source === "PUBLIC_PAGE"
            ? { status: "CONFIRMED" }
            : {
                status: "BLOCKED_BY_PLATFORM",
                reasonCode: blockedReasonCode,
              },
        observedAt: new Date().toISOString(),
        internalEvidence: {
          publicItemId: scan.publicItemId,
          ...(scan.scanComplete ? { scanComplete: true } : {}),
        },
      }),
    ];
  }

  provePublishedObservation(
    request: PublicationInspectionRequest,
    observation: PublicationInspectionObservation,
  ): PublicationPublishedProof | null {
    const pgcResolution = resolveToutiaoPgcId(
      request.draft.platformPostId,
      request.draft.draftUrl,
    );
    const publicItemId = observation.internalEvidence?.publicItemId;
    const canonicalUrl =
      observation.canonicalUrl && publicItemId
        ? normalizeToutiaoPublicArticleUrl(
            observation.canonicalUrl,
            publicItemId,
          )
        : null;
    const normalizedObservedTitle = observation.title
      ?.replace(/\s+/g, " ")
      .trim();
    const normalizedRequestedTitle = request.articleHint.title
      .replace(/\s+/g, " ")
      .trim();
    const publishedAt = observation.publishedAt
      ? Date.parse(observation.publishedAt)
      : Number.NaN;
    const publishedAfter = request.articleHint.publishedAfter
      ? Date.parse(request.articleHint.publishedAfter)
      : undefined;
    const publishedBefore = request.articleHint.publishedBefore
      ? Date.parse(request.articleHint.publishedBefore)
      : undefined;
    if (
      request.platform !== "toutiao" ||
      observation.platform !== "toutiao" ||
      observation.externalAccountId !== request.externalAccountId ||
      !pgcResolution.success ||
      observation.outcome !== "PUBLISHED" ||
      observation.platformPostId !== pgcResolution.pgcId ||
      !publicItemId ||
      !normalizeToutiaoId(publicItemId) ||
      canonicalUrl !== observation.canonicalUrl ||
      !observation.publishedAt ||
      normalizedObservedTitle !== normalizedRequestedTitle ||
      !Number.isFinite(publishedAt) ||
      (publishedAfter !== undefined && publishedAt < publishedAfter) ||
      (publishedBefore !== undefined && publishedAt > publishedBefore) ||
      !observation.bodyText?.trim() ||
      typeof observation.bodyTruncated !== "boolean" ||
      observation.errorCode !== undefined ||
      observation.errorMessage !== undefined
    ) {
      return null;
    }

    const publicAccess = observation.publicAccess;
    const hasValidPublicEvidence =
      (observation.source === "PUBLIC_PAGE" &&
        publicAccess?.status === "CONFIRMED") ||
      (observation.source === "AUTHENTICATED_PUBLIC_PAGE" &&
        publicAccess?.status === "BLOCKED_BY_PLATFORM" &&
        (publicAccess.reasonCode === TOUTIAO_ANONYMOUS_HTTP_404_REASON ||
          publicAccess.reasonCode === TOUTIAO_ANONYMOUS_SOFT_404_REASON));
    if (!hasValidPublicEvidence || !publicAccess) return null;

    return {
      observedAuthorExternalAccountId: observation.externalAccountId,
      publicAccess,
      bodyTruncated: observation.bodyTruncated,
    };
  }

  async publish(
    article: Article,
    options?: PublishOptions,
  ): Promise<SyncResult> {
    const requestedBinding =
      options?.accountBinding === undefined
        ? undefined
        : normalizeAdapterAccountBinding(options.accountBinding);
    let operationExternalAccountId = requestedBinding?.externalAccountId;

    if (options?.draftOnly === false) {
      return this.createResult(false, {
        ...(operationExternalAccountId
          ? { externalAccountId: operationExternalAccountId }
          : {}),
        error: "头条适配器当前仅允许保存草稿，不支持直接发布",
      });
    }

    try {
      const selection = resolveAdapterAccountBinding(
        await this.probeAccounts(),
        options?.accountBinding,
      );
      if (!selection.ok) {
        return this.createResult(false, {
          ...(operationExternalAccountId
            ? { externalAccountId: operationExternalAccountId }
            : {}),
          errorCode: selection.errorCode,
          error: adapterAccountSelectionErrorMessage(selection.errorCode),
        });
      }
      operationExternalAccountId = selection.account.externalAccountId;

      let content = article.html || article.markdown || "";
      content = content
        .replace(/<figure[^>]*>\s*<\/figure>/gi, "")
        .replace(/\n{3,}/g, "\n\n");

      this.assertSafeImageSources(content);
      content = await this.withHeaderRules(this.HEADER_RULES, () =>
        this.processImages(content, (src) => this.uploadImageByUrl(src), {
          skipPatterns: ["pstatp.com", "toutiao.com", "byteimg.com"],
          onProgress: options?.onImageProgress,
          failOnError: true,
        }),
      );
      content = this.wrapImages(content);

      let payload: ToutiaoDraftPayload;
      try {
        payload = buildToutiaoDraftPayload({
          title: article.title,
          content,
          titleId: createToutiaoTitleId(),
        });
      } catch {
        throw new ToutiaoAdapterError(
          "头条文章标题或正文超过平台限制，请精简后重试",
        );
      }
      const pageResult = await this.saveDraftInPage(payload);

      if (!pageResult.ok) {
        if (pageResult.code === "OUTCOME_UNKNOWN") {
          return this.createResult(true, {
            externalAccountId: operationExternalAccountId,
            outcome: "OUTCOME_UNKNOWN",
            retryable: false,
            draftOnly: true,
            errorCode: "TOUTIAO_DRAFT_SAVE_OUTCOME_UNKNOWN",
            error: this.getDraftSaveErrorMessage(pageResult),
          });
        }
        throw new ToutiaoAdapterError(
          this.getDraftSaveErrorMessage(pageResult),
        );
      }

      // A successful platform response with a validated pgcId is definitive.
      // A later read may recover an unknown POST, but must never downgrade an
      // already accepted save.
      return this.createResult(true, {
        postId: pageResult.pgcId,
        postUrl: buildToutiaoDraftUrl(pageResult.pgcId),
        externalAccountId: operationExternalAccountId,
        draftOnly: true,
      });
    } catch (error) {
      logger.debug("Draft save failed");
      return this.createResult(false, {
        ...(operationExternalAccountId
          ? { externalAccountId: operationExternalAccountId }
          : {}),
        error:
          error instanceof ToutiaoAdapterError
            ? error.message
            : "头条草稿保存失败，请稍后重试",
      });
    }
  }

  private wrapImages(content: string): string {
    return content.replace(
      /<img\b([^>]*)>/gi,
      '<div class="pgc-img"><img$1></div>',
    );
  }

  private assertSafeImageSources(content: string): void {
    const imageSources = new Set<string>();
    const htmlImagePattern =
      /<img\b[^>]*\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
    let match: RegExpExecArray | null;

    while ((match = htmlImagePattern.exec(content)) !== null) {
      imageSources.add(match[1] ?? match[2] ?? match[3] ?? "");
    }
    for (const markdownImage of parseMarkdownImages(content)) {
      imageSources.add(markdownImage.src);
    }

    for (const source of imageSources) {
      if (!isSafeToutiaoImageSourceUrl(source)) {
        throw new ToutiaoAdapterError(
          "文章包含不安全的图片地址，已停止保存草稿",
        );
      }
    }
  }

  private getDraftSaveErrorMessage(
    failure: ToutiaoPageDraftSaveFailure,
  ): string {
    switch (failure.code) {
      case "UNTRUSTED_PAGE":
        return "头条草稿保存页来源校验失败";
      case "TRANSPORT_UNAVAILABLE":
        return "头条创作页尚未加载完成，请刷新创作页后重试";
      case "INVALID_REQUEST":
        return "头条草稿请求参数校验失败，已停止保存";
      case "PLATFORM_REJECTED":
        if (failure.diagnostic?.platformCode === 2222) {
          return "头条要求完成可信浏览器验证，请打开创作中心处理后重试";
        }
        if (failure.diagnostic?.platformCode === 3022) {
          return "头条账号尚未完成注册，请在创作中心完成认证后重试";
        }
        if (failure.diagnostic?.platformCode !== undefined) {
          return `头条拒绝保存草稿（错误码 ${failure.diagnostic.platformCode}），请打开创作中心检查内容`;
        }
        return "头条拒绝保存草稿，请打开创作中心检查内容";
      case "INVALID_RESPONSE":
        return "头条草稿响应格式异常，未记录草稿 ID";
      case "OUTCOME_UNKNOWN":
        return "头条草稿可能已保存，但系统无法确认结果；请先打开头条草稿箱检查，暂时不要重复投递";
      case "HTTP_ERROR":
        return failure.diagnostic?.httpStatus
          ? `头条草稿请求返回 HTTP ${failure.diagnostic.httpStatus}，请稍后重试`
          : "头条草稿请求返回 HTTP 错误，请稍后重试";
      case "FETCH_ERROR": {
        const errorClass = failure.diagnostic?.errorClass;
        if (errorClass === "TIMEOUT") {
          return "头条草稿请求超时，请检查网络后重试";
        }
        if (errorClass === "ABORT") {
          return "头条草稿请求已中止，请刷新创作页后重试";
        }
        return "头条草稿网络请求未完成，请检查网络后重试";
      }
    }
  }

  private async ensureToutiaoTab(): Promise<number> {
    if (!this.runtime.tabs) {
      throw new ToutiaoAdapterError("头条保存草稿需要浏览器标签页能力");
    }

    const tabs = await this.runtime.tabs.query("https://mp.toutiao.com/*");
    const editorTab = tabs.find(
      (tab) => Number.isInteger(tab.id) && isToutiaoEditorPageUrl(tab.url),
    );
    if (editorTab) {
      return editorTab.id;
    }

    const tab = await this.runtime.tabs.create(TOUTIAO_ROUTES.editor, false);
    await this.runtime.tabs.waitForLoad(tab.id, 30_000);
    return tab.id;
  }

  private async saveDraftInPage(
    payload: ToutiaoDraftPayload,
  ): Promise<ToutiaoPageDraftSaveResult> {
    if (!this.runtime.tabs) {
      throw new ToutiaoAdapterError("头条保存草稿需要浏览器标签页能力");
    }

    const tabId = await this.ensureToutiaoTab();
    try {
      const result = await this.runtime.tabs.executeScript<
        ToutiaoPageDraftSaveResult | undefined,
        [ToutiaoDraftPayload, number, number]
      >(tabId, saveToutiaoDraftInPage, [payload, 5_000, 60_000], {
        world: "MAIN",
      });
      return (
        result ?? {
          ok: false,
          code: "OUTCOME_UNKNOWN",
          diagnostic: {
            transport: "GARR",
            phase: "POST",
            errorClass: "UNKNOWN",
          },
        }
      );
    } catch {
      return {
        ok: false,
        code: "OUTCOME_UNKNOWN",
        diagnostic: {
          transport: "GARR",
          phase: "POST",
          errorClass: "UNKNOWN",
        },
      };
    }
  }

  private async getCsrfToken(): Promise<string> {
    const response = await this.runtime.fetch(TOUTIAO_ENDPOINTS.csrf, {
      method: "HEAD",
      credentials: "include",
      cache: "no-store",
      redirect: "error",
      headers: {
        "x-secsdk-csrf-request": "1",
        "x-secsdk-csrf-version": "1.2.22",
      },
    });
    const token = response.headers.get("x-ware-csrf-token")?.trim();
    if (!response.ok || response.url !== TOUTIAO_ENDPOINTS.csrf || !token) {
      throw new ToutiaoAdapterError("头条图片上传凭证获取失败");
    }
    return token;
  }

  protected async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    if (!isSafeToutiaoImageSourceUrl(src)) {
      throw new ToutiaoAdapterError("文章图片地址不安全");
    }

    const imageResponse = await this.runtime.fetch(src, {
      method: "GET",
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
    });
    if (
      !imageResponse.ok ||
      (imageResponse.url && !isSafeToutiaoImageSourceUrl(imageResponse.url))
    ) {
      throw new ToutiaoAdapterError("文章图片下载失败");
    }

    const declaredLength = Number(imageResponse.headers.get("content-length"));
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > TOUTIAO_MAX_IMAGE_BYTES
    ) {
      throw new ToutiaoAdapterError("文章图片超过 10MB 限制");
    }

    const imageBlob = await imageResponse.blob();
    const imageMime =
      imageBlob.type || imageResponse.headers.get("content-type") || "";
    if (
      imageBlob.size === 0 ||
      imageBlob.size > TOUTIAO_MAX_IMAGE_BYTES ||
      !isSupportedToutiaoImageMime(imageMime)
    ) {
      throw new ToutiaoAdapterError("文章图片格式不受支持或超过 10MB 限制");
    }

    const csrfToken = await this.getCsrfToken();
    const form = new FormData();
    form.append("image", imageBlob, "image.jpg");

    const uploadResponse = await this.runtime.fetch(
      TOUTIAO_ENDPOINTS.uploadImage,
      {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        redirect: "error",
        headers: {
          "x-secsdk-csrf-token": csrfToken,
        },
        body: form,
      },
    );
    if (
      !uploadResponse.ok ||
      uploadResponse.url !== TOUTIAO_ENDPOINTS.uploadImage ||
      !uploadResponse.headers
        .get("content-type")
        ?.toLowerCase()
        .includes("application/json")
    ) {
      throw new ToutiaoAdapterError("头条图片上传失败");
    }

    let payload: unknown;
    try {
      payload = await uploadResponse.json();
    } catch {
      throw new ToutiaoAdapterError("头条图片响应格式异常");
    }

    const parsed = parseToutiaoImagePayload(payload);
    if (!parsed.ok) {
      throw new ToutiaoAdapterError(
        parsed.code === "PLATFORM_REJECTED"
          ? "头条拒绝上传图片"
          : "头条图片响应格式异常",
      );
    }

    return {
      url: parsed.value.imageUrl,
      attrs: {
        class: "",
        "ic-uri": "",
        image_type: imageMime.split(";", 1)[0],
        mime_type: imageMime.split(";", 1)[0],
        web_uri: parsed.value.imageUri,
        img_width: String(parsed.value.width),
        img_height: String(parsed.value.height),
      },
    };
  }
}
