import path from "node:path";
import {
  CopilotClient,
  type AssistantMessageEvent,
  type CopilotClientOptions,
  type CopilotSession,
  type SessionConfig,
  type SessionEvent,
} from "@github/copilot-sdk";
import { isCopilotLocalStaleSessionError, parseCopilotLocalJsonl } from "./parse.js";

const TRANSCRIPT_EVENTS = new Set([
  "assistant.message_delta", "assistant.message", "assistant.reasoning", "assistant.reasoning_delta",
  "assistant.usage", "assistant.turn_start", "assistant.turn_end",
  "tool.execution_start", "tool.execution_complete", "tool.execution_partial_result", "error",
]);

export interface CopilotSdkOptions {
  cwd?: string;
  env?: Record<string, string>;
  prompt?: string;
  model?: string;
  reasoningEffort?: SessionConfig["reasoningEffort"];
  resumeSessionId?: string | null;
  timeoutMs?: number;
  allowAllTools?: boolean;
  byokBaseUrl?: string;
  byokApiKey?: string;
  skillDirectories?: string[];
  onStdout?: (line: string) => void | Promise<void>;
  clientOptions?: CopilotClientOptions;
  createClient?: (options: CopilotClientOptions) => CopilotClient;
}

function clientOptions(options: CopilotSdkOptions): CopilotClientOptions {
  return {
    ...options.clientOptions,
    workingDirectory: options.cwd,
    env: { ...process.env, ...options.env, ...options.clientOptions?.env },
  };
}

async function withClient<T>(options: CopilotSdkOptions, use: (client: CopilotClient) => Promise<T>): Promise<T> {
  const client = options.createClient?.(clientOptions(options)) ?? new CopilotClient(clientOptions(options));
  try {
    await client.start();
    return await use(client);
  } finally {
    await client.stop();
  }
}

async function sendWithoutTimeout(session: CopilotSession, prompt: string): Promise<AssistantMessageEvent | undefined> {
  let unsubscribe = () => {};
  const completed = new Promise<AssistantMessageEvent | undefined>((resolve, reject) => {
    let lastMessage: AssistantMessageEvent | undefined;
    unsubscribe = session.on((event) => {
      if (event.agentId) return;
      if (event.type === "assistant.message") lastMessage = event;
      if (event.type === "session.idle" && event.data.mode !== "autopilot") resolve(lastMessage);
      if (event.type === "session.error") reject(new Error(event.data.message));
    });
  });
  try {
    await session.send({ prompt });
    return await completed;
  } finally {
    unsubscribe();
  }
}

export async function listCopilotSdkModels(hints: CopilotSdkOptions = {}) {
  return withClient(hints, async (client) => {
    const seen = new Set<string>();
    return (await client.listModels())
      .filter((model) => {
        if (!model.id?.trim() || model.policy?.state === "disabled" ||
            /embedding/i.test(model.id) ||
            seen.has(model.id)) return false;
        seen.add(model.id);
        return true;
      })
      .map((model) => ({ id: model.id, label: model.name || model.id }));
  });
}

export async function runCopilotSdk(options: CopilotSdkOptions) {
  const prompt = options.prompt?.trim();
  if (!prompt) throw new Error("Copilot SDK requires a non-empty prompt.");
  const cwd = path.resolve(options.cwd ?? process.cwd());
  if (options.byokBaseUrl && !options.model) {
    throw new Error("Copilot SDK requires a model when BYOK is configured.");
  }

  return withClient({ ...options, cwd }, async (client) => {
    let events: SessionEvent[] = [];
    let transcriptEvents: SessionEvent[] = [];
    let writes: Promise<void> = Promise.resolve();
    let summary = "";
    let clearSession = false;
    let sessionId: string | null = null;
    let failure: Error | null = null;
    const config: SessionConfig = {
      model: options.model || undefined,
      reasoningEffort: options.reasoningEffort,
      workingDirectory: cwd,
      skillDirectories: options.skillDirectories,
      onPermissionRequest: options.allowAllTools === false
        ? () => ({ kind: "denied-interactively-by-user" })
        : () => ({ kind: "approve-once" }),
      ...(options.byokBaseUrl ? {
        provider: {
          type: "openai" as const,
          baseUrl: options.byokBaseUrl,
          ...(options.byokApiKey ? { apiKey: options.byokApiKey } : {}),
        },
      } : {}),
      onEvent: (event) => {
        events.push(event);
        if (!TRANSCRIPT_EVENTS.has(event.type)) return;
        const line = JSON.stringify(event);
        transcriptEvents.push(event);
        if (event.type === "assistant.message" && !event.agentId &&
            typeof event.data.content === "string") {
          summary = event.data.content;
        }
        if (options.onStdout) {
          writes = writes.then(() => options.onStdout!(line + "\n"));
        }
      },
    };
    const send = async (resume: boolean) => {
      const session = resume
        ? await client.resumeSession(options.resumeSessionId!, config)
        : await client.createSession(config);
      sessionId = session.sessionId;
      try {
        const response = options.timeoutMs === 0
          ? await sendWithoutTimeout(session, prompt)
          : await session.sendAndWait({ prompt }, options.timeoutMs);
        if (!summary && response?.data.content) summary = response.data.content;
      } finally {
        await session.disconnect();
      }
    };
    try {
      try {
        await send(Boolean(options.resumeSessionId));
      } catch (error) {
        if (!options.resumeSessionId ||
            !isCopilotLocalStaleSessionError("", String(error))) throw error;
        clearSession = true;
        sessionId = null;
        events = [];
        transcriptEvents = [];
        summary = "";
        await send(false);
      }
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
    }
    await writes;
    const stdout = transcriptEvents.map((event) => JSON.stringify(event)).join("\n");
    const parsed = parseCopilotLocalJsonl(stdout);
    const usage = { ...parsed.usage };
    for (const event of events) {
      if (event.type !== "assistant.usage") continue;
      const cached = event.data.cacheReadTokens;
      if (typeof cached === "number") usage.cachedInputTokens += cached;
    }
    const errorMessage = failure?.message ?? parsed.errorMessage;
    return {
      exitCode: errorMessage ? 1 : 0,
      timedOut: Boolean(failure && /timeout|timed out/i.test(failure.message)),
      sessionId,
      sessionParams: sessionId ? { sessionId, cwd } : null,
      clearSession: clearSession && !sessionId,
      summary: summary || parsed.summary,
      usage,
      model: parsed.model ?? options.model ?? null,
      errorMessage,
      stdout,
      events,
      stderr: failure?.message ?? "",
    };
  });
}

export function createCopilotSdkAdapter(defaults: CopilotSdkOptions = {}) {
  return {
    type: "copilot_local" as const,
    label: "GitHub Copilot SDK (local)",
    listModels: (hints?: CopilotSdkOptions) => listCopilotSdkModels({ ...defaults, ...hints }),
    run: (options: CopilotSdkOptions) => runCopilotSdk({ ...defaults, ...options }),
  };
}
