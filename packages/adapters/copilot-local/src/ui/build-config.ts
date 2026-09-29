import { buildAdapterEnvConfig, type CreateConfigValues } from "@paperclipai/adapter-utils";

function parseCommaArgs(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function buildCopilotLocalConfig(v: CreateConfigValues): Record<string, unknown> {
  const ac: Record<string, unknown> = {};
  if (v.cwd) ac.cwd = v.cwd;
  if (v.instructionsFilePath) ac.instructionsFilePath = v.instructionsFilePath;
  if (v.promptTemplate) ac.promptTemplate = v.promptTemplate;
  if (v.bootstrapPrompt) ac.bootstrapPromptTemplate = v.bootstrapPrompt;
  if (v.model) ac.model = v.model;
  if (v.command) ac.command = v.command;

  // Copilot-specific fields from adapter schema values
  const schema = v.adapterSchemaValues ?? {};
  const gheHost = typeof schema.gheHost === "string" ? schema.gheHost.trim() : "";
  const effort = (typeof schema.effort === "string" ? schema.effort.trim() : "") ||
    (typeof v.thinkingEffort === "string" ? v.thinkingEffort.trim() : "");
  const byokBaseUrl = typeof schema.byokBaseUrl === "string" ? schema.byokBaseUrl.trim() : "";
  const byokApiKey = typeof schema.byokApiKey === "string" ? schema.byokApiKey.trim() : "";
  const isolateSession = schema.isolateSession === true;
  const transport = schema.transport;
  if (transport === "cli") ac.transport = "cli";

  if (gheHost) ac.gheHost = gheHost;
  if (effort) ac.effort = effort;
  if (byokBaseUrl) ac.byokBaseUrl = byokBaseUrl;
  if (byokApiKey) ac.byokApiKey = byokApiKey;
  if (isolateSession) ac.isolateSession = true;

  ac.dangerouslySkipPermissions = v.dangerouslySkipPermissions;
  ac.timeoutSec = 0;
  ac.graceSec = 20;

  // Environment variables
  const env = buildAdapterEnvConfig(v.envBindings, v.envVars);
  if (Object.keys(env).length > 0) ac.env = env;

  if (v.extraArgs) ac.extraArgs = parseCommaArgs(v.extraArgs);

  return ac;
}
