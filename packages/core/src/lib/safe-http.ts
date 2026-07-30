export type SafeNoRedirectFetchErrorCode =
  | 'SAFE_FETCH_INITIAL_URL_INVALID'
  | 'SAFE_FETCH_REQUEST_FAILED'
  | 'SAFE_FETCH_REDIRECT_REJECTED'
  | 'SAFE_FETCH_RESPONSE_URL_INVALID'

export type SafeNoRedirectFetchResult =
  | {
      success: true
      response: Response
      requestUrl: string
    }
  | {
      success: false
      errorCode: SafeNoRedirectFetchErrorCode
    }

export interface FetchWithValidatedNoRedirectsOptions {
  fetch: (url: string, options?: RequestInit) => Promise<Response>
  initialUrl: string
  validateUrl: (url: string) => string | null
  request?: RequestInit
}

export type BoundedResponseTextErrorCode =
  | 'SAFE_RESPONSE_BODY_MISSING'
  | 'SAFE_RESPONSE_BODY_TOO_LARGE'
  | 'SAFE_RESPONSE_BODY_READ_ERROR'

export type BoundedResponseTextResult =
  | {
      success: true
      text: string
    }
  | {
      success: false
      errorCode: BoundedResponseTextErrorCode
    }

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

function safelyValidateUrl(
  validateUrl: (url: string) => string | null,
  url: string,
): string | null {
  try {
    return validateUrl(url)
  } catch {
    return null
  }
}

/**
 * Release a response body without retaining attacker-controlled bytes.
 *
 * Runtime implementations may attach request deadlines to body consumption,
 * so every metadata-only rejection must explicitly cancel the body.
 */
export async function discardResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // Rejection paths must stay deterministic even if the transport already
    // closed or another consumer locked the stream.
  }
}

/**
 * Fetch one prevalidated resource and reject every redirect.
 *
 * Browser Fetch intentionally exposes manual redirects as opaque responses:
 * status 0, no Location header, and no body. A JavaScript redirect follower
 * therefore cannot validate the next URL before the browser requests it.
 * `redirect: "error"` is the only fail-closed Fetch policy: the initial URL is
 * validated before the sole request and any redirect becomes a network error.
 *
 * The successful response remains owned by the caller and must be consumed or
 * discarded.
 */
export async function fetchWithValidatedNoRedirects({
  fetch,
  initialUrl,
  validateUrl,
  request,
}: FetchWithValidatedNoRedirectsOptions): Promise<SafeNoRedirectFetchResult> {
  const requestUrl = safelyValidateUrl(validateUrl, initialUrl)
  if (!requestUrl) {
    return {
      success: false,
      errorCode: 'SAFE_FETCH_INITIAL_URL_INVALID',
    }
  }

  let response: Response
  try {
    response = await fetch(requestUrl, {
      ...request,
      redirect: 'error',
    })
  } catch {
    return {
      success: false,
      errorCode: 'SAFE_FETCH_REQUEST_FAILED',
    }
  }

  if (
    response.type === 'opaqueredirect' ||
    response.redirected ||
    REDIRECT_STATUSES.has(response.status)
  ) {
    await discardResponseBody(response)
    return {
      success: false,
      errorCode: 'SAFE_FETCH_REDIRECT_REJECTED',
    }
  }

  const responseUrl = safelyValidateUrl(validateUrl, response.url)
  if (
    response.type === 'opaque' ||
    response.type === 'error' ||
    response.status === 0 ||
    !responseUrl ||
    responseUrl !== requestUrl
  ) {
    await discardResponseBody(response)
    return {
      success: false,
      errorCode: 'SAFE_FETCH_RESPONSE_URL_INVALID',
    }
  }

  return {
    success: true,
    response,
    requestUrl,
  }
}

async function cancelReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<void> {
  try {
    await reader.cancel()
  } catch {
    // Preserve the fixed read result even when cancellation races transport
    // shutdown.
  }
}

/**
 * Read the decoded Fetch body with a hard byte ceiling.
 *
 * Fetch exposes response.body after content decoding, so counting stream
 * chunks bounds decompressed bytes. Content-Length is only an early rejection;
 * chunked and unknown-length responses are still bounded while streaming.
 */
export async function readBoundedResponseText(
  response: Response,
  maxBytes: number,
): Promise<BoundedResponseTextResult> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError('maxBytes must be a non-negative safe integer')
  }

  let declaredLength: string | null
  try {
    declaredLength = response.headers.get('content-length')
  } catch {
    await discardResponseBody(response)
    return {
      success: false,
      errorCode: 'SAFE_RESPONSE_BODY_READ_ERROR',
    }
  }

  if (declaredLength && /^\d+$/.test(declaredLength)) {
    try {
      if (BigInt(declaredLength) > BigInt(maxBytes)) {
        await discardResponseBody(response)
        return {
          success: false,
          errorCode: 'SAFE_RESPONSE_BODY_TOO_LARGE',
        }
      }
    } catch {
      await discardResponseBody(response)
      return {
        success: false,
        errorCode: 'SAFE_RESPONSE_BODY_READ_ERROR',
      }
    }
  }

  if (!response.body) {
    return {
      success: false,
      errorCode: 'SAFE_RESPONSE_BODY_MISSING',
    }
  }

  let reader: ReadableStreamDefaultReader<Uint8Array>
  try {
    reader = response.body.getReader()
  } catch {
    await discardResponseBody(response)
    return {
      success: false,
      errorCode: 'SAFE_RESPONSE_BODY_READ_ERROR',
    }
  }

  const decoder = new TextDecoder()
  const textChunks: string[] = []
  let totalBytes = 0

  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      if (chunk.value.byteLength > maxBytes - totalBytes) {
        await cancelReader(reader)
        return {
          success: false,
          errorCode: 'SAFE_RESPONSE_BODY_TOO_LARGE',
        }
      }
      totalBytes += chunk.value.byteLength
      textChunks.push(decoder.decode(chunk.value, { stream: true }))
    }
    textChunks.push(decoder.decode())
    return {
      success: true,
      text: textChunks.join(''),
    }
  } catch {
    await cancelReader(reader)
    return {
      success: false,
      errorCode: 'SAFE_RESPONSE_BODY_READ_ERROR',
    }
  }
}
