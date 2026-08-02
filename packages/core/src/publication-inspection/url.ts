import type { PublicationPlatform } from './types'

export type PublicationSurface = 'DRAFT' | 'PUBLISHED' | 'UNKNOWN'

export interface ParsedPublicationUrl {
  platform: PublicationPlatform
  surface: PublicationSurface
  postId?: string
  accountId?: string
  canonicalUrl?: string
}

/**
 * Stable, cross-runtime identity for one publicly reachable publication.
 *
 * `canonicalUrl` is an identity URL, not necessarily the exact URL fetched by
 * an inspector. Callers must retain the latter separately as `checkedUrl`.
 */
export interface PublicationPublicIdentity {
  key: string
  canonicalUrl: string
}

const ZHIHU_ALLOWED_HOSTS = new Set(['www.zhihu.com', 'zhuanlan.zhihu.com'])
const SOHU_ALLOWED_HOSTS = new Set([
  'mp.sohu.com',
  'www.sohu.com',
  'm.sohu.com',
])
const WEIXIN_ALLOWED_HOSTS = new Set(['mp.weixin.qq.com'])
const TOUTIAO_ALLOWED_HOSTS = new Set(['mp.toutiao.com', 'www.toutiao.com'])
const SOHU_DRAFT_PATH = '/mpfe/v4/contentManagement/news/addarticle'
const WEIXIN_DRAFT_PATH = '/cgi-bin/appmsg'
const TOUTIAO_DRAFT_PATH = '/profile_v4/graphic/publish'

function safeUrl(href: string): URL | null {
  try {
    const url = new URL(href)
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.username !== '' ||
      url.password !== ''
    ) {
      return null
    }
    return url
  } catch {
    return null
  }
}

function cleanPath(pathname: string): string {
  if (pathname === '/') return '/'
  return pathname.replace(/\/+$/, '')
}

function normalizePositiveDecimal(
  value: string | undefined,
): string | undefined {
  const normalized = value?.trim()
  if (!normalized || !/^\d+$/.test(normalized)) return undefined
  const canonical = normalized.replace(/^0+/, '')
  return canonical || undefined
}

function parseZhihu(url: URL): ParsedPublicationUrl {
  const articleMatch = cleanPath(url.pathname).match(/^\/p\/(\d+)(\/edit)?$/)
  if (url.hostname === 'zhuanlan.zhihu.com' && articleMatch) {
    const postId = articleMatch[1]
    const isDraft = Boolean(articleMatch[2])
    return {
      platform: 'zhihu',
      surface: isDraft ? 'DRAFT' : 'PUBLISHED',
      postId,
      canonicalUrl: isDraft
        ? undefined
        : `https://zhuanlan.zhihu.com/p/${postId}`,
    }
  }

  return { platform: 'zhihu', surface: 'UNKNOWN' }
}

function parseSohu(url: URL): ParsedPublicationUrl {
  const pathname = cleanPath(url.pathname)

  if (url.hostname === 'mp.sohu.com' && pathname === SOHU_DRAFT_PATH) {
    const ids = url.searchParams.getAll('id')
    const postId = ids.length === 1 ? ids[0]?.trim() : undefined
    const accountIds = url.searchParams.getAll('accountId')
    const accountId =
      accountIds.length === 0
        ? undefined
        : accountIds.length === 1
          ? accountIds[0]?.trim()
          : ''

    if (
      !postId ||
      !/^\d+$/.test(postId) ||
      (accountId !== undefined && !/^\d+$/.test(accountId))
    ) {
      return { platform: 'sohu', surface: 'UNKNOWN' }
    }

    return {
      platform: 'sohu',
      surface: 'DRAFT',
      postId,
      ...(accountId ? { accountId } : {}),
    }
  }

  const articleMatch = pathname.match(/^\/a\/(\d+)_(\d+)$/)
  if (
    (url.hostname === 'www.sohu.com' || url.hostname === 'm.sohu.com') &&
    articleMatch
  ) {
    const postId = articleMatch[1]
    const accountId = articleMatch[2]
    return {
      platform: 'sohu',
      surface: 'PUBLISHED',
      postId,
      accountId,
      canonicalUrl: `https://www.sohu.com/a/${postId}_${accountId}`,
    }
  }

  return { platform: 'sohu', surface: 'UNKNOWN' }
}

function parseWeixin(url: URL): ParsedPublicationUrl {
  const pathname = cleanPath(url.pathname)
  if (url.protocol !== 'https:' || url.port !== '') {
    return { platform: 'weixin', surface: 'UNKNOWN' }
  }

  if (pathname === WEIXIN_DRAFT_PATH) {
    const appMsgIds = url.searchParams.getAll('appmsgid')
    const actions = url.searchParams.getAll('action')
    const templates = url.searchParams.getAll('t')
    const appMsgId =
      appMsgIds.length === 1
        ? normalizePositiveDecimal(appMsgIds[0])
        : undefined
    const hasVerifiedEditorAction =
      (actions.length === 1 && actions[0] === 'edit') ||
      (templates.length === 1 && templates[0] === 'media/appmsg_edit')
    const hasOnlyVerifiedEditorValues =
      (actions.length === 0 || actions[0] === 'edit') &&
      (templates.length === 0 || templates[0] === 'media/appmsg_edit')

    if (
      url.hash !== '' ||
      !appMsgId ||
      actions.length > 1 ||
      templates.length > 1 ||
      !hasVerifiedEditorAction ||
      !hasOnlyVerifiedEditorValues
    ) {
      return { platform: 'weixin', surface: 'UNKNOWN' }
    }

    return {
      platform: 'weixin',
      surface: 'DRAFT',
      postId: appMsgId,
    }
  }

  if (pathname === '/s') {
    const bizValues = url.searchParams.getAll('__biz')
    const midValues = url.searchParams.getAll('mid')
    const idxValues = url.searchParams.getAll('idx')
    const snValues = url.searchParams.getAll('sn')
    const accountId = bizValues.length === 1 ? bizValues[0]?.trim() : undefined
    const publicMid =
      midValues.length === 1
        ? normalizePositiveDecimal(midValues[0])
        : undefined
    const itemIndex = idxValues.length === 1 ? idxValues[0]?.trim() : undefined
    const signature =
      snValues.length === 0
        ? undefined
        : snValues.length === 1
          ? snValues[0]?.trim()
          : ''

    if (
      !accountId ||
      !normalizeCanonicalBase64(accountId) ||
      !publicMid ||
      !itemIndex ||
      !/^[1-9]\d*$/.test(itemIndex) ||
      (signature !== undefined && !/^[a-f0-9]{32}$/i.test(signature))
    ) {
      return { platform: 'weixin', surface: 'UNKNOWN' }
    }

    const canonical = new URL('https://mp.weixin.qq.com/s')
    canonical.searchParams.set('__biz', accountId)
    canonical.searchParams.set('mid', publicMid)
    canonical.searchParams.set('idx', itemIndex)
    if (signature) canonical.searchParams.set('sn', signature)

    return {
      platform: 'weixin',
      surface: 'PUBLISHED',
      // This is the public URL's mid. Callers must not assume it equals the
      // browser editor's appMsgId without separate platform evidence.
      postId: publicMid,
      accountId,
      canonicalUrl: canonical.toString(),
    }
  }

  const shortLinkMatch = pathname.match(/^\/s\/([A-Za-z0-9_-]{8,128})$/)
  if (shortLinkMatch) {
    return {
      platform: 'weixin',
      surface: 'PUBLISHED',
      canonicalUrl: `https://mp.weixin.qq.com/s/${shortLinkMatch[1]}`,
    }
  }

  return { platform: 'weixin', surface: 'UNKNOWN' }
}

function parseToutiao(url: URL): ParsedPublicationUrl {
  const pathname = cleanPath(url.pathname)
  if (url.protocol !== 'https:' || url.port !== '' || url.hash !== '') {
    return { platform: 'toutiao', surface: 'UNKNOWN' }
  }

  if (url.hostname === 'mp.toutiao.com' && pathname === TOUTIAO_DRAFT_PATH) {
    const pgcIds = url.searchParams.getAll('pgc_id')
    const fromValues = url.searchParams.getAll('from')
    const pgcId =
      pgcIds.length === 1 ? normalizePositiveDecimal(pgcIds[0]) : undefined
    if (
      !pgcId ||
      fromValues.length > 1 ||
      (fromValues.length === 1 && fromValues[0] !== 'edit')
    ) {
      return { platform: 'toutiao', surface: 'UNKNOWN' }
    }
    return {
      platform: 'toutiao',
      surface: 'DRAFT',
      postId: pgcId,
    }
  }

  if (url.hostname === 'www.toutiao.com' && url.search === '') {
    const publicMatch = pathname.match(/^\/(article|item)\/([1-9]\d{0,31})$/)
    if (publicMatch) {
      const [, shape, publicItemId] = publicMatch
      return {
        platform: 'toutiao',
        surface: 'PUBLISHED',
        postId: publicItemId,
        canonicalUrl:
          shape === 'article'
            ? `https://www.toutiao.com/article/${publicItemId}/`
            : `https://www.toutiao.com/item/${publicItemId}`,
      }
    }
  }

  return { platform: 'toutiao', surface: 'UNKNOWN' }
}

/**
 * Parse only URL shapes verified for an active publication inspector.
 * Paused platform vocabulary remains in the protocol, but its URLs are not
 * inferred until that platform has passed the same rollout gate.
 */
export function parsePublicationUrl(
  platform: PublicationPlatform,
  href: string,
): ParsedPublicationUrl | null {
  if (
    platform !== 'zhihu' &&
    platform !== 'sohu' &&
    platform !== 'weixin' &&
    platform !== 'toutiao'
  ) {
    return null
  }

  const url = safeUrl(href)
  if (!url) return null

  url.hostname = url.hostname.toLowerCase()
  if (platform === 'zhihu') {
    if (!ZHIHU_ALLOWED_HOSTS.has(url.hostname)) return null
    return parseZhihu(url)
  }

  if (platform === 'sohu') {
    if (!SOHU_ALLOWED_HOSTS.has(url.hostname)) return null
    return parseSohu(url)
  }

  if (platform === 'toutiao') {
    if (!TOUTIAO_ALLOWED_HOSTS.has(url.hostname)) return null
    return parseToutiao(url)
  }

  if (!WEIXIN_ALLOWED_HOSTS.has(url.hostname)) return null
  return parseWeixin(url)
}

function normalizeCanonicalBase64(value: string): string | null {
  if (value.length < 2 || value.length > 128) return null

  const match = value.match(/^([A-Za-z0-9+/]+)(={0,2})$/)
  const unpadded = match?.[1]
  const suppliedPadding = match?.[2]?.length
  if (!unpadded || suppliedPadding === undefined) return null

  const remainder = unpadded.length % 4
  if (remainder === 1) return null
  const expectedPadding = remainder === 0 ? 0 : 4 - remainder
  if (suppliedPadding !== 0 && suppliedPadding !== expectedPadding) return null

  const lastAlphabetIndex =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.indexOf(
      unpadded.at(-1) ?? '',
    )
  if (
    lastAlphabetIndex < 0 ||
    (remainder === 2 && lastAlphabetIndex % 16 !== 0) ||
    (remainder === 3 && lastAlphabetIndex % 4 !== 0)
  ) {
    return null
  }
  return unpadded
}

/**
 * Derive the same deterministic public identity regardless of harmless URL
 * variants (for example Sohu's desktop/mobile host or WeChat's `sn` token).
 */
export function derivePublicationPublicIdentity(
  platform: PublicationPlatform,
  href: string,
): PublicationPublicIdentity | null {
  const parsed = parsePublicationUrl(platform, href)
  if (!parsed || parsed.surface !== 'PUBLISHED') return null

  if (platform === 'zhihu') {
    if (!parsed.postId || !parsed.canonicalUrl) return null
    return {
      key: `zhihu:post:v1:${parsed.postId}`,
      canonicalUrl: parsed.canonicalUrl,
    }
  }

  if (platform === 'sohu') {
    if (!parsed.postId || !parsed.accountId || !parsed.canonicalUrl) return null
    return {
      key: `sohu:post:v1:${parsed.postId}:${parsed.accountId}`,
      canonicalUrl: parsed.canonicalUrl,
    }
  }

  const url = safeUrl(href)
  if (!url) return null
  url.hostname = url.hostname.toLowerCase()

  if (platform === 'weixin') {
    const pathname = cleanPath(url.pathname)
    const shortLinkMatch = pathname.match(/^\/s\/([A-Za-z0-9_-]{8,128})$/)
    if (shortLinkMatch?.[1]) {
      return {
        key: `weixin:short:v1:${shortLinkMatch[1]}`,
        canonicalUrl: `https://mp.weixin.qq.com/s/${shortLinkMatch[1]}`,
      }
    }

    const bizValues = url.searchParams.getAll('__biz')
    const midValues = url.searchParams.getAll('mid')
    const idxValues = url.searchParams.getAll('idx')
    const biz =
      bizValues.length === 1
        ? normalizeCanonicalBase64(bizValues[0] ?? '')
        : null
    const mid =
      midValues.length === 1
        ? normalizePositiveDecimal(midValues[0])
        : undefined
    const idx =
      idxValues.length === 1
        ? normalizePositiveDecimal(idxValues[0])
        : undefined
    if (!biz || !mid || !idx) return null

    const canonicalUrl = new URL('https://mp.weixin.qq.com/s')
    canonicalUrl.searchParams.set('__biz', biz)
    canonicalUrl.searchParams.set('mid', mid)
    canonicalUrl.searchParams.set('idx', idx)
    return {
      key: `weixin:article:v1:${biz.replace(/\+/g, '-').replace(/\//g, '_')}:${mid}:${idx}`,
      canonicalUrl: canonicalUrl.toString(),
    }
  }

  if (!parsed.postId) return null
  return {
    key: `toutiao:item:v1:${parsed.postId}`,
    canonicalUrl: `https://www.toutiao.com/item/${parsed.postId}`,
  }
}
