import { afterEach, describe, expect, it, vi } from "vitest";
import { parseHTML } from "linkedom";
import accountFixture from "../__fixtures__/toutiao/account-authenticated.json";
import draftFixture from "../__fixtures__/toutiao/draft-created.json";
import imageFixture from "../__fixtures__/toutiao/image-uploaded.json";
import {
  TOUTIAO_SPIKE_ENDPOINTS,
  buildToutiaoDraftDetailUrl,
  buildToutiaoDraftListProbeUrl,
  buildToutiaoDraftPayload,
  buildToutiaoDraftUrl,
  buildToutiaoSaveDraftUrl,
  confirmToutiaoDraftInIsolatedWorld,
  createToutiaoTitleId,
  isSafeToutiaoImageSourceUrl,
  isSupportedToutiaoImageMime,
  isToutiaoEditorPageUrl,
  isTrustedToutiaoPageUrl,
  normalizeToutiaoId,
  parseToutiaoAccountPayload,
  parseToutiaoAccountResponseText,
  parseToutiaoDraftPayload,
  parseToutiaoDraftDetailPayload,
  parseToutiaoDraftDetailResponseText,
  parseToutiaoDraftResponseText,
  parseToutiaoImagePayload,
  probeToutiaoAccountInPage,
  saveToutiaoDraftInPage,
} from "../toutiao-protocol";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function draftPayload() {
  return buildToutiaoDraftPayload({
    title: "协议测试",
    content: "<p>正文</p>",
    titleId: "1720000000000_1234000000000000",
  });
}

function stubHtmlDocument(): void {
  vi.stubGlobal(
    "document",
    parseHTML("<!doctype html><html><body></body></html>").document,
  );
}

function draftDetailResponse(
  title = "协议测试",
  content = "<p>正文</p>",
  pgcId = "7520000000000000001",
): Response {
  const response = new Response(
    JSON.stringify({
      pgc_id: pgcId,
      title,
      content,
      article_pgc: {
        content_cache: {
          tuwen_wtt_transfer_switch: false,
        },
      },
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
  Object.defineProperty(response, "url", {
    value: buildToutiaoDraftDetailUrl(pgcId),
  });
  return response;
}

describe("Toutiao protocol", () => {
  it("parses a stable account identity from a sanitized fixture", () => {
    expect(parseToutiaoAccountPayload(accountFixture)).toEqual({
      ok: true,
      value: {
        userId: "7390000000000000001",
        username: "已脱敏测试账号",
        avatar: "https://example.com/toutiao-avatar.png",
      },
    });
  });

  it("rejects account IDs that have already lost integer precision", () => {
    expect(
      parseToutiaoAccountPayload({
        data: { user: { id: 7390000000000000001 } },
      }),
    ).toEqual({ ok: false, code: "INVALID_ACCOUNT_ID" });
    expect(normalizeToutiaoId(Number.MAX_SAFE_INTEGER + 1)).toBeNull();
  });

  it("preserves a 19-digit numeric account ID from raw JSON", () => {
    expect(
      parseToutiaoAccountResponseText(
        '{"data":{"user":{"id":7390000000000000001,"screen_name":"测试账号"}}}',
      ),
    ).toEqual({
      ok: true,
      value: {
        userId: "7390000000000000001",
        username: "测试账号",
      },
    });
  });

  it("returns only a sanitized account identity from a MAIN-world probe", async () => {
    vi.stubGlobal("location", { origin: "https://mp.toutiao.com" });
    const response = new Response(
      '{"data":{"user":{"id":7390000000000000001,"screen_name":"页面账号"}}}',
      {
        status: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      },
    );
    Object.defineProperty(response, "url", {
      value: "https://mp.toutiao.com/mp/agw/media/get_media_info",
    });
    let probeSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: unknown, options?: RequestInit) => {
        probeSignal = options?.signal ?? undefined;
        return Promise.resolve(response);
      }),
    );

    await expect(probeToutiaoAccountInPage()).resolves.toEqual({
      ok: true,
      value: {
        userId: "7390000000000000001",
        username: "页面账号",
      },
    });
    expect(probeSignal?.aborted).toBe(true);
  });

  it("accepts strict MAIN-world account JSON even when declared as text/html", async () => {
    vi.stubGlobal("location", { origin: "https://mp.toutiao.com" });
    const response = new Response(
      '{"data":{"user":{"id":"7390000000000000001","screen_name":"页面账号"}}}',
      {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      },
    );
    Object.defineProperty(response, "url", {
      value: "https://mp.toutiao.com/mp/agw/media/get_media_info",
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

    await expect(probeToutiaoAccountInPage()).resolves.toMatchObject({
      ok: true,
      value: { userId: "7390000000000000001" },
    });
  });

  it("remains self-contained after chrome.scripting serializes the probe", async () => {
    vi.stubGlobal("location", { origin: "https://mp.toutiao.com" });
    const response = new Response(
      '{"data":{"user":{"id":"7390000000000000001","screen_name":"页面账号"}}}',
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
    Object.defineProperty(response, "url", {
      value: "https://mp.toutiao.com/mp/agw/media/get_media_info",
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    const serializedProbe = new Function(
      `return (${probeToutiaoAccountInPage.toString()})`,
    )() as typeof probeToutiaoAccountInPage;

    await expect(serializedProbe()).resolves.toEqual({
      ok: true,
      value: {
        userId: "7390000000000000001",
        username: "页面账号",
      },
    });
  });

  it("returns a bounded code instead of a MAIN-world exception", async () => {
    vi.stubGlobal("location", { origin: "https://mp.toutiao.com" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("cookie=secret-token")),
    );

    const result = await probeToutiaoAccountInPage();
    expect(result).toEqual({ ok: false, code: "NETWORK_ERROR" });
    expect(JSON.stringify(result)).not.toContain("secret-token");
  });

  it("confirms logout separately from account-response contract drift", async () => {
    vi.stubGlobal("location", { origin: "https://mp.toutiao.com" });
    const accountWithoutUser = new Response('{"data":{}}', {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
    Object.defineProperty(accountWithoutUser, "url", {
      value: "https://mp.toutiao.com/mp/agw/media/get_media_info",
    });
    const loggedOut = new Response('{"data":{"is_login":false}}', {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
    Object.defineProperty(loggedOut, "url", {
      value: "https://mp.toutiao.com/mp/agw/media/user_login_status_api",
    });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(accountWithoutUser)
        .mockResolvedValueOnce(loggedOut),
    );

    await expect(probeToutiaoAccountInPage()).resolves.toEqual({
      ok: false,
      code: "NOT_AUTHENTICATED",
    });

    const accountContractDrift = new Response('{"data":{}}', {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
    Object.defineProperty(accountContractDrift, "url", {
      value: "https://mp.toutiao.com/mp/agw/media/get_media_info",
    });
    const loggedInWithoutIdentity = new Response('{"data":{"is_login":true}}', {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
    Object.defineProperty(loggedInWithoutIdentity, "url", {
      value: "https://mp.toutiao.com/mp/agw/media/user_login_status_api",
    });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(accountContractDrift)
        .mockResolvedValueOnce(loggedInWithoutIdentity),
    );

    await expect(probeToutiaoAccountInPage()).resolves.toEqual({
      ok: false,
      code: "RESPONSE_SCHEMA_MISMATCH",
    });
  });

  it("fails closed on HTML instead of treating a login page as account JSON", async () => {
    vi.stubGlobal("location", { origin: "https://mp.toutiao.com" });
    const response = new Response("<html><body>login</body></html>", {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
    Object.defineProperty(response, "url", {
      value: "https://mp.toutiao.com/mp/agw/media/get_media_info",
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

    await expect(probeToutiaoAccountInPage()).resolves.toEqual({
      ok: false,
      code: "INVALID_CONTENT_TYPE",
    });
  });

  it("classifies malformed declared JSON as response-schema drift", async () => {
    vi.stubGlobal("location", { origin: "https://mp.toutiao.com" });
    const response = new Response("{not-json", {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
    Object.defineProperty(response, "url", {
      value: "https://mp.toutiao.com/mp/agw/media/get_media_info",
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

    await expect(probeToutiaoAccountInPage()).resolves.toEqual({
      ok: false,
      code: "RESPONSE_SCHEMA_MISMATCH",
    });
  });

  it("cancels a declared oversized MAIN-world response without parsing it", async () => {
    vi.stubGlobal("location", { origin: "https://mp.toutiao.com" });
    const cancelBody = vi.fn();
    const response = {
      ok: true,
      redirected: false,
      url: "https://mp.toutiao.com/mp/agw/media/get_media_info",
      headers: new Headers({
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Length": "1048577",
      }),
      body: new ReadableStream<Uint8Array>({ cancel: cancelBody }),
      text: vi.fn(),
    } as unknown as Response;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

    await expect(probeToutiaoAccountInPage()).resolves.toEqual({
      ok: false,
      code: "RESPONSE_SCHEMA_MISMATCH",
    });
    expect(cancelBody).toHaveBeenCalledTimes(1);
    expect(response.text).not.toHaveBeenCalled();
  });

  it("parses a string draft ID from a sanitized fixture", () => {
    expect(parseToutiaoDraftPayload(draftFixture)).toEqual({
      ok: true,
      value: { pgcId: "7520000000000000001" },
    });
  });

  it("accepts the current Garr response envelope", () => {
    expect(
      parseToutiaoDraftPayload({
        code: 0,
        data: { pgcId: "7520000000000000001" },
      }),
    ).toEqual({
      ok: true,
      value: { pgcId: "7520000000000000001" },
    });
  });

  it("parses current and nested draft-detail envelopes", () => {
    expect(
      parseToutiaoDraftDetailPayload({
        pgc_id: "7520000000000000000",
        title: "官方编辑结构",
        article_pgc: {
          content_cache: {
            tuwen_wtt_transfer_switch: false,
          },
        },
      }),
    ).toEqual({
      ok: true,
      value: {
        pgcId: "7520000000000000000",
        title: "官方编辑结构",
      },
    });
    expect(
      parseToutiaoDraftDetailPayload({
        code: 0,
        data: {
          pgc_id: "7520000000000000001",
          title: "协议测试",
        },
      }),
    ).toEqual({
      ok: true,
      value: {
        pgcId: "7520000000000000001",
        title: "协议测试",
      },
    });
    expect(
      parseToutiaoDraftDetailPayload({
        err_no: 0,
        data: {
          article: {
            pgcId: "7520000000000000002",
            title: "嵌套结构",
          },
        },
      }),
    ).toEqual({
      ok: true,
      value: {
        pgcId: "7520000000000000002",
        title: "嵌套结构",
      },
    });
  });

  it("preserves a numeric draft-detail ID and rejects missing identity", () => {
    expect(
      parseToutiaoDraftDetailResponseText(
        '{"code":0,"data":{"pgc_id":7520000000000000001,"title":"协议测试"}}',
      ),
    ).toEqual({
      ok: true,
      value: {
        pgcId: "7520000000000000001",
        title: "协议测试",
      },
    });
    expect(
      parseToutiaoDraftDetailPayload({
        code: 0,
        data: { title: "协议测试" },
      }),
    ).toEqual({ ok: false, code: "INVALID_DRAFT_ID" });
  });

  it("preserves a 19-digit numeric draft ID from bounded raw JSON", () => {
    expect(
      parseToutiaoDraftResponseText(
        '{"err_no":0,"data":{"pgc_id":7520000000000000001}}',
      ),
    ).toEqual({
      ok: true,
      value: { pgcId: "7520000000000000001" },
    });
  });

  it("reads only data.pgc_id when other objects contain the same key", () => {
    expect(
      parseToutiaoDraftResponseText(
        '{"pgc_id":7111111111111111111,"err_no":0,"data":{"pgc_id":7520000000000000001},"other":{"pgc_id":7999999999999999999}}',
      ),
    ).toEqual({
      ok: true,
      value: { pgcId: "7520000000000000001" },
    });
  });

  it("does not treat a rejected or malformed response as success", () => {
    expect(
      parseToutiaoDraftPayload({
        err_no: 1001,
        data: { pgc_id: "7520000000000000001" },
      }),
    ).toEqual({ ok: false, code: "PLATFORM_REJECTED" });
    expect(parseToutiaoDraftResponseText("<html>blocked</html>")).toEqual({
      ok: false,
      code: "INVALID_RESPONSE",
    });
  });

  it("parses only HTTPS image evidence", () => {
    expect(parseToutiaoImagePayload(imageFixture)).toEqual({
      ok: true,
      value: {
        imageUrl: "https://example.com/toutiao-image.png",
        imageUri: "tos-cn-i-example/sanitized-image",
        width: 1200,
        height: 628,
      },
    });
    expect(
      parseToutiaoImagePayload({
        code: 0,
        data: {
          image_url: "http://example.com/image.png",
          image_uri: "image-id",
        },
      }),
    ).toEqual({ ok: false, code: "INVALID_RESPONSE" });
  });

  it("builds the current official minimum draft payload exactly", () => {
    const titleId = createToutiaoTitleId(1_720_000_000_000, 0.1234);
    const payload = buildToutiaoDraftPayload({
      title: "协议测试",
      content: "<p>正文</p>",
      titleId,
    });

    expect(titleId).toBe("1720000000000_1234000000000000");
    expect(createToutiaoTitleId(1_720_000_000_000, 0.000000001)).toBe(
      "1720000000000_0000000010000000",
    );
    expect(payload).toEqual({
      pgc_id: "",
      article_type: 0,
      source: 29,
      extra: '{"content_source":100000000402,"content_word_cnt":2}',
      content: "<p>正文</p>",
      title: "协议测试",
      search_creation_info: '{"searchTopOne":0,"abstract":"","clue_id":""}',
      title_id: titleId,
      ic_uri_list: [],
      appid_list: [],
      stock_ids: [],
      concern_list: [],
      mp_editor_stat: "{}",
      is_refute_rumor: "0",
      save: 0,
      entrance: "",
      timer_status: 0,
      timer_time: "",
    });
  });

  it("derives editor text length and deduplicated image URIs", () => {
    const payload = buildToutiaoDraftPayload({
      title: "图片协议",
      content:
        '<p>A&amp;B</p><img web_uri="tos-cn-i-example/a"><img ic-uri="tos-cn-i-example/a"><img web_uri="tos-cn-i-example/b">',
      titleId: "1720000000000_1234000000000000",
    });

    expect(JSON.parse(payload.extra)).toEqual({
      content_source: 100000000402,
      content_word_cnt: 3,
    });
    expect(payload.ic_uri_list).toEqual([
      "tos-cn-i-example/a",
      "tos-cn-i-example/b",
    ]);
  });

  it("enforces the current title, text, and HTML limits before POST", () => {
    expect(() =>
      buildToutiaoDraftPayload({
        title: "超".repeat(31),
        content: "<p>正文</p>",
        titleId: "1720000000000_1234000000000000",
      }),
    ).toThrowError("Toutiao draft title is too long");
    expect(() =>
      buildToutiaoDraftPayload({
        title: "HTML 超限",
        content: "a".repeat(300_001),
        titleId: "1720000000000_1234000000000000",
      }),
    ).toThrowError("Toutiao draft content length is invalid");
    expect(() =>
      buildToutiaoDraftPayload({
        title: "文本超限",
        content: `<p>${"字".repeat(150_001)}</p>`,
        titleId: "1720000000000_1234000000000000",
      }),
    ).toThrowError("Toutiao draft text length is invalid");
  });

  it("builds a bounded current save URL without query injection", () => {
    expect(buildToutiaoSaveDraftUrl(2)).toBe(
      "https://mp.toutiao.com/mp/agw/article/publish?source=mp&type=article&aid=1231&mp_publish_ab_val=2",
    );
    expect(buildToutiaoSaveDraftUrl("2&evil=1")).toBe(
      "https://mp.toutiao.com/mp/agw/article/publish?source=mp&type=article&aid=1231&mp_publish_ab_val=0",
    );
    expect(buildToutiaoSaveDraftUrl(-1)).toBe(
      "https://mp.toutiao.com/mp/agw/article/publish?source=mp&type=article&aid=1231&mp_publish_ab_val=0",
    );
  });

  it("builds a fixed draft-detail URL from a validated ID", () => {
    expect(buildToutiaoDraftDetailUrl("7520000000000000001")).toBe(
      "https://mp.toutiao.com/mp/agw/article/edit?pgc_id=7520000000000000001&wxstyle=0&format=json",
    );
    expect(() => buildToutiaoDraftDetailUrl("1&format=html")).toThrowError(
      "Invalid Toutiao draft ID",
    );
  });

  it("saves a draft through the current Garr transport", async () => {
    vi.stubGlobal("location", {
      origin: "https://mp.toutiao.com",
      pathname: "/profile_v4/graphic/publish",
    });
    const getVar = vi.fn().mockResolvedValue(2);
    const post = vi.fn().mockResolvedValue({
      code: 0,
      data: { pgc_id: "7520000000000000001" },
    });
    vi.stubGlobal("window", {
      Garr: {
        network: { post },
        abTestUtils: { getVar },
      },
    });

    await expect(saveToutiaoDraftInPage(draftPayload(), 0)).resolves.toEqual({
      ok: true,
      pgcId: "7520000000000000001",
    });
    expect(getVar).toHaveBeenCalledWith("mp_publish", 0);
    expect(post).toHaveBeenCalledWith(
      "/mp/agw/article/publish?source=mp&type=article&aid=1231&mp_publish_ab_val=2",
      draftPayload(),
      { requestId: undefined },
    );
  });

  it("remains self-contained after chrome.scripting serializes the draft transport", async () => {
    vi.stubGlobal("location", {
      origin: "https://mp.toutiao.com",
      pathname: "/profile_v4/graphic/publish",
    });
    const post = vi.fn().mockResolvedValue({
      code: 0,
      data: { pgcId: "7520000000000000001" },
    });
    vi.stubGlobal("window", { Garr: { network: { post } } });
    const serializedTransport = new Function(
      `return (${saveToutiaoDraftInPage.toString()})`,
    )() as typeof saveToutiaoDraftInPage;

    await expect(serializedTransport(draftPayload(), 0)).resolves.toEqual({
      ok: true,
      pgcId: "7520000000000000001",
    });
  });

  it("fails without issuing a second request when Garr rejects", async () => {
    vi.stubGlobal("location", {
      origin: "https://mp.toutiao.com",
      pathname: "/profile_v4/graphic/publish",
    });
    const pageFetch = vi.fn();
    const post = vi
      .fn()
      .mockRejectedValue(new TypeError("cookie=secret-token"));
    vi.stubGlobal("fetch", pageFetch);
    vi.stubGlobal("window", { Garr: { network: { post } } });

    const result = await saveToutiaoDraftInPage(draftPayload(), 0);
    expect(result).toEqual({
      ok: false,
      code: "OUTCOME_UNKNOWN",
      diagnostic: {
        transport: "GARR",
        phase: "POST",
        errorClass: "NETWORK",
      },
    });
    expect(pageFetch).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("secret-token");
  });

  it("treats a server-side Garr failure as an unknown post outcome", async () => {
    vi.stubGlobal("location", {
      origin: "https://mp.toutiao.com",
      pathname: "/profile_v4/graphic/publish",
    });
    const post = vi.fn().mockRejectedValue({
      response: { status: 503, data: "secret-body" },
    });
    vi.stubGlobal("window", { Garr: { network: { post } } });

    const result = await saveToutiaoDraftInPage(draftPayload(), 0);
    expect(result).toEqual({
      ok: false,
      code: "OUTCOME_UNKNOWN",
      diagnostic: {
        transport: "GARR",
        phase: "POST",
        httpStatus: 503,
        errorClass: "UNKNOWN",
      },
    });
    expect(JSON.stringify(result)).not.toContain("secret-body");
  });

  it("keeps even a bounded 4xx Garr rejection outcome unknown", async () => {
    vi.stubGlobal("location", {
      origin: "https://mp.toutiao.com",
      pathname: "/profile_v4/graphic/publish",
    });
    const post = vi.fn().mockRejectedValue({
      response: {
        status: 429,
        data: "cookie=secret-token",
      },
    });
    vi.stubGlobal("window", { Garr: { network: { post } } });

    const result = await saveToutiaoDraftInPage(draftPayload(), 0);
    expect(result).toEqual({
      ok: false,
      code: "OUTCOME_UNKNOWN",
      diagnostic: {
        transport: "GARR",
        phase: "POST",
        httpStatus: 429,
        errorClass: "UNKNOWN",
      },
    });
    expect(JSON.stringify(result)).not.toContain("secret-token");
  });

  it("returns an unknown outcome after a bounded Garr timeout", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("location", {
      origin: "https://mp.toutiao.com",
      pathname: "/profile_v4/graphic/publish",
    });
    const post = vi.fn(() => new Promise<unknown>(() => undefined));
    vi.stubGlobal("window", { Garr: { network: { post } } });

    const resultPromise = saveToutiaoDraftInPage(draftPayload(), 0, 100);
    await vi.advanceTimersByTimeAsync(100);

    await expect(resultPromise).resolves.toEqual({
      ok: false,
      code: "OUTCOME_UNKNOWN",
      diagnostic: {
        transport: "GARR",
        phase: "POST",
        errorClass: "TIMEOUT",
      },
    });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("reports an unavailable page transport without falling back to raw fetch", async () => {
    vi.stubGlobal("location", {
      origin: "https://mp.toutiao.com",
      pathname: "/profile_v4/graphic/publish",
    });
    const pageFetch = vi.fn();
    vi.stubGlobal("fetch", pageFetch);
    vi.stubGlobal("window", {});

    await expect(saveToutiaoDraftInPage(draftPayload(), 0)).resolves.toEqual({
      ok: false,
      code: "TRANSPORT_UNAVAILABLE",
      diagnostic: { transport: "GARR", phase: "PREFLIGHT" },
    });
    expect(pageFetch).not.toHaveBeenCalled();
  });

  it("returns only a bounded platform rejection code", async () => {
    vi.stubGlobal("location", {
      origin: "https://mp.toutiao.com",
      pathname: "/profile_v4/graphic/publish",
    });
    const post = vi.fn().mockResolvedValue({
      code: 2222,
      reason: "cookie=secret-token",
    });
    vi.stubGlobal("window", { Garr: { network: { post } } });

    const result = await saveToutiaoDraftInPage(draftPayload(), 0);
    expect(result).toEqual({
      ok: false,
      code: "PLATFORM_REJECTED",
      diagnostic: {
        transport: "GARR",
        phase: "POST",
        platformCode: 2222,
      },
    });
    expect(JSON.stringify(result)).not.toContain("secret-token");
  });

  it("rejects an untrusted page and an altered draft payload before Garr", async () => {
    const post = vi.fn();
    vi.stubGlobal("window", { Garr: { network: { post } } });
    vi.stubGlobal("location", {
      origin: "https://attacker.example",
      pathname: "/profile_v4/graphic/publish",
    });
    await expect(saveToutiaoDraftInPage(draftPayload(), 0)).resolves.toEqual({
      ok: false,
      code: "UNTRUSTED_PAGE",
      diagnostic: { transport: "GARR", phase: "PREFLIGHT" },
    });

    vi.stubGlobal("location", {
      origin: "https://mp.toutiao.com",
      pathname: "/profile_v4/index",
    });
    await expect(saveToutiaoDraftInPage(draftPayload(), 0)).resolves.toEqual({
      ok: false,
      code: "UNTRUSTED_PAGE",
      diagnostic: { transport: "GARR", phase: "PREFLIGHT" },
    });

    vi.stubGlobal("location", {
      origin: "https://mp.toutiao.com",
      pathname: "/profile_v4/graphic/publish",
    });
    await expect(
      saveToutiaoDraftInPage(
        { ...draftPayload(), save: 1 } as unknown as ReturnType<
          typeof draftPayload
        >,
        0,
      ),
    ).resolves.toEqual({
      ok: false,
      code: "INVALID_REQUEST",
      diagnostic: { transport: "GARR", phase: "PREFLIGHT" },
    });
    expect(post).not.toHaveBeenCalled();
  });

  it("confirms the exact draft through an isolated-world GET", async () => {
    stubHtmlDocument();
    vi.stubGlobal("location", {
      origin: "https://mp.toutiao.com",
      pathname: "/profile_v4/graphic/publish",
    });
    const isolatedFetch = vi.fn().mockResolvedValue(draftDetailResponse());
    vi.stubGlobal("fetch", isolatedFetch);

    await expect(
      confirmToutiaoDraftInIsolatedWorld(
        "7520000000000000001",
        "协议测试",
        "<p>正文</p>",
      ),
    ).resolves.toEqual({
      ok: true,
      pgcId: "7520000000000000001",
    });
    expect(isolatedFetch).toHaveBeenCalledWith(
      buildToutiaoDraftDetailUrl("7520000000000000001"),
      expect.objectContaining({
        method: "GET",
        credentials: "include",
        cache: "no-store",
      }),
    );
  });

  it("confirms semantically identical image HTML after DOM serialization", async () => {
    stubHtmlDocument();
    vi.stubGlobal("location", {
      origin: "https://mp.toutiao.com",
      pathname: "/profile_v4/graphic/publish",
    });
    const expectedContent =
      '<p>A&amp;B</p><div class="pgc-img"><img src="https://p3-sign.byteimg.com/a" web_uri="tos/a" class="" /></div>';
    const confirmedContent =
      '<p>A&#38;B</p>\n<div class="pgc-img"><img class="" web_uri="tos/a" src="https://p3-sign.byteimg.com/a"></div>';
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(draftDetailResponse("图片协议", confirmedContent)),
    );

    await expect(
      confirmToutiaoDraftInIsolatedWorld(
        "7520000000000000001",
        "图片协议",
        expectedContent,
      ),
    ).resolves.toEqual({
      ok: true,
      pgcId: "7520000000000000001",
    });
  });

  it("accepts Toutiao heading, emoji, whitespace, and signed-image normalization", async () => {
    stubHtmlDocument();
    vi.stubGlobal("location", {
      origin: "https://mp.toutiao.com",
      pathname: "/profile_v4/graphic/publish",
    });
    const expectedContent =
      '<h2>\u{1f680} Speed</h2><h3>\u{1f50d} Detail</h3><p>A B</p><div><img src="https://p3-sign.byteimg.com/a?x=1" web_uri="tos/a"></div>';
    const confirmedContent =
      '<h1>Speed</h1><h1>Detail</h1><p>A\nB</p><section><img class="platform" src="https://p6-sign.byteimg.com/other?x=2" web_uri="tos/a"></section>';
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(draftDetailResponse("Protocol", confirmedContent)),
    );

    await expect(
      confirmToutiaoDraftInIsolatedWorld(
        "7520000000000000001",
        "\u{1f680} Protocol",
        expectedContent,
      ),
    ).resolves.toEqual({
      ok: true,
      pgcId: "7520000000000000001",
    });
  });

  it("accepts the supported nested draft-detail envelope", async () => {
    stubHtmlDocument();
    vi.stubGlobal("location", {
      origin: "https://mp.toutiao.com",
      pathname: "/profile_v4/graphic/publish",
    });
    const response = new Response(
      JSON.stringify({
        code: 0,
        data: {
          article: {
            pgc_id: "7520000000000000001",
            title: "Nested protocol",
            content: "<p>Body</p>",
          },
        },
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
    Object.defineProperty(response, "url", {
      value: buildToutiaoDraftDetailUrl("7520000000000000001"),
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

    await expect(
      confirmToutiaoDraftInIsolatedWorld(
        "7520000000000000001",
        "Nested protocol",
        "<p>Body</p>",
      ),
    ).resolves.toEqual({
      ok: true,
      pgcId: "7520000000000000001",
    });
  });

  it("polls a transient draft-detail miss without repeating the POST", async () => {
    vi.useFakeTimers();
    stubHtmlDocument();
    vi.stubGlobal("location", {
      origin: "https://mp.toutiao.com",
      pathname: "/profile_v4/graphic/publish",
    });
    const notFound = new Response("", {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
    Object.defineProperty(notFound, "url", {
      value: buildToutiaoDraftDetailUrl("7520000000000000001"),
    });
    const isolatedFetch = vi
      .fn()
      .mockResolvedValueOnce(notFound)
      .mockResolvedValueOnce(draftDetailResponse());
    vi.stubGlobal("fetch", isolatedFetch);

    const confirmation = confirmToutiaoDraftInIsolatedWorld(
      "7520000000000000001",
      "协议测试",
      "<p>正文</p>",
      2_000,
    );
    await vi.advanceTimersByTimeAsync(200);

    await expect(confirmation).resolves.toEqual({
      ok: true,
      pgcId: "7520000000000000001",
    });
    expect(isolatedFetch).toHaveBeenCalledTimes(2);
  });

  it("retries a stale 200 draft detail until the saved content becomes visible", async () => {
    vi.useFakeTimers();
    stubHtmlDocument();
    vi.stubGlobal("location", {
      origin: "https://mp.toutiao.com",
      pathname: "/profile_v4/graphic/publish",
    });
    let detailReads = 0;
    const isolatedFetch = vi.fn().mockImplementation(() => {
      detailReads += 1;
      return Promise.resolve(
        draftDetailResponse(
          "Protocol",
          detailReads < 6 ? "<p>Stale body</p>" : "<p>Body</p>",
        ),
      );
    });
    vi.stubGlobal("fetch", isolatedFetch);

    const confirmation = confirmToutiaoDraftInIsolatedWorld(
      "7520000000000000001",
      "Protocol",
      "<p>Body</p>",
    );
    await vi.advanceTimersByTimeAsync(4_500);

    await expect(confirmation).resolves.toEqual({
      ok: true,
      pgcId: "7520000000000000001",
    });
    expect(isolatedFetch).toHaveBeenCalledTimes(6);
  });

  it("keeps the isolated confirmation self-contained after serialization", async () => {
    stubHtmlDocument();
    vi.stubGlobal("location", {
      origin: "https://mp.toutiao.com",
      pathname: "/profile_v4/graphic/publish",
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(draftDetailResponse()));
    const serializedConfirmation = new Function(
      `return (${confirmToutiaoDraftInIsolatedWorld.toString()})`,
    )() as typeof confirmToutiaoDraftInIsolatedWorld;

    await expect(
      serializedConfirmation("7520000000000000001", "协议测试", "<p>正文</p>"),
    ).resolves.toEqual({
      ok: true,
      pgcId: "7520000000000000001",
    });
  });

  it("preserves an unquoted 19-digit draft ID during isolated confirmation", async () => {
    stubHtmlDocument();
    vi.stubGlobal("location", {
      origin: "https://mp.toutiao.com",
      pathname: "/profile_v4/graphic/publish",
    });
    const response = new Response(
      '{"pgc_id":7520000000000000001,"title":"协议测试","content":"<p>正文</p>","article_pgc":{"content_cache":{}}}',
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
    Object.defineProperty(response, "url", {
      value: buildToutiaoDraftDetailUrl("7520000000000000001"),
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

    await expect(
      confirmToutiaoDraftInIsolatedWorld(
        "7520000000000000001",
        "协议测试",
        "<p>正文</p>",
      ),
    ).resolves.toEqual({
      ok: true,
      pgcId: "7520000000000000001",
    });
  });

  it("fails closed when the title matches but the article text differs", async () => {
    stubHtmlDocument();
    vi.stubGlobal("location", {
      origin: "https://mp.toutiao.com",
      pathname: "/profile_v4/graphic/publish",
    });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(draftDetailResponse("Same title", "<p>OpenAI</p>")),
    );

    await expect(
      confirmToutiaoDraftInIsolatedWorld(
        "7520000000000000001",
        "Same title",
        "<p>Open AI</p>",
        1,
      ),
    ).resolves.toMatchObject({ ok: false, code: "OUTCOME_UNKNOWN" });
  });

  it("preserves meaningful inline emoji in the article fingerprint", async () => {
    stubHtmlDocument();
    vi.stubGlobal("location", {
      origin: "https://mp.toutiao.com",
      pathname: "/profile_v4/graphic/publish",
    });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          draftDetailResponse("Inline emoji", "<p>Product works</p>"),
        ),
    );

    await expect(
      confirmToutiaoDraftInIsolatedWorld(
        "7520000000000000001",
        "Inline emoji",
        "<p>Product \u{1f44d} works</p>",
        1,
      ),
    ).resolves.toMatchObject({ ok: false, code: "OUTCOME_UNKNOWN" });
  });

  it("fails closed when isolated confirmation evidence mismatches", async () => {
    vi.useFakeTimers();
    stubHtmlDocument();
    vi.stubGlobal("location", {
      origin: "https://mp.toutiao.com",
      pathname: "/profile_v4/graphic/publish",
    });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementation(() =>
          Promise.resolve(draftDetailResponse("另一篇文章", "<p>其他正文</p>")),
        ),
    );

    await expect(
      confirmToutiaoDraftInIsolatedWorld(
        "7520000000000000001",
        "协议测试",
        "<p>正文</p>",
        1,
      ),
    ).resolves.toEqual({
      ok: false,
      code: "OUTCOME_UNKNOWN",
      diagnostic: {
        transport: "ISOLATED",
        phase: "CONFIRM",
      },
    });
  });

  it("builds canonical draft and bounded draft-list URLs", () => {
    expect(buildToutiaoDraftUrl("7520000000000000001")).toBe(
      "https://mp.toutiao.com/profile_v4/graphic/publish?pgc_id=7520000000000000001",
    );

    const probeUrl = new URL(
      buildToutiaoDraftListProbeUrl({
        userId: "7390000000000000001",
        count: 10,
      }),
    );
    expect(probeUrl.origin + probeUrl.pathname).toBe(
      TOUTIAO_SPIKE_ENDPOINTS.draftList,
    );
    expect(Object.fromEntries(probeUrl.searchParams)).toEqual({
      end_cursor: "0",
      start_cursor: "0",
      count: "10",
      type: "all",
      user_id: "7390000000000000001",
    });
    expect(() =>
      buildToutiaoDraftListProbeUrl({
        userId: "7390000000000000001",
        count: 21,
      }),
    ).toThrow("Invalid Toutiao draft count");
  });

  it("accepts only the exact trusted creator-center origin", () => {
    expect(
      isTrustedToutiaoPageUrl(
        "https://mp.toutiao.com/profile_v4/graphic/publish",
      ),
    ).toBe(true);
    expect(
      isTrustedToutiaoPageUrl(
        "https://mp.toutiao.com.attacker.example/profile_v4",
      ),
    ).toBe(false);
    expect(
      isTrustedToutiaoPageUrl(
        "https://user:password@mp.toutiao.com/profile_v4",
      ),
    ).toBe(false);
    expect(
      isTrustedToutiaoPageUrl("https://mp.toutiao.com:8443/profile_v4"),
    ).toBe(false);
    expect(
      isToutiaoEditorPageUrl(
        "https://mp.toutiao.com/profile_v4/graphic/publish?pgc_id=1",
      ),
    ).toBe(true);
    expect(
      isToutiaoEditorPageUrl("https://mp.toutiao.com/profile_v4/index"),
    ).toBe(false);
  });

  it("blocks privileged image targets and unsupported payloads", () => {
    expect(
      isSafeToutiaoImageSourceUrl("https://images.example.com/article.png"),
    ).toBe(true);
    expect(
      isSafeToutiaoImageSourceUrl("data:image/png;base64,iVBORw0KGgo="),
    ).toBe(true);
    expect(isSafeToutiaoImageSourceUrl("http://127.0.0.1/private.png")).toBe(
      false,
    );
    expect(
      isSafeToutiaoImageSourceUrl("http://169.254.169.254/latest/meta-data"),
    ).toBe(false);
    expect(
      isSafeToutiaoImageSourceUrl("https://metadata.google.internal/image.png"),
    ).toBe(false);
    expect(isSafeToutiaoImageSourceUrl("http://localhost./private.png")).toBe(
      false,
    );
    expect(
      isSafeToutiaoImageSourceUrl(
        "https://metadata.google.internal./latest/meta-data",
      ),
    ).toBe(false);
    expect(
      isSafeToutiaoImageSourceUrl("data:image/svg+xml;base64,PHN2Zz4="),
    ).toBe(false);
    expect(isSupportedToutiaoImageMime("image/webp")).toBe(true);
    expect(isSupportedToutiaoImageMime("text/html")).toBe(false);
  });
});
