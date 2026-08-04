import type {
  OpenPublicationDraftRequest,
  OpenPublicationDraftResult,
  PublicationPlatform,
} from '../publication-inspection/types'
import { parsePublicationUrl } from '../publication-inspection/url'
import type { RuntimeInterface } from '../runtime/interface'
import { resolveAdapterAccountBinding } from './account-binding'
import type {
  AdapterAccount,
  AdapterAccountProbe,
  AdapterOperationContext,
} from './types'

export const TRUSTED_PUBLICATION_DRAFT_OPEN_PLATFORMS = [
  'zhihu',
  'sohu',
  'toutiao',
] as const satisfies readonly PublicationPlatform[]

export type TrustedPublicationDraftOpenPlatform =
  (typeof TRUSTED_PUBLICATION_DRAFT_OPEN_PLATFORMS)[number]

interface TrustedDraftLocatorDescriptor {
  buildEditorUrl(postId: string, account: AdapterAccount): URL
  validateAccount?(account: AdapterAccount): boolean
}

export interface OpenTrustedPublicationDraftOptions {
  expectedPlatform: TrustedPublicationDraftOpenPlatform
  request: OpenPublicationDraftRequest
  runtime: RuntimeInterface
  probeAccounts(
    context?: AdapterOperationContext,
  ): Promise<AdapterAccountProbe>
  context?: AdapterOperationContext
}

const CANONICAL_DECIMAL_ID = /^[1-9]\d{0,31}$/
const SOHU_ACCOUNT_ID = /^[1-9]\d{0,15}$/

function isCanonicalDecimalId(value: string): boolean {
  return CANONICAL_DECIMAL_ID.test(value)
}

const TRUSTED_DRAFT_LOCATORS: Record<
  TrustedPublicationDraftOpenPlatform,
  TrustedDraftLocatorDescriptor
> = {
  zhihu: {
    buildEditorUrl(postId) {
      return new URL(`/p/${postId}/edit`, 'https://zhuanlan.zhihu.com')
    },
  },
  sohu: {
    validateAccount(account) {
      return SOHU_ACCOUNT_ID.test(account.externalAccountId)
    },
    buildEditorUrl(postId, account) {
      const url = new URL(
        '/mpfe/v4/contentManagement/news/addarticle',
        'https://mp.sohu.com',
      )
      url.search = new URLSearchParams({
        spm: 'smmp.articlelist.0.0',
        contentStatus: '2',
        id: postId,
        accountId: account.externalAccountId,
      }).toString()
      return url
    },
  },
  toutiao: {
    buildEditorUrl(postId) {
      const url = new URL(
        '/profile_v4/graphic/publish',
        'https://mp.toutiao.com',
      )
      url.searchParams.set('pgc_id', postId)
      return url
    },
  },
}

function accountSelectionFailureCode(
  errorCode:
    | 'INVALID_ACCOUNT_BINDING'
    | 'ACCOUNT_BINDING_REQUIRED'
    | 'ACCOUNT_BINDING_NOT_FOUND'
    | 'ACCOUNT_NOT_AUTHENTICATED'
    | 'ACCOUNT_PROBE_FAILED',
): string {
  if (errorCode === 'ACCOUNT_NOT_AUTHENTICATED') return 'LOGIN_REQUIRED'
  if (
    errorCode === 'INVALID_ACCOUNT_BINDING' ||
    errorCode === 'ACCOUNT_BINDING_NOT_FOUND'
  ) {
    return 'ACCOUNT_MISMATCH'
  }
  return 'ACCOUNT_AUTH_CHECK_FAILED'
}

/**
 * Resolve a private editor URL exclusively from a canonical platform locator
 * and an adapter-attested account. Caller-provided URLs never enter this path.
 */
export function buildTrustedPublicationDraftUrl(
  platform: TrustedPublicationDraftOpenPlatform,
  platformPostId: string,
  account: AdapterAccount,
): URL {
  if (!isCanonicalDecimalId(platformPostId)) {
    throw new Error('INVALID_DRAFT_POST_ID')
  }

  const descriptor = TRUSTED_DRAFT_LOCATORS[platform]
  if (descriptor.validateAccount && !descriptor.validateAccount(account)) {
    throw new Error('ACCOUNT_MISMATCH')
  }

  const url = descriptor.buildEditorUrl(platformPostId, account)
  const parsed = parsePublicationUrl(platform, url.href)
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    !parsed ||
    parsed.surface !== 'DRAFT' ||
    parsed.postId !== platformPostId ||
    (platform === 'sohu' &&
      parsed.accountId !== account.externalAccountId)
  ) {
    throw new Error('PUBLICATION_DRAFT_OPEN_FAILED')
  }

  return url
}

/**
 * Re-probe and bind the exact current account immediately before opening a
 * private editor. Chrome errors are reduced to stable codes so target URLs
 * can never escape an adapter boundary.
 */
export async function openTrustedPublicationDraft({
  expectedPlatform,
  request,
  runtime,
  probeAccounts,
  context,
}: OpenTrustedPublicationDraftOptions): Promise<OpenPublicationDraftResult> {
  context?.signal?.throwIfAborted()
  if (request.platform !== expectedPlatform) {
    throw new Error('ACCOUNT_MISMATCH')
  }

  let probe: AdapterAccountProbe
  if (context?.verifiedAccountProbe) {
    probe = context.verifiedAccountProbe
  } else {
    try {
      probe = await probeAccounts(context)
    } catch {
      context?.signal?.throwIfAborted()
      throw new Error('ACCOUNT_AUTH_CHECK_FAILED')
    }
  }
  context?.signal?.throwIfAborted()

  const selection = resolveAdapterAccountBinding(probe, {
    externalAccountId: request.externalAccountId,
  })
  if (!selection.ok) {
    throw new Error(accountSelectionFailureCode(selection.errorCode))
  }

  const target = buildTrustedPublicationDraftUrl(
    expectedPlatform,
    request.platformPostId,
    selection.account,
  )
  if (!runtime.tabs) {
    throw new Error('PUBLICATION_DRAFT_OPEN_NOT_SUPPORTED')
  }

  try {
    context?.signal?.throwIfAborted()
    const createdTab = await runtime.tabs.create(target.href, true)
    if (context?.signal?.aborted) {
      try {
        await runtime.tabs.remove?.(createdTab.id)
      } catch {
        // Cancellation is authoritative; do not expose a Chrome exception.
      }
    }
    context?.signal?.throwIfAborted()
  } catch {
    context?.signal?.throwIfAborted()
    throw new Error('PUBLICATION_DRAFT_OPEN_FAILED')
  }

  return { opened: true }
}
