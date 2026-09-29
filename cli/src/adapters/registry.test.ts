import { expect, it, vi } from "vitest";
import { printCopilotLocalEvent } from "@paperclipai/adapter-copilot-local/cli";
import { getCLIAdapter } from "./registry.js";

it("prints Copilot assistant responses and tool activity in the CLI transcript", () => {
  const adapter = getCLIAdapter("copilot_local");
  const log = vi.spyOn(console, "log").mockImplementation(() => {});

  try {
    expect(adapter.type).toBe("copilot_local");
    expect(adapter.formatStdoutEvent).toBe(printCopilotLocalEvent);
    adapter.formatStdoutEvent(
      JSON.stringify({ type: "assistant.message_delta", data: { deltaContent: "SDK_" } }), false,
    );
    adapter.formatStdoutEvent(
      JSON.stringify({ type: "assistant.message", data: { content: "SDK_OK" } }), false,
    );
    adapter.formatStdoutEvent(
      JSON.stringify({ type: "tool.execution_start", data: { toolName: "read_file", arguments: { path: "example" } } }), false,
    );
    adapter.formatStdoutEvent(
      JSON.stringify({ type: "tool.execution_complete", data: { toolName: "read_file", success: true, result: { content: "read output" } } }), false,
    );
    adapter.formatStdoutEvent(JSON.stringify({ type: "session.idle", data: {} }), false);

    expect(log.mock.calls).toEqual([
      ["SDK_OK"],
      ['[tool: read_file] {"path":"example"}'],
      ["[tool_result: read_file] read output"],
    ]);
  } finally {
    log.mockRestore();
  }
});
