import { describe, expect, it } from "vitest";
import type { PlatformAdapter } from "@wechatsync/core";
import {
  mergeAdapterClasses,
  type AdapterConstructor,
} from "../src/adapters/adapter-classes";

function adapterClass(id: string, source: string): AdapterConstructor {
  return class {
    meta = {
      id,
      name: source,
      icon: "",
      homepage: "",
      capabilities: [],
    };
  } as unknown as AdapterConstructor;
}

describe("mergeAdapterClasses", () => {
  it("keeps the public self-owned adapter for duplicate platform IDs", () => {
    const PublicToutiao = adapterClass("toutiao", "public");
    const PrivateToutiao = adapterClass("toutiao", "private");
    const PublicZhihu = adapterClass("zhihu", "public");
    const PrivateZhihu = adapterClass("zhihu", "private");
    const PrivateOnly = adapterClass("private-only", "private");

    const merged = mergeAdapterClasses(
      [PublicToutiao, PublicZhihu],
      [PrivateToutiao, PrivateZhihu, PrivateOnly],
      new Set(["toutiao"]),
    );
    const instances = merged.map(
      (AdapterClass) => new AdapterClass() as PlatformAdapter,
    );

    expect(instances.map((adapter) => adapter.meta.id)).toEqual([
      "toutiao",
      "zhihu",
      "private-only",
    ]);
    expect(instances[0].meta.name).toBe("public");
    expect(instances[1].meta.name).toBe("private");
  });
});
