export const type = "copilot_local";
export const label = "GitHub Copilot (local)";

export const models: Array<{ id: string; label: string }> = [];

export const agentConfigurationDoc = `# copilot_local agent configuration

## Prerequisites
- Node 20.19+ or 22.12+ and an authenticated GitHub Copilot installation
- Active Copilot subscription (Pro+, Business, Enterprise) — or BYOK configuration
- Authenticated: \`copilot login\` (or \`copilot login --host <ghe-hostname>\` for GHE)

## Config Fields
- **model** — Copilot model to use (e.g. claude-sonnet-4.6, gpt-5.4)
- **cwd** — Working directory for the agent
- **transport** — sdk (default) or cli (legacy; required for command and extraArgs)
- **command** — CLI binary name (only when transport=cli; default: "copilot")
- **gheHost** — GitHub Enterprise hostname (e.g. "mycompany.ghe.com")
- **effort** — Reasoning effort: low, medium, high (default: medium)
- **dangerouslySkipPermissions** (boolean, optional, default true) — approve SDK permission requests automatically, or pass --allow-all-tools for CLI. Set to false to deny SDK prompts or restrict the CLI toolset
- **isolateSession** — If true, starts a fresh session each run (no --resume)
- **byokBaseUrl** — BYOK: Custom OpenAI-compatible endpoint URL
- **byokApiKey** — BYOK: API key for custom endpoint

## Environment Variables
- \`COPILOT_GITHUB_TOKEN\` — Override GitHub token for Copilot auth
- \`COPILOT_PROVIDER_BASE_URL\` — BYOK endpoint (set via byokBaseUrl config)
- \`COPILOT_PROVIDER_API_KEY\` — BYOK API key (set via byokApiKey config)
- \`COPILOT_OFFLINE\` — Set to "true" for air-gapped mode
- \`GH_HOST\` — GitHub Enterprise hostname override
`;
