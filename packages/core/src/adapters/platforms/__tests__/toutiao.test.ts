import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeInterface } from "../../../runtime/interface";
import { ToutiaoAdapter } from "../toutiao";
import { TOUTIAO_ENDPOINTS } from "../toutiao-protocol";

afterEach(() => {
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
    const runtime = createRuntime({
      fetch: vi.fn().mockResolvedValue(accountResponse()),
    });
    const adapter = new ToutiaoAdapter();
    await adapter.init(runtime);

    await expect(adapter.checkAuth()).resolves.toEqual({
      isAuthenticated: true,
      userId: "7390000000000000001",
      username: "测试账号",
      avatar: "https://example.com/toutiao-avatar.png",
    });
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
    const fetch = vi.fn().mockResolvedValue(accountResponse());
    const executeScript = vi.fn().mockResolvedValue({
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
  });

  it("executes the bounded MAIN-world request and preserves its numeric draft ID", async () => {
    const pageResponse = new Response(
      '{"pgc_id":7111111111111111111,"err_no":0,"data":{"pgc_id":7520000000000000001},"other":{"pgc_id":7999999999999999999}}',
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
    Object.defineProperty(pageResponse, "url", {
      value: TOUTIAO_ENDPOINTS.saveDraft,
    });
    const pageFetch = vi.fn().mockResolvedValue(pageResponse);
    vi.stubGlobal("location", {
      origin: "https://mp.toutiao.com",
    });
    vi.stubGlobal("fetch", pageFetch);

    const executeScript = vi.fn(
      async (
        _tabId: number,
        func: (...args: unknown[]) => unknown,
        args: unknown[],
      ) => func(...args),
    );
    const adapter = new ToutiaoAdapter();
    await adapter.init(
      createRuntime({
        fetch: vi.fn().mockResolvedValue(accountResponse()),
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
    expect(pageFetch).toHaveBeenCalledWith(
      TOUTIAO_ENDPOINTS.saveDraft,
      expect.objectContaining({
        method: "POST",
        cache: "no-store",
        redirect: "error",
        credentials: "include",
      }),
    );
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

  it("does not expose online publication inspection in PR 1", () => {
    const adapter = new ToutiaoAdapter();
    expect(adapter.inspectPublication).toBeUndefined();
  });
});
