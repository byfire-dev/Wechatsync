import { beforeEach, describe, expect, it, vi } from "vitest";

import { ExtensionRuntime } from "../src/runtime/extension";
import { chromeMock } from "../vitest.setup";

describe("ExtensionRuntime.tabs.executeScript world", () => {
  const executeScriptMock = vi.fn();

  beforeEach(() => {
    executeScriptMock.mockResolvedValue([{ result: "ok" }]);
    Object.assign(chromeMock, {
      scripting: {
        executeScript: executeScriptMock,
      },
    });
  });

  it("forwards an explicit ISOLATED world", async () => {
    const func = (value: string) => value;

    await expect(
      new ExtensionRuntime().tabs.executeScript(42, func, ["ok"], {
        world: "ISOLATED",
      }),
    ).resolves.toBe("ok");

    expect(executeScriptMock).toHaveBeenCalledWith({
      target: { tabId: 42 },
      world: "ISOLATED",
      func,
      args: ["ok"],
    });
  });

  it("defaults to MAIN when no world option is provided", async () => {
    const func = (value: string) => value;

    await expect(
      new ExtensionRuntime().tabs.executeScript(7, func, ["ok"]),
    ).resolves.toBe("ok");

    expect(executeScriptMock).toHaveBeenCalledWith({
      target: { tabId: 7 },
      world: "MAIN",
      func,
      args: ["ok"],
    });
  });
});
