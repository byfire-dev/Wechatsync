import { CodeAdapter, type ImageUploadResult } from "../code-adapter";
import type {
  Article,
  AuthProbeErrorCode,
  AuthResult,
  PlatformMeta,
  SyncResult,
} from "../../types";
import type { PublishOptions } from "../types";
import { createLogger } from "../../lib/logger";
import { parseMarkdownImages } from "../../lib/markdown-images";
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
    capabilities: ["article", "draft", "image_upload", "cover"],
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

  private async probeAccountInExtension(): Promise<AuthResult> {
    const controller = new AbortController();
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
      logger.debug("Extension account status request failed");
      return this.authFailure(
        controller.signal.aborted ? "TIMEOUT" : "NETWORK_ERROR",
        "EXTENSION",
      );
    } finally {
      controller.abort();
      clearTimeout(timeoutId);
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
  ): Promise<AuthResult> {
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
      return this.normalizePageAccountProbe(result, primary);
    } catch {
      logger.debug("MAIN-world account status request failed");
      return this.authFailure(
        "UNKNOWN_ERROR",
        "MAIN_WORLD",
        primary.probeErrorCode,
      );
    }
  }

  async checkAuth(): Promise<AuthResult> {
    const primary = await this.probeAccountInExtension();
    if (primary.isAuthenticated) {
      return primary;
    }

    return this.probeAccountInMainWorld(primary);
  }

  async publish(
    article: Article,
    options?: PublishOptions,
  ): Promise<SyncResult> {
    if (options?.draftOnly === false) {
      return this.createResult(false, {
        error: "头条适配器当前仅允许保存草稿，不支持直接发布",
      });
    }

    try {
      const auth = await this.checkAuth();
      if (!auth.isAuthenticated) {
        throw new ToutiaoAdapterError(auth.error || "请先登录头条创作中心");
      }

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
        draftOnly: true,
      });
    } catch (error) {
      logger.debug("Draft save failed");
      return this.createResult(false, {
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
