import { expect, it } from "vitest";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import { buildCopilotLocalConfig } from "./build-config.js";

const values: CreateConfigValues = {
  adapterType: "copilot_local",
  cwd: "",
  promptTemplate: "",
  model: "",
  thinkingEffort: "",
  chrome: false,
  dangerouslySkipPermissions: true,
  search: false,
  fastMode: false,
  dangerouslyBypassSandbox: false,
  command: "",
  args: "",
  extraArgs: "",
  envVars: "",
  envBindings: {},
  url: "",
  bootstrapPrompt: "",
  maxTurnsPerRun: 1000,
  heartbeatEnabled: false,
  intervalSec: 300,
};

it("defaults to SDK execution and preserves CLI and session options", () => {
  expect(buildCopilotLocalConfig(values)).not.toHaveProperty("transport");
  expect(buildCopilotLocalConfig({
    ...values,
    adapterSchemaValues: { transport: "cli", isolateSession: true, gheHost: "example.ghe.com" },
    thinkingEffort: "high",
  })).toMatchObject({
    transport: "cli",
    isolateSession: true,
    gheHost: "example.ghe.com",
    effort: "high",
    dangerouslySkipPermissions: true,
  });
});
