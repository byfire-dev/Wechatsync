import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeInterface } from "../../../runtime/interface";
import { ToutiaoAdapter } from "../toutiao";
import { TOUTIAO_ENDPOINTS, saveToutiaoDraftInPage } from "../toutiao-protocol";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function createRuntime(
  overrides: Partial<RuntimeInterface> = {},
): RuntimeInterface {
  return {
    type: "extension",
    fetch: vi.fn(),
    cookies: {
      get: vi.fn(),
      set: vi.fn(),
      remove: vi.fn(),
    },
    storage: {
      get: vi.fn(),
      set: vi.fn(),
      remove: vi.fn(),
    },
    session: {
      get: vi.fn(),
      set: vi.fn(),
    },
    dom: {
      parseHTML: vi.fn(),
      querySelector: vi.fn(),
      querySelectorAll: vi.fn(),
      getTextContent: vi.fn(),
      getInnerHTML: vi.fn(),
    },
    ...overrides,
  } as RuntimeInterface;
}

function accountResponse(): Response {
  const response = new Response(
    JSON.stringify({
      data: {
        user: {
          id: "7390000000000000001",
          screen_name: "测试账号",
          https_avatar_url: "https://example.com/toutiao-avatar.png",
        },
      },
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
  Object.defineProperty(response, "url", {
    value: TOUTIAO_ENDPOINTS.account,
  });
  return response;
}

function numericAccountResponse(): Response {
  const response = new Response(
    '{"data":{"user":{"id":7390000000000000001,"screen_name":"测试账号"}}}',
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
  Object.defineProperty(response, "url", {
    value: TOUTIAO_ENDPOINTS.account,
  });
  return response;
}

describe("ToutiaoAdapter", () => {
  it("returns a stable string account identity without exposing payloads", async () => {
    let probeSignal: AbortSignal | undefined;
    const runtime = createRuntime({
      fetch: vi.fn((_url: string, options?: RequestInit) => {
        probeSignal = options?.signal ?? undefined;
        return Promise.resolve(accountResponse());
      }),
    });
    const adapter = new ToutiaoAdapter();
    await adapter.init(runtime);

    await expect(adapter.checkAuth()).resolves.toEqual({
      isAuthenticated: true,
      userId: "7390000000000000001",
      username: "测试账号",
      avatar: "https://example.com/toutiao-avatar.png",
      probeStatus: "AUTHENTICATED",
      probeSource: "EXTENSION",
    });
    expect(probeSignal?.aborted).toBe(true);
  });

  it("preserves a numeric 19-digit account ID from the response text", async () => {
    const runtime = createRuntime({
      fetch: vi.fn().mockResolvedValue(numericAccountResponse()),
    });
    const adapter = new ToutiaoAdapter();
    await adapter.init(runtime);

    await expect(adapter.checkAuth()).resolves.toMatchObject({
      isAuthenticated: true,
      userId: "7390000000000000001",
      username: "测试账号",
      probeStatus: "AUTHENTICATED",
      probeSource: "EXTENSION",
    });
  });

  it("accepts strict account JSON served as text/plain without page fallback", async () => {
    const response = accountResponse();
    Object.defineProperty(response, "headers", {
      value: new Headers({ "Content-Type": "text/plain; charset=utf-8" }),
    });
    const query = vi.fn();
    const adapter = new ToutiaoAdapter();
    await adapter.init(
      createRuntime({
        fetch: vi.fn().mockResolvedValue(response),
        tabs: {
          query,
          create: vi.fn(),
          waitForLoad: vi.fn(),
          executeScript: vi.fn(),
        },
      }),
    );

    await expect(adapter.checkAuth()).resolves.toMatchObject({
      isAuthenticated: true,
      userId: "7390000000000000001",
      probeStatus: "AUTHENTICATED",
      probeSource: "EXTENSION",
    });
    expect(query).not.toHaveBeenCalled();
  });

  it("accepts strict account JSON served as text/html without page fallback", async () => {
    const response = accountResponse();
    Object.defineProperty(response, "headers", {
      value: new Headers({ "Content-Type": "text/html; charset=utf-8" }),
    });
    const query = vi.fn();
    const adapter = new ToutiaoAdapter();
    await adapter.init(
      createRuntime({
        fetch: vi.fn().mockResolvedValue(response),
        tabs: {
          query,
          create: vi.fn(),
          waitForLoad: vi.fn(),
          executeScript: vi.fn(),
        },
      }),
    );

    await expect(adapter.checkAuth()).resolves.toMatchObject({
      isAuthenticated: true,
      userId: "7390000000000000001",
      probeStatus: "AUTHENTICATED",
      probeSource: "EXTENSION",
    });
    expect(query).not.toHaveBeenCalled();
  });

  it("rejects a redirected extension response before reading its body", async () => {
    const readBody = vi.fn();
    const redirectedResponse = {
      ok: true,
      redirected: true,
      url: "https://sso.toutiao.com/login",
      headers: new Headers({ "Content-Type": "text/html" }),
      get body() {
        readBody();
        throw new Error("redirect body must not be read");
      },
      text: vi.fn(),
    } as unknown as Response;
    const adapter = new ToutiaoAdapter();
    await adapter.init(
      createRuntime({
        fetch: vi.fn().mockResolvedValue(redirectedResponse),
        tabs: {
          query: vi.fn().mockResolvedValue([]),
          create: vi.fn(),
          waitForLoad: vi.fn(),
          executeScript: vi.fn(),
        },
      }),
    );

    await expect(adapter.checkAuth()).resolves.toMatchObject({
      isAuthenticated: false,
      probeErrorCode: "PAGE_CONTEXT_UNAVAILABLE",
      primaryProbeErrorCode: "REDIRECTED",
    });
    expect(readBody).not.toHaveBeenCalled();
  });

  it("cancels an undeclared extension response when its stream exceeds 1 MiB", async () => {
    const cancelBody = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024));
        controller.enqueue(new Uint8Array([1]));
      },
      cancel: cancelBody,
    });
    const oversizedResponse = {
      ok: true,
      redirected: false,
      url: TOUTIAO_ENDPOINTS.account,
      headers: new Headers({ "Content-Type": "text/plain; charset=utf-8" }),
      body,
      text: vi.fn(),
    } as unknown as Response;
    const adapter = new ToutiaoAdapter();
    await adapter.init(
      createRuntime({
        fetch: vi.fn().mockResolvedValue(oversizedResponse),
        tabs: {
          query: vi.fn().mockResolvedValue([]),
          create: vi.fn(),
          waitForLoad: vi.fn(),
          executeScript: vi.fn(),
        },
      }),
    );

    await expect(adapter.checkAuth()).resolves.toMatchObject({
      isAuthenticated: false,
      probeErrorCode: "PAGE_CONTEXT_UNAVAILABLE",
      primaryProbeErrorCode: "RESPONSE_SCHEMA_MISMATCH",
    });
    expect(cancelBody).toHaveBeenCalledTimes(1);
  });

  it("falls back to an existing trusted creator tab when the extension context is logged out", async () => {
    const extensionResponse = new Response(JSON.stringify({ data: {} }), {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
    Object.defineProperty(extensionResponse, "url", {
      value: TOUTIAO_ENDPOINTS.account,
    });
    const query = vi.fn().mockResolvedValue([
      {
        id: 42,
        url: "https://mp.toutiao.com/profile_v4/index",
      },
    ]);
    const executeScript = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        userId: "7390000000000000001",
        username: "页面账号",
      },
    });
    const adapter = new ToutiaoAdapter();
    await adapter.init(
      createRuntime({
        fetch: vi.fn().mockResolvedValue(extensionResponse),
        tabs: {
          query,
          create: vi.fn(),
          waitForLoad: vi.fn(),
          executeScript,
        },
      }),
    );

    await expect(adapter.checkAuth()).resolves.toEqual({
      isAuthenticated: true,
      userId: "7390000000000000001",
      username: "页面账号",
      avatar: undefined,
      probeStatus: "AUTHENTICATED",
      probeSource: "MAIN_WORLD",
    });
    expect(query).toHaveBeenCalledWith("https://mp.toutiao.com/*");
    expect(executeScript).toHaveBeenCalledWith(42, expect.any(Function), []);
  });

  it("falls back to the creator page after the extension probe times out", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(
      (_url: string, options?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    const executeScript = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        userId: "7390000000000000001",
        username: "页面账号",
      },
    });
    const adapter = new ToutiaoAdapter();
    await adapter.init(
      createRuntime({
        fetch,
        tabs: {
          query: vi.fn().mockResolvedValue([
            {
              id: 42,
              url: "https://mp.toutiao.com/profile_v4/index",
            },
          ]),
          create: vi.fn(),
          waitForLoad: vi.fn(),
          executeScript,
        },
      }),
    );

    const authPromise = adapter.checkAuth();
    await vi.advanceTimersByTimeAsync(3_000);

    await expect(authPromise).resolves.toMatchObject({
      isAuthenticated: true,
      userId: "7390000000000000001",
      probeStatus: "AUTHENTICATED",
      probeSource: "MAIN_WORLD",
      primaryProbeErrorCode: "TIMEOUT",
    });
    expect(executeScript).toHaveBeenCalledTimes(1);
  });

  it("reports a page-context failure without opening a new tab", async () => {
    const query = vi.fn().mockResolvedValue([]);
    const create = vi.fn();
    const adapter = new ToutiaoAdapter();
    await adapter.init(
      createRuntime({
        fetch: vi.fn().mockRejectedValue(new Error("sensitive network error")),
        tabs: {
          query,
          create,
          waitForLoad: vi.fn(),
          executeScript: vi.fn(),
        },
      }),
    );

    await expect(adapter.checkAuth()).resolves.toMatchObject({
      isAuthenticated: false,
      probeStatus: "PROBE_FAILED",
      probeSource: "MAIN_WORLD",
      probeErrorCode: "PAGE_CONTEXT_UNAVAILABLE",
      primaryProbeErrorCode: "NETWORK_ERROR",
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("accepts a confirmed logout only from the creator page context", async () => {
    const adapter = new ToutiaoAdapter();
    await adapter.init(
      createRuntime({
        fetch: vi.fn().mockRejectedValue(new Error("network")),
        tabs: {
          query: vi.fn().mockResolvedValue([
            {
              id: 42,
              url: "https://mp.toutiao.com/profile_v4/index",
            },
          ]),
          create: vi.fn(),
          waitForLoad: vi.fn(),
          executeScript: vi.fn().mockResolvedValue({
            ok: false,
            code: "NOT_AUTHENTICATED",
          }),
        },
      }),
    );

    await expect(adapter.checkAuth()).resolves.toMatchObject({
      isAuthenticated: false,
      probeStatus: "NOT_AUTHENTICATED",
      probeSource: "MAIN_WORLD",
      primaryProbeErrorCode: "NETWORK_ERROR",
    });
  });

  it("fails closed before any network request when direct publish is requested", async () => {
    const fetch = vi.fn();
    const executeScript = vi.fn();
    const query = vi.fn();
    const create = vi.fn();
    const waitForLoad = vi.fn();
    const adapter = new ToutiaoAdapter();
    await adapter.init(
      createRuntime({
        fetch,
        tabs: {
          query,
          create,
          waitForLoad,
          executeScript,
        },
      }),
    );

    const result = await adapter.publish(
      {
        title: "不能直接发布",
        markdown: "正文",
        html: "<p>正文</p>",
      },
      { draftOnly: false },
    );

    expect(result).toMatchObject({
      platform: "toutiao",
      success: false,
      error: "头条适配器当前仅允许保存草稿，不支持直接发布",
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(waitForLoad).not.toHaveBeenCalled();
    expect(executeScript).not.toHaveBeenCalled();
  });

  it("saves a draft through a trusted creator-center tab", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(accountResponse());
    const executeScript = vi.fn().mockResolvedValueOnce({
      ok: true,
      pgcId: "7520000000000000001",
    });
    const query = vi.fn().mockResolvedValue([
      {
        id: 42,
        url: "https://mp.toutiao.com/profile_v4/graphic/publish",
      },
    ]);
    const adapter = new ToutiaoAdapter();
    await adapter.init(
      createRuntime({
        fetch,
        tabs: {
          query,
          create: vi.fn(),
          waitForLoad: vi.fn(),
          executeScript,
        },
      }),
    );

    const result = await adapter.publish(
      {
        title: "协议测试文章",
        markdown: "正文",
        html: "<p>正文</p>",
      },
      { draftOnly: true },
    );

    expect(result).toMatchObject({
      platform: "toutiao",
      success: true,
      postId: "7520000000000000001",
      postUrl:
        "https://mp.toutiao.com/profile_v4/graphic/publish?pgc_id=7520000000000000001",
      draftOnly: true,
    });
    expect(query).toHaveBeenCalledWith("https://mp.toutiao.com/*");
    expect(executeScript).toHaveBeenCalledTimes(1);
    expect(executeScript).toHaveBeenCalledWith(
      42,
      saveToutiaoDraftInPage,
      [
        expect.objectContaining({
          title: "协议测试文章",
          content: "<p>正文</p>",
          save: 0,
          source: 29,
        }),
        5_000,
        60_000,
      ],
      { world: "MAIN" },
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("treats the accepted page-owned Garr response as the definitive save outcome", async () => {
    const post = vi.fn().mockResolvedValue({
      code: 0,
      data: { pgcId: "7520000000000000001" },
    });
    vi.stubGlobal("location", {
      origin: "https://mp.toutiao.com",
      pathname: "/profile_v4/graphic/publish",
    });
    vi.stubGlobal("window", {
      Garr: {
        network: { post },
        abTestUtils: { getVar: vi.fn().mockResolvedValue(2) },
      },
    });

    const executeScript = vi.fn(
      async (
        _tabId: number,
        func: (...args: unknown[]) => unknown,
        args: unknown[],
        _options?: { world?: "MAIN" | "ISOLATED" },
      ) => func(...args),
    );
    const fetch = vi.fn().mockResolvedValueOnce(accountResponse());
    const adapter = new ToutiaoAdapter();
    await adapter.init(
      createRuntime({
        fetch,
        tabs: {
          query: vi.fn().mockResolvedValue([
            {
              id: 42,
              url: "https://mp.toutiao.com/profile_v4/graphic/publish",
            },
          ]),
          create: vi.fn(),
          waitForLoad: vi.fn(),
          executeScript,
        },
      }),
    );

    const result = await adapter.publish({
      title: "数字 ID 测试",
      markdown: "正文",
      html: "<p>正文</p>",
    });

    expect(result).toMatchObject({
      success: true,
      postId: "7520000000000000001",
    });
    expect(post).toHaveBeenCalledWith(
      "/mp/agw/article/publish?source=mp&type=article&aid=1231&mp_publish_ab_val=2",
      expect.objectContaining({
        title: "数字 ID 测试",
        save: 0,
      }),
      { requestId: undefined },
    );
    expect(executeScript).toHaveBeenCalledTimes(1);
    expect(executeScript).toHaveBeenCalledWith(
      42,
      saveToutiaoDraftInPage,
      expect.any(Array),
      { world: "MAIN" },
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not attempt a follow-up read that could downgrade an accepted save", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(accountResponse());
    const executeScript = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        pgcId: "7520000000000000001",
      })
      .mockRejectedValueOnce(new Error("follow-up read unavailable"));
    const adapter = new ToutiaoAdapter();
    await adapter.init(
      createRuntime({
        fetch,
        tabs: {
          query: vi.fn().mockResolvedValue([
            {
              id: 42,
              url: "https://mp.toutiao.com/profile_v4/graphic/publish",
            },
          ]),
          create: vi.fn(),
          waitForLoad: vi.fn(),
          executeScript,
        },
      }),
    );

    const result = await adapter.publish({
      title: "需要独立确认",
      markdown: "正文",
      html: "<p>正文</p>",
    });

    expect(result).toMatchObject({
      success: true,
      postId: "7520000000000000001",
      postUrl:
        "https://mp.toutiao.com/profile_v4/graphic/publish?pgc_id=7520000000000000001",
      draftOnly: true,
    });
    expect(executeScript).toHaveBeenCalledTimes(1);
    expect(executeScript).toHaveBeenCalledWith(
      42,
      saveToutiaoDraftInPage,
      expect.any(Array),
      { world: "MAIN" },
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps the outcome unknown when the save POST cannot be classified", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(accountResponse());
    const executeScript = vi.fn().mockResolvedValueOnce({
      ok: false,
      code: "OUTCOME_UNKNOWN",
      diagnostic: {
        transport: "GARR",
        phase: "POST",
        errorClass: "TIMEOUT",
      },
    });
    const adapter = new ToutiaoAdapter();
    await adapter.init(
      createRuntime({
        fetch,
        tabs: {
          query: vi.fn().mockResolvedValue([
            {
              id: 42,
              url: "https://mp.toutiao.com/profile_v4/graphic/publish",
            },
          ]),
          create: vi.fn(),
          waitForLoad: vi.fn(),
          executeScript,
        },
      }),
    );

    const result = await adapter.publish({
      title: "结果未知",
      markdown: "正文",
      html: "<p>正文</p>",
    });

    expect(result).toMatchObject({
      success: true,
      outcome: "OUTCOME_UNKNOWN",
      retryable: false,
      draftOnly: true,
      externalAccountId: "7390000000000000001",
      errorCode: "TOUTIAO_DRAFT_SAVE_OUTCOME_UNKNOWN",
      error:
        "头条草稿可能已保存，但系统无法确认结果；请先打开头条草稿箱检查，暂时不要重复投递",
    });
    expect(executeScript).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("surfaces bounded platform verification guidance without confirming", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(accountResponse());
    const executeScript = vi.fn().mockResolvedValue({
      ok: false,
      code: "PLATFORM_REJECTED",
      diagnostic: {
        transport: "GARR",
        phase: "POST",
        platformCode: 2222,
      },
    });
    const adapter = new ToutiaoAdapter();
    await adapter.init(
      createRuntime({
        fetch,
        tabs: {
          query: vi.fn().mockResolvedValue([
            {
              id: 42,
              url: "https://mp.toutiao.com/profile_v4/graphic/publish",
            },
          ]),
          create: vi.fn(),
          waitForLoad: vi.fn(),
          executeScript,
        },
      }),
    );

    const result = await adapter.publish({
      title: "平台验证",
      markdown: "正文",
      html: "<p>正文</p>",
    });

    expect(result).toMatchObject({
      success: false,
      error: "头条要求完成可信浏览器验证，请打开创作中心处理后重试",
    });
    expect(executeScript).toHaveBeenCalledTimes(1);
    expect(executeScript).toHaveBeenCalledWith(
      42,
      saveToutiaoDraftInPage,
      expect.any(Array),
      { world: "MAIN" },
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("creates an exact graphic-editor tab instead of reusing another creator page", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(accountResponse());
    const create = vi.fn().mockResolvedValue({
      id: 99,
      url: "https://mp.toutiao.com/profile_v4/graphic/publish",
    });
    const waitForLoad = vi.fn().mockResolvedValue(undefined);
    const executeScript = vi.fn().mockResolvedValueOnce({
      ok: true,
      pgcId: "7520000000000000001",
    });
    const adapter = new ToutiaoAdapter();
    await adapter.init(
      createRuntime({
        fetch,
        tabs: {
          query: vi.fn().mockResolvedValue([
            {
              id: 42,
              url: "https://mp.toutiao.com/profile_v4/index",
            },
          ]),
          create,
          waitForLoad,
          executeScript,
        },
      }),
    );

    await expect(
      adapter.publish({
        title: "编辑器路由",
        markdown: "正文",
        html: "<p>正文</p>",
      }),
    ).resolves.toMatchObject({ success: true });

    expect(create).toHaveBeenCalledWith(
      "https://mp.toutiao.com/profile_v4/graphic/publish",
      false,
    );
    expect(waitForLoad).toHaveBeenCalledWith(99, 30_000);
    expect(executeScript).toHaveBeenCalledTimes(1);
    expect(executeScript).toHaveBeenCalledWith(
      99,
      saveToutiaoDraftInPage,
      expect.any(Array),
      { world: "MAIN" },
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("stops before POST when temporary header-rule cleanup fails", async () => {
    const executeScript = vi.fn();
    const remove = vi.fn().mockRejectedValue(new Error("cleanup failed"));
    const adapter = new ToutiaoAdapter();
    await adapter.init(
      createRuntime({
        headerRules: {
          add: vi.fn().mockResolvedValue("toutiao-rule"),
          remove,
          clear: vi.fn(),
        },
        tabs: {
          query: vi.fn(),
          create: vi.fn(),
          waitForLoad: vi.fn(),
          executeScript,
        },
      }),
    );
    vi.spyOn(adapter, "checkAuth").mockResolvedValue({
      isAuthenticated: true,
      userId: "7390000000000000001",
      username: "测试账号",
    });

    await expect(
      adapter.publish({
        title: "规则清理失败",
        markdown: "正文",
        html: "<p>正文</p>",
      }),
    ).resolves.toMatchObject({
      success: false,
      error: "头条草稿保存失败，请稍后重试",
    });
    expect(remove).toHaveBeenCalledWith("toutiao-rule");
    expect(executeScript).not.toHaveBeenCalled();
  });

  it("rejects local image sources before reading or saving them", async () => {
    const fetch = vi.fn().mockResolvedValue(accountResponse());
    const executeScript = vi.fn();
    const adapter = new ToutiaoAdapter();
    await adapter.init(
      createRuntime({
        fetch,
        tabs: {
          query: vi.fn(),
          create: vi.fn(),
          waitForLoad: vi.fn(),
          executeScript,
        },
      }),
    );

    const result = await adapter.publish({
      title: "不安全图片",
      markdown: "正文",
      html: '<p>正文</p><img src="http://127.0.0.1/private.png">',
    });

    expect(result).toMatchObject({
      success: false,
      error: "文章包含不安全的图片地址，已停止保存草稿",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(executeScript).not.toHaveBeenCalled();
  });

  it("does not save a draft after a required image upload fails", async () => {
    const imageUrl = "https://images.example.com/article.png?signature=secret";
    const imageResponse = new Response("forbidden", { status: 403 });
    Object.defineProperty(imageResponse, "url", { value: imageUrl });
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(accountResponse())
      .mockResolvedValueOnce(imageResponse);
    const executeScript = vi.fn();
    const adapter = new ToutiaoAdapter();
    await adapter.init(
      createRuntime({
        fetch,
        tabs: {
          query: vi.fn(),
          create: vi.fn(),
          waitForLoad: vi.fn(),
          executeScript,
        },
      }),
    );

    const result = await adapter.publish({
      title: "图片失败",
      markdown: "正文",
      html: `<p>正文</p><img src="${imageUrl}">`,
    });

    expect(result).toMatchObject({
      success: false,
      error: "文章图片下载失败",
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(executeScript).not.toHaveBeenCalled();
  });

  it("exposes publication inspection and proof through the standard adapter surface", () => {
    const adapter = new ToutiaoAdapter();
    expect(adapter.inspectPublication).toBeTypeOf("function");
    expect(adapter.provePublishedObservation).toBeTypeOf("function");
    expect(adapter.meta.capabilities).toContain("account_binding");
  });
});
