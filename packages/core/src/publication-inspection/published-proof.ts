import { z } from 'zod'

import type { PublicationPublishedProof } from '../adapters/types'
import { PublicationPublicAccessSchema } from './types'

/**
 * Version-neutral proof that a platform adapter has independently attested the
 * author identity and public evidence needed to expose a PUBLISHED result.
 */
export const PublicationPublishedProofSchema: z.ZodType<PublicationPublishedProof> =
  z
    .object({
      observedAuthorExternalAccountId: z.string().trim().min(1).max(500),
      publicAccess: PublicationPublicAccessSchema,
      bodyTruncated: z.boolean(),
    })
    .strict()
