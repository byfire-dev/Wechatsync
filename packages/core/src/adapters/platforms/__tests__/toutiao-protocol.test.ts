import { describe, expect, it } from "vitest";
import accountFixture from "../__fixtures__/toutiao/account-authenticated.json";
import draftFixture from "../__fixtures__/toutiao/draft-created.json";
import imageFixture from "../__fixtures__/toutiao/image-uploaded.json";
import {
  TOUTIAO_SPIKE_ENDPOINTS,
  buildToutiaoDraftForm,
  buildToutiaoDraftListProbeUrl,
  buildToutiaoDraftUrl,
  createToutiaoTitleId,
  isSafeToutiaoImageSourceUrl,
  isSupportedToutiaoImageMime,
  isTrustedToutiaoPageUrl,
  normalizeToutiaoId,
  parseToutiaoAccountPayload,
  parseToutiaoAccountResponseText,
  parseToutiaoDraftPayload,
  parseToutiaoDraftResponseText,
  parseToutiaoImagePayload,
} from "../toutiao-protocol";

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

  it("parses a string draft ID from a sanitized fixture", () => {
    expect(parseToutiaoDraftPayload(draftFixture)).toEqual({
      ok: true,
      value: { pgcId: "7520000000000000001" },
    });
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

  it("builds the known save-draft form deterministically", () => {
    const titleId = createToutiaoTitleId(1_720_000_000_000, 0.1234);
    const form = buildToutiaoDraftForm({
      title: "协议测试",
      content: "<p>正文</p>",
      titleId,
    });
    const extra = JSON.parse(form.get("extra") || "{}");

    expect(titleId).toBe("1720000000000_1234000000000000");
    expect(createToutiaoTitleId(1_720_000_000_000, 0.000000001)).toBe(
      "1720000000000_0000000010000000",
    );
    expect(form.get("title")).toBe("协议测试");
    expect(form.get("content")).toBe("<p>正文</p>");
    expect(form.get("pgc_id")).toBe("0");
    expect(form.get("save")).toBe("0");
    expect(form.get("timer_status")).toBe("0");
    expect(form.get("draft_form_data")).toBe('{"coverType":3}');
    expect(extra).toMatchObject({
      content_source: 100000000402,
      content_word_cnt: "<p>正文</p>".length,
      gd_ext: {
        from_page: "publisher_mp",
        device_platform: "mp",
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
    expect(
      isSafeToutiaoImageSourceUrl("http://localhost./private.png"),
    ).toBe(false);
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
