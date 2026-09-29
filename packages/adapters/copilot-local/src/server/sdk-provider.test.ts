import { describe, expect, it, vi } from "vitest";
import type { CopilotClient, CopilotClientOptions, SessionConfig } from "@github/copilot-sdk";
import { createCopilotSdkAdapter } from "./sdk-provider.js";

function fakeClient(options: {
  failResume?: boolean;
  failSend?: boolean;
  emit?: (event: { type: string; data: Record<string, unknown> }) => void;
} = {}) {
  const start = vi.fn(async () => {});
  const stop = vi.fn(async () => []);
  const disconnect = vi.fn(async () => {});
  const subscribers: Array<(event: { type: string; data: Record<string, unknown> }) => void> = [];
  const send = vi.fn(async () => {
    const message = { type: "assistant.message", data: { content: "done" } };
    options.emit?.(message);
    for (const subscriber of subscribers) subscriber(message);
    for (const subscriber of subscribers) subscriber({ type: "session.idle", data: {} });
  });
  const sendAndWait = vi.fn(async () => {
    options.emit?.({ type: "model.turn_started", data: {} });
    options.emit?.({ type: "assistant.message", data: { content: "done" } });
    options.emit?.({ type: "assistant.usage", data: { inputTokens: 12, outputTokens: 3, cacheReadTokens: 4 } });
    if (options.failSend) throw new Error("model unavailable");
    return { data: { content: "done" } };
  });
  const createSession = vi.fn(async (config: SessionConfig) => {
    options.emit = config.onEvent as typeof options.emit;
    return {
      sessionId: "new-session",
      disconnect,
      send, sendAndWait,
      on: (subscriber: (event: { type: string; data: Record<string, unknown> }) => void) => {
        subscribers.push(subscriber);
        return () => { subscribers.splice(subscribers.indexOf(subscriber), 1); };
      },
    };
  });
  const resumeSession = vi.fn(async (id: string, config: SessionConfig) => {
    if (options.failResume) throw new Error("session not found");
    return createSession(config);
  });
  const listModels = vi.fn(async () => [
    { id: "one", name: "One", capabilities: {} },
    { id: "hidden", name: "Hidden", capabilities: {}, policy: { state: "disabled" } },
    { id: "one", name: "duplicate", capabilities: {} },
    { id: "text-embedding", name: "Embedding", capabilities: {} },
  ]);
  return {
    client: { start, stop, disconnect, createSession, resumeSession, listModels } as unknown as CopilotClient,
    start, stop, disconnect, createSession, resumeSession, send, sendAndWait,
  };
}

describe("Copilot SDK provider", () => {
  it("discovers account models and closes the SDK client", async () => {
    const fake = fakeClient();
    const adapter = createCopilotSdkAdapter({ createClient: () => fake.client });
    expect(await adapter.listModels()).toEqual([{ id: "one", label: "One" }]);
    expect(fake.start).toHaveBeenCalledOnce();
    expect(fake.stop).toHaveBeenCalledOnce();
  });

  it("streams events and returns a resumable session, summary and usage", async () => {
    const fake = fakeClient();
    const lines: string[] = [];
    const createClient = vi.fn((_options: CopilotClientOptions) => fake.client);
    const result = await createCopilotSdkAdapter({ createClient }).run({
      prompt: "work", cwd: process.cwd(), model: "one",
      onStdout: (line) => { lines.push(line); },
    });
    expect(result).toMatchObject({
      exitCode: 0, sessionId: "new-session", summary: "done", model: "one",
      clearSession: false,
      usage: { inputTokens: 12, outputTokens: 3, cachedInputTokens: 4 },
    });
    expect(result.sessionParams).toEqual({ sessionId: "new-session", cwd: process.cwd() });
    expect(lines).toHaveLength(2);
    expect(result.events.map((event) => event.type)).toEqual([
      "model.turn_started", "assistant.message", "assistant.usage",
    ]);
    expect(result.stdout).not.toContain("model.turn_started");
    expect(fake.disconnect).toHaveBeenCalledOnce();
    expect(fake.stop).toHaveBeenCalledOnce();
    expect(createClient).toHaveBeenCalledWith(expect.objectContaining({ workingDirectory: process.cwd() }));
  });

  it("resumes a session and clears stale sessions before retrying", async () => {
    const fake = fakeClient({ failResume: true });
    const result = await createCopilotSdkAdapter({ createClient: () => fake.client }).run({
      prompt: "continue", cwd: process.cwd(), resumeSessionId: "old-session",
    });
    expect(fake.resumeSession).toHaveBeenCalledWith("old-session", expect.any(Object));
    expect(fake.createSession).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ exitCode: 0, clearSession: false, sessionId: "new-session" });
  });

  it("waits for idle without a fixed SDK timer when timeoutSec is zero", async () => {
    const fake = fakeClient();
    const result = await createCopilotSdkAdapter({ createClient: () => fake.client }).run({
      prompt: "work", timeoutMs: 0,
    });
    expect(result).toMatchObject({ exitCode: 0, summary: "done" });
    expect(fake.send).toHaveBeenCalledOnce();
    expect(fake.sendAndWait).not.toHaveBeenCalled();
  });

  it("returns an explicit failure without reporting successful execution", async () => {
    const fake = fakeClient({ failSend: true });
    const result = await createCopilotSdkAdapter({ createClient: () => fake.client }).run({
      prompt: "work",
    });
    expect(result).toMatchObject({ exitCode: 1, errorMessage: "model unavailable" });
    expect(fake.stop).toHaveBeenCalledOnce();
  });
});
