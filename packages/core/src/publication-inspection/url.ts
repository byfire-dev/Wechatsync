import type { PublicationPlatform } from './types'

export type PublicationSurface = 'DRAFT' | 'PUBLISHED' | 'UNKNOWN'

export interface ParsedPublicationUrl {
  platform: PublicationPlatform
  surface: PublicationSurface
  postId?: string
  accountId?: string
  canonicalUrl?: string
}

const ZHIHU_ALLOWED_HOSTS = new Set(['www.zhihu.com', 'zhuanlan.zhihu.com'])
const SOHU_ALLOWED_HOSTS = new Set(['mp.sohu.com', 'www.sohu.com'])
const SOHU_DRAFT_PATH = '/mpfe/v4/contentManagement/news/addarticle'

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
  if (url.hostname === 'www.sohu.com' && articleMatch) {
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

/**
 * Parse only URL shapes verified for an active publication inspector.
 * Paused platform vocabulary remains in the protocol, but its URLs are not
 * inferred until that platform has passed the same rollout gate.
 */
export function parsePublicationUrl(
  platform: PublicationPlatform,
  href: string,
): ParsedPublicationUrl | null {
  if (platform !== 'zhihu' && platform !== 'sohu') return null

  const url = safeUrl(href)
  if (!url) return null

  url.hostname = url.hostname.toLowerCase()
  if (platform === 'zhihu') {
    if (!ZHIHU_ALLOWED_HOSTS.has(url.hostname)) return null
    return parseZhihu(url)
  }

  if (!SOHU_ALLOWED_HOSTS.has(url.hostname)) return null
  return parseSohu(url)
}
