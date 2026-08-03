import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  OpenPublicationDraftRequestSchema,
  OpenPublicationDraftResultSchema,
  PublicationInspectRequestSchema,
  PublicationObservationSchema,
  SyncerAccountsV2DetailedSchema,
  SyncerBridgeInfoSchema,
} from "../v2";

function fixture(relativePath: string): unknown {
  const fixtureUrl = new URL(`../../fixtures/${relativePath}`, import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(fixtureUrl), "utf8"));
}

describe("publication contract conformance fixtures", () => {
  it("keeps the extracted v2 Zhihu observation wire-compatible", () => {
    const value = fixture("v2/zhihu-published.json");
    expect(PublicationObservationSchema.parse(value)).toEqual(value);
  });

  it("keeps the complete extracted v2 command surface wire-compatible", () => {
    const bridgeInfo = fixture("v2/bridge-info.json");
    const accounts = fixture("v2/accounts-detailed.json");
    const inspection = fixture("v2/inspect-request.json");
    const openDraft = fixture("v2/open-weixin-draft.json");
    const openResult = fixture("v2/open-result.json");

    expect(SyncerBridgeInfoSchema.parse(bridgeInfo)).toEqual(bridgeInfo);
    expect(SyncerAccountsV2DetailedSchema.parse(accounts)).toEqual(accounts);
    expect(PublicationInspectRequestSchema.parse(inspection)).toEqual(
      inspection,
    );
    expect(OpenPublicationDraftRequestSchema.parse(openDraft)).toEqual(
      openDraft,
    );
    expect(OpenPublicationDraftResultSchema.parse(openResult)).toEqual(
      openResult,
    );
  });

});
