import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadExternalAdapterPackage } from "../adapters/plugin-loader.js";

describe("Copilot local plugin entry", () => {
  it("loads the workspace package using a portable file URL", async () => {
    const packageDir = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../packages/adapters/copilot-local",
    );
    const adapter = await loadExternalAdapterPackage(
      "@paperclipai/adapter-copilot-local",
      packageDir,
    );

    expect(adapter.type).toBe("copilot_local");
    expect(adapter.listModels).toBeTypeOf("function");
    expect(adapter.getConfigSchema).toBeTypeOf("function");
  });
});
