import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { validateAdapterModule } from "../adapters/plugin-loader.js";

describe("Copilot local plugin entry", () => {
  it("loads the builtin plugin entry using a portable file URL", async () => {
    const packageDir = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../packages/adapters/copilot-local",
    );
    const entryPoint = pathToFileURL(path.join(packageDir, "src", "plugin.ts"));
    const adapter = validateAdapterModule(
      await import(entryPoint.href),
      "@paperclipai/adapter-copilot-local",
    );

    expect(adapter.type).toBe("copilot_local");
    expect(adapter.listModels).toBeTypeOf("function");
    expect(adapter.getConfigSchema).toBeTypeOf("function");
  });
});
