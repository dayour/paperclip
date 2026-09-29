export * from "./index.js";

import type { ServerAdapterModule } from "@paperclipai/adapter-utils";
import { getAdapterSessionManagement } from "@paperclipai/adapter-utils";
import { agentConfigurationDoc } from "./index.js";
import {
  execute,
  testEnvironment,
  listCopilotLocalModels,
  listCopilotLocalSkills,
  syncCopilotLocalSkills,
  sessionCodec,
} from "./server/index.js";

export function createServerAdapter(): ServerAdapterModule {
  return {
    type: "copilot_local",
    execute,
    testEnvironment,
    listSkills: listCopilotLocalSkills,
    syncSkills: syncCopilotLocalSkills,
    sessionCodec,
    sessionManagement: getAdapterSessionManagement("copilot_local") ?? undefined,
    models: [],
    listModels: listCopilotLocalModels,
    supportsLocalAgentJwt: true,
    supportsInstructionsBundle: true,
    instructionsPathKey: "instructionsFilePath",
    requiresMaterializedRuntimeSkills: false,
    agentConfigurationDoc,
    getConfigSchema: () => ({
      fields: [
        {
          key: "transport",
          label: "Execution",
          type: "select",
          default: "sdk",
          options: [
            { value: "sdk", label: "Copilot SDK" },
            { value: "cli", label: "Copilot CLI (legacy)" },
          ],
        },
        {
          key: "isolateSession",
          label: "New session every run",
          type: "toggle",
          default: false,
        },
        {
          key: "dangerouslySkipPermissions",
          label: "Approve tool permissions automatically",
          type: "toggle",
          default: true,
          hint: "Required for unattended tool use. Disable to deny SDK permission prompts.",
        },
        {
          key: "gheHost",
          label: "GitHub Enterprise host",
          type: "text",
          hint: "Optional hostname for GitHub Enterprise authentication.",
        },
        {
          key: "byokBaseUrl",
          label: "Custom model endpoint",
          type: "text",
          hint: "Optional OpenAI-compatible BYOK URL; supply its API key through an environment secret.",
        },
      ],
    }),
  };
}
