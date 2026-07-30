import { readFileSync } from "node:fs";

import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  TOUTIAO_ANONYMOUS_HTTP_404_REASON,
  TOUTIAO_ANONYMOUS_SOFT_404_REASON,
  isToutiaoHtmlContentType,
  isToutiaoSoft404Html,
  normalizeToutiaoManagedItemUrl,
  normalizeToutiaoPublicArticleUrl,
  parseToutiaoPublicArticleHtml,
  resolveToutiaoPgcId,
  scanToutiaoPublishedListInPage,
  validateToutiaoPublishedListScanResult,
} from "../toutiao";

const publishedListHtml = readFileSync(
  new URL("../__fixtures__/toutiao-published-list.html", import.meta.url),
  "utf8",
);
const authenticatedArticleHtml = readFileSync(
  new URL(
    "../__fixtures__/toutiao-authenticated-article.html",
    import.meta.url,
  ),
  "utf8",
);
const anonymousSoft404Html = readFileSync(
  new URL("../__fixtures__/toutiao-anonymous-soft-404.html", import.meta.url),
  "utf8",
);

const PGC_ID = "7444000000000000001";
const ITEM_ID = "7667071065847677450";
const TITLE = "统一发布核验协议的设计与实践";

async function scanHtml(
  html: string,
  pgcId = PGC_ID,
  title = TITLE,
  limit = 20,
) {
  const { document } = parseHTML(html);
  vi.stubGlobal("document", document);
  vi.stubGlobal(
    "location",
    new URL("https://mp.toutiao.com/profile_v4/manage/content/all"),
  );
  return scanToutiaoPublishedListInPage(pgcId, title, limit, 0);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Toutiao publication identity URLs", () => {
  it("accepts only exact managed item and canonical article URLs", () => {
    expect(
      normalizeToutiaoManagedItemUrl(
        `https://www.toutiao.com/item/${ITEM_ID}/`,
      ),
    ).toEqual({
      publicItemId: ITEM_ID,
      itemUrl: `https://www.toutiao.com/item/${ITEM_ID}/`,
    });
    expect(
      normalizeToutiaoPublicArticleUrl(
        `https://www.toutiao.com/article/${ITEM_ID}/`,
        ITEM_ID,
      ),
    ).toBe(`https://www.toutiao.com/article/${ITEM_ID}/`);

    expect(
      normalizeToutiaoManagedItemUrl(
        `https://www.toutiao.com/item/${ITEM_ID}/?from=test`,
      ),
    ).toBeNull();
    expect(
      normalizeToutiaoPublicArticleUrl(
        `https://www.toutiao.com/article/${ITEM_ID}/`,
        PGC_ID,
      ),
    ).toBeNull();
    expect(
      normalizeToutiaoPublicArticleUrl(
        `https://attacker.example/article/${ITEM_ID}/`,
        ITEM_ID,
      ),
    ).toBeNull();
  });

  it("resolves the canonical saved draft URL and the observed edit URL", () => {
    expect(
      resolveToutiaoPgcId(
        PGC_ID,
        `https://mp.toutiao.com/profile_v4/graphic/publish?pgc_id=${PGC_ID}`,
      ),
    ).toEqual({ success: true, pgcId: PGC_ID });
    expect(
      resolveToutiaoPgcId(
        undefined,
        `https://mp.toutiao.com/profile_v4/graphic/publish?from=edit&pgc_id=${PGC_ID}`,
      ),
    ).toEqual({ success: true, pgcId: PGC_ID });
    expect(
      resolveToutiaoPgcId(
        PGC_ID,
        `https://mp.toutiao.com/profile_v4/graphic/publish?from=edit&pgc_id=7444000000000000002`,
      ),
    ).toEqual({
      success: false,
      errorCode: "TOUTIAO_PGC_ID_MISMATCH",
    });
    expect(
      resolveToutiaoPgcId(
        PGC_ID,
        `https://mp.toutiao.com/profile_v4/graphic/publish?pgc_id=${PGC_ID}&pgc_id=${PGC_ID}`,
      ),
    ).toEqual({
      success: false,
      errorCode: "TOUTIAO_PGC_ID_INVALID",
    });
  });
});

describe("scanToutiaoPublishedListInPage", () => {
  it("binds the requested pgcId to the real item href without equating the IDs", async () => {
    const result = await scanHtml(publishedListHtml);

    expect(result).toEqual({
      success: true,
      match: "PUBLISHED",
      requestedPgcId: PGC_ID,
      publicItemId: ITEM_ID,
      itemUrl: `https://www.toutiao.com/item/${ITEM_ID}/`,
      publicArticleUrl: `https://www.toutiao.com/article/${ITEM_ID}/`,
      title: TITLE,
      publishedLabel: "已发布",
      scanComplete: true,
    });
  });

  it("returns NOT_FOUND only for a complete bounded scan", async () => {
    const complete = await scanHtml(publishedListHtml, "7444000000000000099");
    expect(complete).toEqual({
      success: true,
      match: "NOT_FOUND",
      requestedPgcId: "7444000000000000099",
      scanComplete: true,
    });

    const incomplete = await scanHtml(
      publishedListHtml.replace("共 4 条内容", "共 5 条内容"),
      "7444000000000000099",
    );
    expect(incomplete).toEqual({
      success: true,
      match: "REVIEW_REQUIRED",
      requestedPgcId: "7444000000000000099",
      scanComplete: false,
      errorCode: "TOUTIAO_PUBLISHED_SCAN_INCOMPLETE",
    });
  });

  it("fails closed for pagination, incomplete rows, and title mismatch", async () => {
    const paginated = await scanHtml(
      publishedListHtml.replace(
        "</body>",
        '<nav class="content-pagination"></nav></body>',
      ),
      "7444000000000000099",
    );
    expect(paginated).toMatchObject({
      success: true,
      match: "REVIEW_REQUIRED",
      scanComplete: false,
    });

    const incompleteMatch = await scanHtml(
      publishedListHtml.replace(
        '<span class="byte-tag">已发布</span>',
        '<span class="byte-tag">审核中</span>',
      ),
    );
    expect(incompleteMatch).toMatchObject({
      success: true,
      match: "REVIEW_REQUIRED",
      errorCode: "TOUTIAO_PUBLISHED_MATCH_INCOMPLETE",
    });

    const titleMismatch = await scanHtml(publishedListHtml, PGC_ID, "另一标题");
    expect(titleMismatch).toMatchObject({
      success: true,
      match: "REVIEW_REQUIRED",
      errorCode: "TOUTIAO_PUBLISHED_TITLE_MISMATCH",
    });
  });

  it.each([
    [
      "pgc_id",
      `from=edit&amp;pgc_id=${PGC_ID}&amp;pgc_id=7444000000000000099`,
    ],
    ["from", `from=edit&amp;from=edit&amp;pgc_id=${PGC_ID}`],
  ])("fails closed for duplicate %s edit-link parameters", async (_, query) => {
    const ambiguous = await scanHtml(
      publishedListHtml.replace(
        `from=edit&amp;pgc_id=${PGC_ID}`,
        query,
      ),
    );

    expect(ambiguous).toMatchObject({
      success: true,
      match: "REVIEW_REQUIRED",
      scanComplete: false,
      errorCode: "TOUTIAO_PUBLISHED_SCAN_INCOMPLETE",
    });
  });

  it("rejects an untrusted page and revalidates isolated-world output", async () => {
    const { document } = parseHTML(publishedListHtml);
    vi.stubGlobal("document", document);
    vi.stubGlobal(
      "location",
      new URL("https://attacker.example/profile_v4/manage/content/all"),
    );
    await expect(
      scanToutiaoPublishedListInPage(PGC_ID, TITLE, 20, 0),
    ).resolves.toEqual({
      success: false,
      errorCode: "TOUTIAO_PUBLISHED_PAGE_UNTRUSTED",
    });

    expect(
      validateToutiaoPublishedListScanResult(
        {
          success: true,
          match: "PUBLISHED",
          requestedPgcId: PGC_ID,
          publicItemId: ITEM_ID,
          itemUrl: `https://www.toutiao.com/item/${ITEM_ID}/`,
          publicArticleUrl: `https://attacker.example/article/${ITEM_ID}/`,
          title: TITLE,
          publishedLabel: "已发布",
          scanComplete: true,
        },
        PGC_ID,
      ),
    ).toBeNull();
  });
});

describe("parseToutiaoPublicArticleHtml", () => {
  it("requires matching canonical, og:url, NewsArticle, author and article body", () => {
    expect(
      parseToutiaoPublicArticleHtml(
        authenticatedArticleHtml,
        ITEM_ID,
        "脱敏头条账号",
      ),
    ).toMatchObject({
      success: true,
      canonicalUrl: `https://www.toutiao.com/article/${ITEM_ID}/`,
      title: TITLE,
      publishedAt: "2026-07-30T01:15:00.000Z",
      authorName: "脱敏头条账号",
      bodyTruncated: false,
    });
  });

  it("rejects author, identity, duplicate canonical and body-shape mismatches", () => {
    expect(
      parseToutiaoPublicArticleHtml(
        authenticatedArticleHtml,
        ITEM_ID,
        "另一个账号",
      ),
    ).toEqual({
      success: false,
      errorCode: "TOUTIAO_PUBLIC_AUTHOR_MISMATCH",
    });

    expect(
      parseToutiaoPublicArticleHtml(
        authenticatedArticleHtml.replaceAll(ITEM_ID, PGC_ID),
        ITEM_ID,
        "脱敏头条账号",
      ),
    ).toEqual({
      success: false,
      errorCode: "TOUTIAO_PUBLIC_IDENTITY_MISMATCH",
    });

    expect(
      parseToutiaoPublicArticleHtml(
        authenticatedArticleHtml.replace(
          "</head>",
          `<link rel="canonical" href="https://www.toutiao.com/article/${ITEM_ID}/" /></head>`,
        ),
        ITEM_ID,
        "脱敏头条账号",
      ),
    ).toEqual({
      success: false,
      errorCode: "TOUTIAO_PUBLIC_IDENTITY_MISMATCH",
    });

    expect(
      parseToutiaoPublicArticleHtml(
        authenticatedArticleHtml.replace(
          'syl-device-pc"',
          'syl-device-pc unexpected"',
        ),
        ITEM_ID,
        "脱敏头条账号",
      ),
    ).toEqual({
      success: false,
      errorCode: "TOUTIAO_PUBLIC_ARTICLE_BODY_INVALID",
    });
  });

  it("distinguishes the anonymous not-found shell from a complete article", () => {
    expect(isToutiaoSoft404Html(anonymousSoft404Html)).toBe(true);
    expect(isToutiaoSoft404Html(authenticatedArticleHtml)).toBe(false);
    expect(TOUTIAO_ANONYMOUS_HTTP_404_REASON).toBe(
      "TOUTIAO_ANONYMOUS_HTTP_404",
    );
    expect(TOUTIAO_ANONYMOUS_SOFT_404_REASON).toBe(
      "TOUTIAO_ANONYMOUS_SOFT_404",
    );
  });

  it("accepts only HTML response media types", () => {
    expect(
      isToutiaoHtmlContentType(
        new Headers({ "content-type": "text/html; charset=utf-8" }),
      ),
    ).toBe(true);
    expect(
      isToutiaoHtmlContentType(
        new Headers({ "content-type": "application/json" }),
      ),
    ).toBe(false);
    expect(isToutiaoHtmlContentType(new Headers())).toBe(false);
  });
});
