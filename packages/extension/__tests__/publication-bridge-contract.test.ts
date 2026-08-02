import { describe, expect, it } from "vitest";
import {
  PublicationBridgeV3CommandExchangeSchema,
  PublicationBridgeV3PublishEventSchema,
  PublicationBridgeV3RequestSchema,
  PublicationBridgeV3ResponseSchema,
} from "@byfire-dev/publication-bridge-contract/v3";
import {
  INVALID_PUBLICATION_BRIDGE_V3_FIXTURES,
  VALID_PUBLICATION_BRIDGE_V3_FIXTURES,
} from "@byfire-dev/publication-bridge-contract/v3/testing";

const schemas = {
  request: PublicationBridgeV3RequestSchema,
  response: PublicationBridgeV3ResponseSchema,
  event: PublicationBridgeV3PublishEventSchema,
  commandExchange: PublicationBridgeV3CommandExchangeSchema,
} as const;

describe("published Bridge v3 contract package", () => {
  it("accepts every producer fixture consumed by Wechatsync", () => {
    for (const request of VALID_PUBLICATION_BRIDGE_V3_FIXTURES.requests) {
      expect(PublicationBridgeV3RequestSchema.safeParse(request).success).toBe(
        true,
      );
    }
    for (const response of VALID_PUBLICATION_BRIDGE_V3_FIXTURES.responses) {
      expect(
        PublicationBridgeV3ResponseSchema.safeParse(response).success,
      ).toBe(true);
    }
    for (const event of VALID_PUBLICATION_BRIDGE_V3_FIXTURES.events) {
      expect(
        PublicationBridgeV3PublishEventSchema.safeParse(event).success,
      ).toBe(true);
    }
  });

  it("rejects every intentionally invalid shared fixture", () => {
    for (const fixture of INVALID_PUBLICATION_BRIDGE_V3_FIXTURES) {
      expect(
        schemas[fixture.schema].safeParse(fixture.value).success,
        fixture.name,
      ).toBe(false);
    }
  });
});
