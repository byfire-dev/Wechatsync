import type { PlatformAdapter } from "@wechatsync/core";

export type AdapterConstructor = new (...args: unknown[]) => PlatformAdapter;

function getPlatformId(AdapterClass: AdapterConstructor): string | null {
  try {
    const platformId = new AdapterClass().meta?.id;
    return typeof platformId === "string" && platformId.trim()
      ? platformId
      : null;
  } catch {
    return null;
  }
}

export function mergeAdapterClasses(
  publicAdapters: AdapterConstructor[],
  privateAdapters: AdapterConstructor[],
  authoritativePublicIds: ReadonlySet<string>,
): AdapterConstructor[] {
  const merged: AdapterConstructor[] = [];
  const positions = new Map<string, number>();

  for (const AdapterClass of publicAdapters) {
    const platformId = getPlatformId(AdapterClass);
    if (!platformId) continue;

    const existingPosition = positions.get(platformId);
    if (existingPosition !== undefined) {
      merged[existingPosition] = AdapterClass;
    } else {
      positions.set(platformId, merged.length);
      merged.push(AdapterClass);
    }
  }

  for (const AdapterClass of privateAdapters) {
    const platformId = getPlatformId(AdapterClass);
    if (!platformId) continue;

    const existingPosition = positions.get(platformId);
    if (existingPosition !== undefined) {
      if (!authoritativePublicIds.has(platformId)) {
        merged[existingPosition] = AdapterClass;
      }
    } else {
      positions.set(platformId, merged.length);
      merged.push(AdapterClass);
    }
  }

  return merged;
}
