import type { UIAdapterModule } from "../types";
import { parseCopilotLocalStdoutLine, buildCopilotLocalConfig } from "@paperclipai/adapter-copilot-local/ui";
import { CopilotLocalConfigFields } from "./config-fields";

export const copilotLocalUIAdapter: UIAdapterModule = {
  type: "copilot_local",
  label: "GitHub Copilot (local)",
  parseStdoutLine: parseCopilotLocalStdoutLine,
  ConfigFields: CopilotLocalConfigFields,
  buildAdapterConfig: buildCopilotLocalConfig,
};
