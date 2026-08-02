import type { PlatformAdapter } from "@wechatsync/core";
import {
  PublicationBridgeV3RuntimeSnapshotSchema,
  type PublicationAdapterV3Capability,
  type PublicationAdapterV3Snapshot,
  type PublicationBridgeV3RuntimeSnapshot,
} from "@byfire-dev/publication-bridge-contract/v3";

export const PUBLICATION_BRIDGE_V3_PLATFORM_IDS = [
  "zhihu",
  "sohu",
  "weixin",
  "toutiao",
] as const;

export type PublicationBridgeV3PlatformId =
  (typeof PUBLICATION_BRIDGE_V3_PLATFORM_IDS)[number];

interface PublicationAdapterV3Descriptor {
  adapterVersion: string;
  /** The internal inspector can execute from the stable locator-only v3 wire. */
  locatorOnlyInspection: boolean;
}

/**
 * Producer adapter versions are independent from the extension version. A
 * descriptor version changes only when that platform's v3 behavior changes.
 */
export const PUBLICATION_ADAPTER_V3_DESCRIPTORS = {
  zhihu: { adapterVersion: "1.0.0", locatorOnlyInspection: true },
  sohu: { adapterVersion: "1.0.0", locatorOnlyInspection: true },
  weixin: { adapterVersion: "1.0.0", locatorOnlyInspection: true },
  // Toutiao's current inspector still requires a title hint that v3 does not
  // carry. Publishing remains available; inspection is deliberately not
  // advertised until it accepts stable locators alone.
  toutiao: { adapterVersion: "1.0.0", locatorOnlyInspection: false },
} as const satisfies Record<
  PublicationBridgeV3PlatformId,
  PublicationAdapterV3Descriptor
>;

export function derivePublicationAdapterSnapshotV3(
  platform: PublicationBridgeV3PlatformId,
  adapter: PlatformAdapter | null,
): PublicationAdapterV3Snapshot | null {
  if (!adapter) return null;

  const descriptor = PUBLICATION_ADAPTER_V3_DESCRIPTORS[platform];
  const capabilities: PublicationAdapterV3Capability[] = [];
  const hasIdentity =
    adapter.meta.capabilities.includes("account_binding") &&
    typeof adapter.probeAccounts === "function";

  if (hasIdentity) {
    capabilities.push("adapter.account.identity");
    capabilities.push("adapter.draft.publish");
  }
  if (
    descriptor.locatorOnlyInspection &&
    typeof adapter.inspectPublication === "function" &&
    typeof adapter.provePublishedObservation === "function"
  ) {
    capabilities.push("adapter.publication.inspect");
    capabilities.push("adapter.publication.public-url");
  }
  if (hasIdentity && typeof adapter.openPublicationDraft === "function") {
    capabilities.push("adapter.draft.open");
  }

  return {
    platform,
    adapterVersion: descriptor.adapterVersion,
    capabilities,
  };
}

export function buildPublicationBridgeRuntimeSnapshotV3(
  extensionVersion: string,
  adapters: readonly PublicationAdapterV3Snapshot[],
): PublicationBridgeV3RuntimeSnapshot {
  const hasCapability = (capability: PublicationAdapterV3Capability) =>
    adapters.some((adapter) => adapter.capabilities.includes(capability));

  return PublicationBridgeV3RuntimeSnapshotSchema.parse({
    extensionVersion,
    bridgeCapabilities: [
      ...(hasCapability("adapter.account.identity")
        ? ["bridge.accounts.resolve" as const]
        : []),
      ...(hasCapability("adapter.draft.publish")
        ? [
            "bridge.publication.publish-draft" as const,
            "bridge.publication.operation-query" as const,
          ]
        : []),
      ...(hasCapability("adapter.publication.inspect")
        ? ["bridge.publication.inspect" as const]
        : []),
      ...(hasCapability("adapter.draft.open")
        ? ["bridge.publication.open-draft" as const]
        : []),
    ],
    adapters,
  });
}
