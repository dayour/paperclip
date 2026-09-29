---
title: GitHub Copilot Local
summary: Run GitHub Copilot SDK agents with account-aware models and resumable sessions
---

`copilot_local` runs Copilot SDK sessions in a local project workspace. Authenticate with `copilot login` first (or use an existing GitHub CLI login). Node 20.19+ or 22.12+ is required. Paperclip installs `@github/copilot-sdk` through its own workspace package; no dependency on another local checkout is needed.

Select **GitHub Copilot** in the agent adapter dropdown or during onboarding. The model picker asks the authenticated SDK client for the models available to that account (disabled and embedding models are excluded). A failed discovery request is shown as an error rather than claiming a model is available. Select a model or leave it blank to use the Copilot default. Use **Test environment** to check SDK connectivity and authentication.

| Config field | Description |
| --- | --- |
| `transport` | `sdk` (default) or `cli` (legacy execution). |
| `model` | Optional SDK model ID, required when using a custom BYOK provider. |
| `cwd` | Local execution directory; project workspace takes precedence. |
| `instructionsFilePath` | Markdown instructions prepended to the run prompt. |
| `effort` | Optional SDK reasoning effort: `low`, `medium`, `high`, `xhigh`, or `max`. |
| `dangerouslySkipPermissions` | Defaults to true for unattended execution; false denies SDK permission prompts. |
| `isolateSession` | Start a new SDK session on every run rather than resuming the saved session ID. |
| `gheHost` | Optional GitHub Enterprise hostname. |
| `byokBaseUrl` | Optional OpenAI-compatible BYOK endpoint; pair with `model` and a credential. |
| `command`, `extraArgs` | Supported only with `transport: "cli"`; the SDK rejects them explicitly. |

SDK runs stream JSON event envelopes to the run transcript and return the session ID, cwd-bound session parameters, summary, token usage and errors to Paperclip's heartbeat runtime. Paperclip resumes an existing session only in the same workspace; if that session has expired, the SDK retries a fresh session and persists the replacement ID. Managed skills are made available to the SDK from the local run workspace. Subscription runs report zero API cost; BYOK runs do not claim a known cost.

For BYOK, configure `byokBaseUrl` and `model`, and supply `COPILOT_PROVIDER_API_KEY` through an agent environment secret reference instead of writing a key into plaintext agent config. `COPILOT_GITHUB_TOKEN` and `GH_HOST` are available for authentication and Enterprise configuration. To retain the older CLI-specific behavior, select **Copilot CLI (legacy)** in the Execution field; CLI environment probes and output parsing remain available.

If an already-running development instance reports `Unknown adapter type: copilot_local`, restart that instance when it is safe to do so. The UI can hot-reload in development, but the server's built-in adapter registry is initialized once per process. After restart, `/api/adapters` should list `copilot_local`, and the company-scoped models endpoint should return the authenticated account's available models.
