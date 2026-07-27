/**
 * 文章内容
 *
 * 内容格式说明：
 * - markdown: 主要内容格式，由 content script 使用 Turndown + 原生 DOM 转换
 * - html: 可选的原始 HTML，某些平台可能需要
 */
export interface Article {
  title: string
  markdown: string    // Markdown 格式内容（主要）
  html?: string       // 原始 HTML（可选，用于某些需要 HTML 的平台）
  summary?: string
  cover?: string
  tags?: string[]
  category?: string
  source?: {
    url: string
    platform: string
  }
}

/**
 * 同步结果
 */
export interface SyncResult {
  platform: string
  success: boolean
  postId?: string
  postUrl?: string
  draftOnly?: boolean  // 是否只保存了草稿
  error?: string
  message?: string  // 额外提示信息
  timestamp: number
}

/**
 * 认证状态
 */
export type AuthProbeStatus =
  | 'AUTHENTICATED'
  | 'NOT_AUTHENTICATED'
  | 'PROBE_FAILED'

export type AuthProbeSource = 'EXTENSION' | 'MAIN_WORLD'

/**
 * Safe, non-sensitive account-probe failures that may cross Bridge v2.
 * Raw response bodies, cookies, headers, URLs and exception messages must
 * never be placed in this field.
 */
export type AuthProbeErrorCode =
  | 'PLATFORM_NOT_FOUND'
  | 'TIMEOUT'
  | 'NETWORK_ERROR'
  | 'HTTP_ERROR'
  | 'REDIRECTED'
  | 'INVALID_CONTENT_TYPE'
  | 'RESPONSE_SCHEMA_MISMATCH'
  | 'ACCOUNT_ID_MISSING'
  | 'PAGE_CONTEXT_UNAVAILABLE'
  | 'UNTRUSTED_PAGE'
  | 'UNKNOWN_ERROR'

export interface AuthResult {
  isAuthenticated: boolean
  username?: string
  userId?: string
  avatar?: string
  error?: string
  probeStatus?: AuthProbeStatus
  probeSource?: AuthProbeSource
  probeErrorCode?: AuthProbeErrorCode
  primaryProbeErrorCode?: AuthProbeErrorCode
}

/**
 * 平台能力
 */
export type PlatformCapability =
  | 'article'      // 发布文章
  | 'draft'        // 草稿支持
  | 'image_upload' // 图片上传
  | 'categories'   // 分类
  | 'tags'         // 标签
  | 'cover'        // 封面图
  | 'schedule'     // 定时发布

/**
 * 平台元信息
 */
export interface PlatformMeta {
  id: string
  name: string
  icon: string
  homepage: string
  capabilities: PlatformCapability[]
}

/**
 * Cookie
 */
export interface Cookie {
  name: string
  value: string
  domain: string
  path?: string
  secure?: boolean
  httpOnly?: boolean
  expirationDate?: number
}

/**
 * Header 规则
 */
export interface HeaderRule {
  id?: string
  urlFilter: string
  headers: Record<string, string>
  resourceTypes?: string[]
}

/**
 * 请求选项
 */
export interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: BodyInit | Record<string, unknown>
  timeout?: number
}
