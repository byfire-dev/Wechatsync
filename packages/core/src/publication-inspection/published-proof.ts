import { z } from 'zod'

import type { PublicationInspectionPublishedProof } from './domain'
import { PublicationInspectionPublicAccessSchema } from './domain'

/**
 * Version-neutral proof that a platform adapter has independently attested the
 * author identity and public evidence needed to expose a PUBLISHED result.
 */
export const PublicationPublishedProofSchema: z.ZodType<PublicationInspectionPublishedProof> =
  z
    .object({
      observedAuthorExternalAccountId: z.string().trim().min(1).max(500),
      publicAccess: PublicationInspectionPublicAccessSchema,
      bodyTruncated: z.boolean(),
    })
    .strict()
