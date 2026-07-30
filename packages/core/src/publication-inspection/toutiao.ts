import { parseHTML } from "linkedom";

export const TOUTIAO_PUBLISHED_LIST_URL =
  "https://mp.toutiao.com/profile_v4/manage/content/all";
export const TOUTIAO_PUBLISHED_LIST_MAX_ITEMS = 20;
export const TOUTIAO_PUBLIC_PAGE_MAX_BYTES = 2 * 1024 * 1024;
export const TOUTIAO_PUBLIC_BODY_TEXT_LIMIT = 50_000;
export const TOUTIAO_ANONYMOUS_HTTP_404_REASON = "TOUTIAO_ANONYMOUS_HTTP_404";
export const TOUTIAO_ANONYMOUS_SOFT_404_REASON = "TOUTIAO_ANONYMOUS_SOFT_404";
export const TOUTIAO_ANONYMOUS_BLOCKED_REASONS = [
  TOUTIAO_ANONYMOUS_HTTP_404_REASON,
  TOUTIAO_ANONYMOUS_SOFT_404_REASON,
] as const;

const TOUTIAO_DECIMAL_ID_PATTERN = /^[1-9]\d{0,31}$/;

export type ToutiaoPgcIdResolution =
  | { success: true; pgcId: string }
  | {
      success: false;
      errorCode:
        | "TOUTIAO_PGC_ID_REQUIRED"
        | "TOUTIAO_PGC_ID_INVALID"
        | "TOUTIAO_PGC_ID_MISMATCH";
    };

export type ToutiaoPublishedListScanResult =
  | {
      success: true;
      match: "PUBLISHED";
      requestedPgcId: string;
      publicItemId: string;
      itemUrl: string;
      publicArticleUrl: string;
      title: string;
      publishedLabel: string;
      scanComplete: boolean;
    }
  | {
      success: true;
      match: "NOT_FOUND";
      requestedPgcId: string;
      scanComplete: true;
    }
  | {
      success: true;
      match: "REVIEW_REQUIRED";
      requestedPgcId: string;
      scanComplete: boolean;
      errorCode:
        | "TOUTIAO_PUBLISHED_MATCH_AMBIGUOUS"
        | "TOUTIAO_PUBLISHED_MATCH_INCOMPLETE"
        | "TOUTIAO_PUBLISHED_TITLE_MISMATCH"
        | "TOUTIAO_PUBLISHED_SCAN_INCOMPLETE";
    }
  | {
      success: false;
      errorCode:
        | "TOUTIAO_PUBLISHED_PAGE_UNTRUSTED"
        | "TOUTIAO_PUBLISHED_DOM_UNAVAILABLE"
        | "TOUTIAO_PUBLISHED_SCAN_INVALID";
    };

export type ToutiaoPublicArticleHtmlResult =
  | {
      success: true;
      canonicalUrl: string;
      title: string;
      publishedAt: string;
      authorName: string;
      bodyText: string;
      bodyTruncated: boolean;
    }
  | {
      success: false;
      errorCode:
        | "TOUTIAO_PUBLIC_HTML_INVALID"
        | "TOUTIAO_PUBLIC_IDENTITY_MISMATCH"
        | "TOUTIAO_PUBLIC_AUTHOR_MISMATCH"
        | "TOUTIAO_PUBLIC_STRUCTURED_DATA_INVALID"
        | "TOUTIAO_PUBLIC_ARTICLE_BODY_INVALID";
    };

interface HtmlNodeLike {
  nodeType: number;
  nodeValue?: string | null;
  tagName?: string;
  childNodes?: ArrayLike<HtmlNodeLike>;
}

const BLOCK_TAGS = new Set([
  "ADDRESS",
  "ARTICLE",
  "ASIDE",
  "BLOCKQUOTE",
  "DIV",
  "DL",
  "FIGCAPTION",
  "FIGURE",
  "FOOTER",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "HEADER",
  "HR",
  "LI",
  "MAIN",
  "OL",
  "P",
  "PRE",
  "SECTION",
  "TABLE",
  "TR",
  "UL",
]);
const SKIPPED_TAGS = new Set(["NOSCRIPT", "SCRIPT", "STYLE", "TEMPLATE"]);

function normalizeText(value: string): string {
  return value
    .replace(/\u00a0/g, " ")
    .replace(/[\t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeInlineText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function collectVisibleText(node: HtmlNodeLike, output: string[]): void {
  if (node.nodeType === 3) {
    output.push(node.nodeValue ?? "");
    return;
  }
  if (node.nodeType !== 1) return;

  const tagName = node.tagName?.toUpperCase() ?? "";
  if (SKIPPED_TAGS.has(tagName)) return;
  const isBlock = BLOCK_TAGS.has(tagName);
  if (isBlock) output.push("\n");
  for (const child of Array.from(node.childNodes ?? [])) {
    collectVisibleText(child, output);
  }
  if (isBlock) output.push("\n");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeDateTime(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 100) return null;
  const milliseconds = Date.parse(value);
  if (
    !Number.isFinite(milliseconds) ||
    milliseconds < Date.UTC(2000, 0, 1) ||
    milliseconds >= Date.UTC(2100, 0, 1)
  ) {
    return null;
  }
  return new Date(milliseconds).toISOString();
}

function jsonLdNodes(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => jsonLdNodes(item));
  }
  if (!isPlainRecord(value)) return [];
  const graph = value["@graph"];
  return graph === undefined ? [value] : [value, ...jsonLdNodes(graph)];
}

function isNewsArticle(value: Record<string, unknown>): boolean {
  const type = value["@type"];
  return (
    type === "NewsArticle" ||
    (Array.isArray(type) && type.includes("NewsArticle"))
  );
}

export function normalizeToutiaoPublicationId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return TOUTIAO_DECIMAL_ID_PATTERN.test(normalized) ? normalized : null;
}

function parseToutiaoDraftUrlPgcId(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const pgcIds = url.searchParams.getAll("pgc_id");
    const fromValues = url.searchParams.getAll("from");
    if (
      url.protocol !== "https:" ||
      url.hostname !== "mp.toutiao.com" ||
      url.port !== "" ||
      url.username !== "" ||
      url.password !== "" ||
      url.pathname.replace(/\/+$/, "") !== "/profile_v4/graphic/publish" ||
      pgcIds.length !== 1 ||
      fromValues.length > 1 ||
      (fromValues.length === 1 && fromValues[0] !== "edit") ||
      url.hash !== ""
    ) {
      return null;
    }
    return normalizeToutiaoPublicationId(pgcIds[0]);
  } catch {
    return null;
  }
}

export function resolveToutiaoPgcId(
  platformPostId: string | undefined,
  draftUrl: string | undefined,
): ToutiaoPgcIdResolution {
  const explicitId =
    platformPostId === undefined
      ? null
      : normalizeToutiaoPublicationId(platformPostId);
  if (platformPostId !== undefined && !explicitId) {
    return { success: false, errorCode: "TOUTIAO_PGC_ID_INVALID" };
  }

  const urlId =
    draftUrl === undefined ? null : parseToutiaoDraftUrlPgcId(draftUrl);
  if (draftUrl !== undefined && !urlId) {
    return { success: false, errorCode: "TOUTIAO_PGC_ID_INVALID" };
  }
  if (explicitId && urlId && explicitId !== urlId) {
    return { success: false, errorCode: "TOUTIAO_PGC_ID_MISMATCH" };
  }

  const pgcId = explicitId ?? urlId;
  return pgcId
    ? { success: true, pgcId }
    : { success: false, errorCode: "TOUTIAO_PGC_ID_REQUIRED" };
}

export function normalizeToutiaoManagedItemUrl(
  value: string,
): { publicItemId: string; itemUrl: string } | null {
  try {
    const url = new URL(value);
    const match = url.pathname.match(/^\/item\/([1-9]\d{0,31})\/?$/);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "www.toutiao.com" ||
      url.port !== "" ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== "" ||
      !match
    ) {
      return null;
    }
    return {
      publicItemId: match[1],
      itemUrl: `https://www.toutiao.com/item/${match[1]}/`,
    };
  } catch {
    return null;
  }
}

export function normalizeToutiaoPublicArticleUrl(
  value: string,
  expectedPublicItemId?: string,
): string | null {
  try {
    const url = new URL(value);
    const match = url.pathname.match(/^\/article\/([1-9]\d{0,31})\/?$/);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "www.toutiao.com" ||
      url.port !== "" ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== "" ||
      !match ||
      (expectedPublicItemId !== undefined && match[1] !== expectedPublicItemId)
    ) {
      return null;
    }
    return `https://www.toutiao.com/article/${match[1]}/`;
  } catch {
    return null;
  }
}

/**
 * Revalidate the isolated-world return value before the adapter treats it as
 * platform evidence. Only a freshly reconstructed, bounded shape is returned.
 */
export function validateToutiaoPublishedListScanResult(
  value: unknown,
  requestedPgcId: string,
): ToutiaoPublishedListScanResult | null {
  const expectedPgcId = normalizeToutiaoPublicationId(requestedPgcId);
  if (!expectedPgcId || !isPlainRecord(value)) return null;

  if (value.success === false) {
    const allowedErrors = new Set([
      "TOUTIAO_PUBLISHED_PAGE_UNTRUSTED",
      "TOUTIAO_PUBLISHED_DOM_UNAVAILABLE",
      "TOUTIAO_PUBLISHED_SCAN_INVALID",
    ]);
    return typeof value.errorCode === "string" &&
      allowedErrors.has(value.errorCode)
      ? {
          success: false,
          errorCode: value.errorCode as Extract<
            ToutiaoPublishedListScanResult,
            { success: false }
          >["errorCode"],
        }
      : null;
  }
  if (
    value.success !== true ||
    value.requestedPgcId !== expectedPgcId ||
    typeof value.match !== "string"
  ) {
    return null;
  }

  if (value.match === "PUBLISHED") {
    const publicItemId = normalizeToutiaoPublicationId(value.publicItemId);
    const itemIdentity =
      typeof value.itemUrl === "string"
        ? normalizeToutiaoManagedItemUrl(value.itemUrl)
        : null;
    const publicArticleUrl =
      typeof value.publicArticleUrl === "string" && publicItemId
        ? normalizeToutiaoPublicArticleUrl(value.publicArticleUrl, publicItemId)
        : null;
    const title =
      typeof value.title === "string" ? normalizeInlineText(value.title) : "";
    if (
      !publicItemId ||
      !itemIdentity ||
      itemIdentity.publicItemId !== publicItemId ||
      !publicArticleUrl ||
      title.length === 0 ||
      title.length > 500 ||
      value.publishedLabel !== "已发布" ||
      typeof value.scanComplete !== "boolean"
    ) {
      return null;
    }
    return {
      success: true,
      match: "PUBLISHED",
      requestedPgcId: expectedPgcId,
      publicItemId,
      itemUrl: itemIdentity.itemUrl,
      publicArticleUrl,
      title,
      publishedLabel: "已发布",
      scanComplete: value.scanComplete,
    };
  }

  if (value.match === "NOT_FOUND") {
    return value.scanComplete === true
      ? {
          success: true,
          match: "NOT_FOUND",
          requestedPgcId: expectedPgcId,
          scanComplete: true,
        }
      : null;
  }

  if (value.match === "REVIEW_REQUIRED") {
    const allowedErrors = new Set([
      "TOUTIAO_PUBLISHED_MATCH_AMBIGUOUS",
      "TOUTIAO_PUBLISHED_MATCH_INCOMPLETE",
      "TOUTIAO_PUBLISHED_TITLE_MISMATCH",
      "TOUTIAO_PUBLISHED_SCAN_INCOMPLETE",
    ]);
    if (
      typeof value.errorCode !== "string" ||
      !allowedErrors.has(value.errorCode) ||
      typeof value.scanComplete !== "boolean"
    ) {
      return null;
    }
    return {
      success: true,
      match: "REVIEW_REQUIRED",
      requestedPgcId: expectedPgcId,
      scanComplete: value.scanComplete,
      errorCode: value.errorCode as Extract<
        ToutiaoPublishedListScanResult,
        { success: true; match: "REVIEW_REQUIRED" }
      >["errorCode"],
    };
  }

  return null;
}

export function isToutiaoHtmlContentType(headers: Headers): boolean {
  try {
    const mediaType = headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    return mediaType === "text/html" || mediaType === "application/xhtml+xml";
  } catch {
    return false;
  }
}

/**
 * Runs in an ISOLATED extension world against a freshly opened creator page.
 *
 * Keep this function self-contained: chrome.scripting serializes only its
 * function body. It reads at most `limit` rows and returns bounded evidence,
 * never raw DOM or page text.
 */
export async function scanToutiaoPublishedListInPage(
  requestedPgcId: string,
  expectedTitle: string,
  limit: number,
  readinessTimeoutMs: number,
): Promise<ToutiaoPublishedListScanResult> {
  const expectedOrigin = "https://mp.toutiao.com";
  const expectedPath = "/profile_v4/manage/content/all";
  const decimalIdPattern = /^[1-9]\d{0,31}$/;
  const safeLimit =
    Number.isSafeInteger(limit) && limit >= 1 && limit <= 20 ? limit : 20;
  const safeTimeout =
    Number.isSafeInteger(readinessTimeoutMs) &&
    readinessTimeoutMs >= 0 &&
    readinessTimeoutMs <= 15_000
      ? readinessTimeoutMs
      : 10_000;
  const normalizeInline = (value: string): string =>
    value.replace(/\s+/g, " ").trim();
  const parsePublicItemUrl = (
    value: string,
  ): { publicItemId: string; itemUrl: string } | null => {
    try {
      const url = new URL(value);
      const match = url.pathname.match(/^\/item\/([1-9]\d{0,31})\/?$/);
      if (
        url.protocol !== "https:" ||
        url.hostname !== "www.toutiao.com" ||
        url.port !== "" ||
        url.username !== "" ||
        url.password !== "" ||
        url.search !== "" ||
        url.hash !== "" ||
        !match
      ) {
        return null;
      }
      return {
        publicItemId: match[1],
        itemUrl: `https://www.toutiao.com/item/${match[1]}/`,
      };
    } catch {
      return null;
    }
  };
  const parseEditPgcId = (value: string): string | null => {
    try {
      const url = new URL(value, expectedOrigin);
      const pgcIds = url.searchParams.getAll("pgc_id");
      const fromValues = url.searchParams.getAll("from");
      const candidate = pgcIds[0];
      if (
        url.origin !== expectedOrigin ||
        url.pathname.replace(/\/+$/, "") !== "/profile_v4/graphic/publish" ||
        pgcIds.length !== 1 ||
        fromValues.length !== 1 ||
        fromValues[0] !== "edit" ||
        !candidate ||
        !decimalIdPattern.test(candidate)
      ) {
        return null;
      }
      return candidate;
    } catch {
      return null;
    }
  };

  if (
    location.origin !== expectedOrigin ||
    location.pathname.replace(/\/+$/, "") !== expectedPath ||
    !decimalIdPattern.test(requestedPgcId)
  ) {
    return { success: false, errorCode: "TOUTIAO_PUBLISHED_PAGE_UNTRUSTED" };
  }

  const deadline = Date.now() + safeTimeout;
  while (true) {
    const summary = document.querySelector(".search-result");
    const cards = document.querySelectorAll(".article-card");
    if (
      summary &&
      (cards.length > 0 || /共\s*0\s*条内容/.test(summary.textContent ?? ""))
    ) {
      break;
    }
    if (Date.now() >= deadline) {
      return { success: false, errorCode: "TOUTIAO_PUBLISHED_DOM_UNAVAILABLE" };
    }
    await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 100));
  }

  try {
    const summaryNodes = document.querySelectorAll(".search-result");
    const allCards = document.querySelectorAll(".article-card");
    const hasPagination =
      document.querySelector(".content-pagination") !== null;
    const totalMatch =
      summaryNodes.length === 1
        ? normalizeInline(summaryNodes[0].textContent ?? "").match(
            /^共\s*(\d{1,6})\s*条内容$/,
          )
        : null;
    const totalCount = totalMatch ? Number(totalMatch[1]) : null;
    const expectedNormalizedTitle = normalizeInline(expectedTitle).slice(
      0,
      500,
    );

    type SanitizedRow = {
      pgcId: string | null;
      publicItemId: string | null;
      itemUrl: string | null;
      title: string | null;
      publishedLabel: string | null;
      valid: boolean;
    };

    const rows: SanitizedRow[] = [];
    for (
      let index = 0;
      index < allCards.length && index < safeLimit;
      index += 1
    ) {
      const card = allCards[index];
      const titleAnchors = card.querySelectorAll("a.title[href]");
      const titleAnchor = titleAnchors.length === 1 ? titleAnchors[0] : null;
      const publicIdentity = titleAnchor
        ? parsePublicItemUrl(titleAnchor.getAttribute("href") ?? "")
        : null;
      const title = titleAnchor
        ? normalizeInline(titleAnchor.textContent ?? "").slice(0, 500) || null
        : null;

      const editIds = Array.from(card.querySelectorAll("a[href]"))
        .map((anchor) => parseEditPgcId(anchor.getAttribute("href") ?? ""))
        .filter((value): value is string => value !== null);
      const uniqueEditIds = Array.from(new Set(editIds));
      const pgcId = uniqueEditIds.length === 1 ? uniqueEditIds[0] : null;

      const statusNodes = card.querySelectorAll(".byte-tag");
      const publishedLabel =
        statusNodes.length === 1
          ? normalizeInline(statusNodes[0].textContent ?? "")
          : null;
      const timeNodes = card.querySelectorAll(".create-time");
      const timeLabel =
        timeNodes.length === 1
          ? normalizeInline(timeNodes[0].textContent ?? "")
          : null;

      rows.push({
        pgcId,
        publicItemId: publicIdentity?.publicItemId ?? null,
        itemUrl: publicIdentity?.itemUrl ?? null,
        title,
        publishedLabel,
        valid:
          pgcId !== null &&
          publicIdentity !== null &&
          title !== null &&
          publishedLabel === "已发布" &&
          timeLabel !== null &&
          /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01]) ([01]\d|2[0-3]):[0-5]\d$/.test(
            timeLabel,
          ),
      });
    }

    const allRowsValid =
      allCards.length <= safeLimit &&
      rows.length === allCards.length &&
      rows.every((row) => row.valid);
    const scanComplete =
      totalCount !== null &&
      totalCount === allCards.length &&
      allCards.length <= safeLimit &&
      !hasPagination &&
      allRowsValid;
    const candidates = rows.filter((row) => row.pgcId === requestedPgcId);

    if (candidates.length > 1) {
      return {
        success: true,
        match: "REVIEW_REQUIRED",
        requestedPgcId,
        scanComplete,
        errorCode: "TOUTIAO_PUBLISHED_MATCH_AMBIGUOUS",
      };
    }
    if (candidates.length === 1) {
      const match = candidates[0];
      if (
        !match.valid ||
        !match.publicItemId ||
        !match.itemUrl ||
        !match.title ||
        !match.publishedLabel
      ) {
        return {
          success: true,
          match: "REVIEW_REQUIRED",
          requestedPgcId,
          scanComplete,
          errorCode: "TOUTIAO_PUBLISHED_MATCH_INCOMPLETE",
        };
      }
      if (match.title !== expectedNormalizedTitle) {
        return {
          success: true,
          match: "REVIEW_REQUIRED",
          requestedPgcId,
          scanComplete,
          errorCode: "TOUTIAO_PUBLISHED_TITLE_MISMATCH",
        };
      }
      return {
        success: true,
        match: "PUBLISHED",
        requestedPgcId,
        publicItemId: match.publicItemId,
        itemUrl: match.itemUrl,
        publicArticleUrl: `https://www.toutiao.com/article/${match.publicItemId}/`,
        title: match.title,
        publishedLabel: match.publishedLabel,
        scanComplete,
      };
    }

    if (scanComplete) {
      return {
        success: true,
        match: "NOT_FOUND",
        requestedPgcId,
        scanComplete: true,
      };
    }
    return {
      success: true,
      match: "REVIEW_REQUIRED",
      requestedPgcId,
      scanComplete: false,
      errorCode: "TOUTIAO_PUBLISHED_SCAN_INCOMPLETE",
    };
  } catch {
    return { success: false, errorCode: "TOUTIAO_PUBLISHED_SCAN_INVALID" };
  }
}

export function isToutiaoSoft404Html(html: string): boolean {
  if (
    typeof html !== "string" ||
    html.length > TOUTIAO_PUBLIC_PAGE_MAX_BYTES * 2
  ) {
    return false;
  }
  try {
    const { document } = parseHTML(html);
    if (
      document.querySelector(
        "article.syl-article-base.syl-page-article.tt-article-content.syl-device-pc",
      )
    ) {
      return false;
    }
    const title = normalizeInlineText(document.title ?? "");
    const body = normalizeInlineText(document.body?.textContent ?? "").slice(
      0,
      2_000,
    );
    return (
      body.includes("抱歉，你访问的内容不存在") &&
      (title.includes("404错误页") || body.includes("404错误页"))
    );
  } catch {
    return false;
  }
}

/**
 * Parse a complete Toutiao article page only when every independent identity
 * surface agrees with the item ID returned by the authenticated published list.
 */
export function parseToutiaoPublicArticleHtml(
  html: string,
  expectedPublicItemId: string,
  expectedDisplayName: string,
): ToutiaoPublicArticleHtmlResult {
  const itemId = normalizeToutiaoPublicationId(expectedPublicItemId);
  const displayName = normalizeInlineText(expectedDisplayName);
  if (
    !itemId ||
    !displayName ||
    displayName.length > 500 ||
    typeof html !== "string" ||
    html.length === 0 ||
    html.length > TOUTIAO_PUBLIC_PAGE_MAX_BYTES * 2
  ) {
    return { success: false, errorCode: "TOUTIAO_PUBLIC_HTML_INVALID" };
  }

  const expectedCanonicalUrl = `https://www.toutiao.com/article/${itemId}/`;
  try {
    const { document } = parseHTML(html);
    const canonicalLinks = Array.from(
      document.querySelectorAll("link[rel][href]"),
    ).filter((link) =>
      (link.getAttribute("rel") ?? "")
        .toLowerCase()
        .split(/\s+/)
        .includes("canonical"),
    );
    const ogUrlMetas = Array.from(
      document.querySelectorAll("meta[property][content]"),
    ).filter(
      (meta) =>
        (meta.getAttribute("property") ?? "").toLowerCase() === "og:url",
    );
    if (canonicalLinks.length !== 1 || ogUrlMetas.length !== 1) {
      return {
        success: false,
        errorCode: "TOUTIAO_PUBLIC_IDENTITY_MISMATCH",
      };
    }

    const canonicalUrl = normalizeToutiaoPublicArticleUrl(
      canonicalLinks[0].getAttribute("href") ?? "",
      itemId,
    );
    const ogUrl = normalizeToutiaoPublicArticleUrl(
      ogUrlMetas[0].getAttribute("content") ?? "",
      itemId,
    );
    if (
      canonicalUrl !== expectedCanonicalUrl ||
      ogUrl !== expectedCanonicalUrl
    ) {
      return {
        success: false,
        errorCode: "TOUTIAO_PUBLIC_IDENTITY_MISMATCH",
      };
    }

    const structuredNodes: Record<string, unknown>[] = [];
    for (const script of Array.from(
      document.querySelectorAll("script[type]"),
    )) {
      if (
        (script.getAttribute("type") ?? "").trim().toLowerCase() !==
        "application/ld+json"
      ) {
        continue;
      }
      const source = script.textContent ?? "";
      if (
        source.length === 0 ||
        source.length > TOUTIAO_PUBLIC_PAGE_MAX_BYTES
      ) {
        return {
          success: false,
          errorCode: "TOUTIAO_PUBLIC_STRUCTURED_DATA_INVALID",
        };
      }
      try {
        structuredNodes.push(...jsonLdNodes(JSON.parse(source)));
      } catch {
        return {
          success: false,
          errorCode: "TOUTIAO_PUBLIC_STRUCTURED_DATA_INVALID",
        };
      }
    }
    const newsArticles = structuredNodes.filter(isNewsArticle);
    if (newsArticles.length !== 1) {
      return {
        success: false,
        errorCode: "TOUTIAO_PUBLIC_STRUCTURED_DATA_INVALID",
      };
    }

    const newsArticle = newsArticles[0];
    const mainEntity = isPlainRecord(newsArticle.mainEntityOfPage)
      ? newsArticle.mainEntityOfPage
      : null;
    const mainEntityUrl =
      mainEntity && typeof mainEntity["@id"] === "string"
        ? normalizeToutiaoPublicArticleUrl(mainEntity["@id"], itemId)
        : null;
    const title =
      typeof newsArticle.headline === "string"
        ? normalizeInlineText(newsArticle.headline).slice(0, 500)
        : "";
    const publishedAt = normalizeDateTime(newsArticle.datePublished);
    const author = isPlainRecord(newsArticle.author)
      ? newsArticle.author
      : null;
    const authorName =
      author && typeof author.name === "string"
        ? normalizeInlineText(author.name).slice(0, 500)
        : "";
    if (
      mainEntityUrl !== expectedCanonicalUrl ||
      !title ||
      !publishedAt ||
      !authorName
    ) {
      return {
        success: false,
        errorCode: "TOUTIAO_PUBLIC_STRUCTURED_DATA_INVALID",
      };
    }
    if (authorName !== displayName) {
      return {
        success: false,
        errorCode: "TOUTIAO_PUBLIC_AUTHOR_MISMATCH",
      };
    }

    const articleElements = Array.from(
      document.querySelectorAll(
        "article.syl-article-base.syl-page-article.tt-article-content.syl-device-pc",
      ),
    ).filter((article) => {
      const classes = Array.from(article.classList).sort();
      return (
        classes.length === 4 &&
        classes.join(" ") ===
          [
            "syl-article-base",
            "syl-device-pc",
            "syl-page-article",
            "tt-article-content",
          ]
            .sort()
            .join(" ")
      );
    });
    if (articleElements.length !== 1) {
      return {
        success: false,
        errorCode: "TOUTIAO_PUBLIC_ARTICLE_BODY_INVALID",
      };
    }

    const textParts: string[] = [];
    collectVisibleText(
      articleElements[0] as unknown as HtmlNodeLike,
      textParts,
    );
    const fullBodyText = normalizeText(textParts.join(""));
    if (!fullBodyText) {
      return {
        success: false,
        errorCode: "TOUTIAO_PUBLIC_ARTICLE_BODY_INVALID",
      };
    }
    const bodyTruncated = fullBodyText.length > TOUTIAO_PUBLIC_BODY_TEXT_LIMIT;

    return {
      success: true,
      canonicalUrl: expectedCanonicalUrl,
      title,
      publishedAt,
      authorName,
      bodyText: bodyTruncated
        ? fullBodyText.slice(0, TOUTIAO_PUBLIC_BODY_TEXT_LIMIT)
        : fullBodyText,
      bodyTruncated,
    };
  } catch {
    return { success: false, errorCode: "TOUTIAO_PUBLIC_HTML_INVALID" };
  }
}
