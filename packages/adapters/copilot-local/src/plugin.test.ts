import { describe, expect, it } from "vitest";
import { createServerAdapter } from "./plugin.js";
import { execute, listCopilotLocalModels, sessionCodec } from "./server/index.js";

describe("Copilot server adapter entry point", () => {
  it("uses the same SDK execution and model discovery in built-in and hot-loaded paths", () => {
    const adapter = createServerAdapter();

    expect(adapter.type).toBe("copilot_local");
    expect(adapter.execute).toBe(execute);
    expect(adapter.listModels).toBe(listCopilotLocalModels);
    expect(adapter.models).toEqual([]);
    expect(adapter.sessionCodec).toBe(sessionCodec);
    expect(adapter.sessionManagement?.supportsSessionResume).toBe(true);
    expect(adapter.supportsInstructionsBundle).toBe(true);
    expect(adapter.getConfigSchema?.()).toEqual({
      fields: expect.arrayContaining([
        expect.objectContaining({ key: "transport", default: "sdk" }),
        expect.objectContaining({ key: "isolateSession", default: false }),
        expect.objectContaining({ key: "dangerouslySkipPermissions", default: true }),
      ]),
    });
  });
});
