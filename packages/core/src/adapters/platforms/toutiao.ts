import { CodeAdapter, type ImageUploadResult } from "../code-adapter";
import type {
  Article,
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
  TOUTIAO_ROUTES,
  buildToutiaoDraftForm,
  buildToutiaoDraftUrl,
  createToutiaoTitleId,
  isSafeToutiaoImageSourceUrl,
  isSupportedToutiaoImageMime,
  isTrustedToutiaoPageUrl,
  parseToutiaoAccountResponseText,
  parseToutiaoImagePayload,
} from "./toutiao-protocol";

const logger = createLogger("Toutiao");

type PageDraftSaveErrorCode =
  | "FETCH_ERROR"
  | "HTTP_ERROR"
  | "INVALID_RESPONSE"
  | "PLATFORM_REJECTED"
  | "UNTRUSTED_PAGE";

type PageDraftSaveResult =
  | { ok: true; pgcId: string }
  | {
      ok: false;
      code: PageDraftSaveErrorCode;
    };

class ToutiaoAdapterError extends Error {}

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

  async checkAuth(): Promise<AuthResult> {
    try {
      return await this.withHeaderRules(this.HEADER_RULES, async () => {
        const response = await this.runtime.fetch(TOUTIAO_ENDPOINTS.account, {
          method: "GET",
          credentials: "include",
          cache: "no-store",
          redirect: "error",
          headers: {
            Accept: "application/json",
          },
        });

        if (!response.ok) {
          return {
            isAuthenticated: false,
            error: "头条账号状态读取失败，请确认已登录后重试",
          };
        }

        const responseText = await response.text();
        if (
          response.url !== TOUTIAO_ENDPOINTS.account ||
          !response.headers
            .get("content-type")
            ?.toLowerCase()
            .includes("application/json")
        ) {
          return {
            isAuthenticated: false,
            error: "头条账号状态响应格式异常",
          };
        }

        const parsed = parseToutiaoAccountResponseText(responseText);
        if (!parsed.ok) {
          return parsed.code === "AUTHENTICATION_REQUIRED"
            ? { isAuthenticated: false }
            : {
                isAuthenticated: false,
                error: "头条账号身份无法安全识别",
              };
        }

        return {
          isAuthenticated: true,
          userId: parsed.value.userId,
          username: parsed.value.username,
          avatar: parsed.value.avatar,
        };
      });
    } catch {
      logger.debug("Account status request failed");
      return {
        isAuthenticated: false,
        error: "头条账号状态读取失败，请确认已登录后重试",
      };
    }
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

      return await this.withHeaderRules(this.HEADER_RULES, async () => {
        let content = article.html || article.markdown || "";
        content = content
          .replace(/<figure[^>]*>\s*<\/figure>/gi, "")
          .replace(/\n{3,}/g, "\n\n");

        this.assertSafeImageSources(content);
        content = await this.processImages(
          content,
          (src) => this.uploadImageByUrl(src),
          {
            skipPatterns: ["pstatp.com", "toutiao.com", "byteimg.com"],
            onProgress: options?.onImageProgress,
            failOnError: true,
          },
        );
        content = this.wrapImages(content);

        const form = buildToutiaoDraftForm({
          title: article.title,
          content,
          titleId: createToutiaoTitleId(),
        });
        const pageResult = await this.saveDraftInPage(form.toString());

        if (!pageResult.ok) {
          throw new ToutiaoAdapterError(
            this.getDraftSaveErrorMessage(pageResult.code),
          );
        }

        return this.createResult(true, {
          postId: pageResult.pgcId,
          postUrl: buildToutiaoDraftUrl(pageResult.pgcId),
          draftOnly: true,
        });
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

  private getDraftSaveErrorMessage(code: PageDraftSaveErrorCode): string {
    switch (code) {
      case "UNTRUSTED_PAGE":
        return "头条草稿保存页来源校验失败";
      case "PLATFORM_REJECTED":
        return "头条拒绝保存草稿，请打开创作中心检查内容";
      case "INVALID_RESPONSE":
        return "头条草稿响应格式异常，未记录草稿 ID";
      case "HTTP_ERROR":
      case "FETCH_ERROR":
        return "头条草稿保存请求失败，请稍后重试";
    }
  }

  private async ensureToutiaoTab(): Promise<number> {
    if (!this.runtime.tabs) {
      throw new ToutiaoAdapterError("头条保存草稿需要浏览器标签页能力");
    }

    const tabs = await this.runtime.tabs.query("https://mp.toutiao.com/*");
    const trustedTab = tabs.find(
      (tab) => Number.isInteger(tab.id) && isTrustedToutiaoPageUrl(tab.url),
    );
    if (trustedTab) {
      return trustedTab.id;
    }

    const tab = await this.runtime.tabs.create(TOUTIAO_ROUTES.editor, false);
    await this.runtime.tabs.waitForLoad(tab.id, 30_000);
    return tab.id;
  }

  private async saveDraftInPage(
    formBody: string,
  ): Promise<PageDraftSaveResult> {
    if (!this.runtime.tabs) {
      throw new ToutiaoAdapterError("头条保存草稿需要浏览器标签页能力");
    }

    const tabId = await this.ensureToutiaoTab();
    const result = await this.runtime.tabs.executeScript<
      PageDraftSaveResult | undefined,
      [string, string, string, number]
    >(
      tabId,
      async (endpoint, body, expectedOrigin, maxResponseLength) => {
        if (
          location.origin !== expectedOrigin ||
          endpoint !==
            "https://mp.toutiao.com/mp/agw/article/publish?source=mp&type=article&aid=1231"
        ) {
          return { ok: false, code: "UNTRUSTED_PAGE" };
        }

        try {
          const response = await fetch(endpoint, {
            method: "POST",
            credentials: "include",
            cache: "no-store",
            redirect: "error",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body,
          });

          if (!response.ok || response.url !== endpoint) {
            return { ok: false, code: "HTTP_ERROR" };
          }
          if (
            !response.headers
              .get("content-type")
              ?.toLowerCase()
              .includes("application/json")
          ) {
            return { ok: false, code: "INVALID_RESPONSE" };
          }

          const responseText = await response.text();
          if (
            responseText.length === 0 ||
            responseText.length > maxResponseLength
          ) {
            return { ok: false, code: "INVALID_RESPONSE" };
          }

          let normalizedResponse = "";
          let index = 0;
          let inString = false;
          let escaped = false;
          const maxSafeInteger = BigInt(Number.MAX_SAFE_INTEGER);

          while (index < responseText.length) {
            const character = responseText[index];

            if (inString) {
              normalizedResponse += character;
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
              normalizedResponse += character;
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
                    // JSON.parse below rejects malformed JSON.
                  }
                }

                normalizedResponse += outputToken;
                index += token.length;
                continue;
              }
            }

            normalizedResponse += character;
            index += 1;
          }

          let payload: unknown;
          try {
            payload = JSON.parse(normalizedResponse);
          } catch {
            return { ok: false, code: "INVALID_RESPONSE" };
          }

          if (
            !payload ||
            typeof payload !== "object" ||
            Array.isArray(payload)
          ) {
            return { ok: false, code: "INVALID_RESPONSE" };
          }

          const root = payload as Record<string, unknown>;
          if (root.err_no !== 0 && root.err_no !== "0") {
            return { ok: false, code: "PLATFORM_REJECTED" };
          }

          const data =
            root.data &&
            typeof root.data === "object" &&
            !Array.isArray(root.data)
              ? (root.data as Record<string, unknown>)
              : null;
          const value = data?.pgc_id;

          if (typeof value === "string" && /^[1-9]\d{0,31}$/.test(value)) {
            return { ok: true, pgcId: value };
          }
          if (
            typeof value === "number" &&
            Number.isSafeInteger(value) &&
            value > 0
          ) {
            return { ok: true, pgcId: String(value) };
          }

          return { ok: false, code: "INVALID_RESPONSE" };
        } catch {
          return { ok: false, code: "FETCH_ERROR" };
        }
      },
      [
        TOUTIAO_ENDPOINTS.saveDraft,
        formBody,
        "https://mp.toutiao.com",
        1024 * 1024,
      ],
    );
    return result ?? { ok: false, code: "INVALID_RESPONSE" };
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
