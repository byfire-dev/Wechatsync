import {
  PublicationPlatformV3Schema,
  type PublicationPlatformV3,
} from "@wechatsync/publication-contract/v3";

export interface RegisteredPublicationAdapterCandidate {
  platformId: string;
  inspectPublication?: unknown;
  provePublishedObservation?: unknown;
}

/**
 * Convert live registry entries into the public v3 capability surface.
 * Platform names, callable inspectors and PUBLISHED proof are checked at
 * runtime.
 */
export function deriveRegisteredPublicationInspectorPlatforms(
  candidates: readonly RegisteredPublicationAdapterCandidate[],
): PublicationPlatformV3[] {
  const platforms: PublicationPlatformV3[] = [];
  for (const candidate of candidates) {
    const platform = PublicationPlatformV3Schema.safeParse(
      candidate.platformId,
    );
    if (
      platform.success &&
      typeof candidate.inspectPublication === "function" &&
      typeof candidate.provePublishedObservation === "function" &&
      !platforms.includes(platform.data)
    ) {
      platforms.push(platform.data);
    }
  }
  return platforms;
}
