import type { AdapterConfigFieldsProps } from "../types";
import {
  Field,
  DraftInput,
  ToggleField,
} from "../../components/agent-config-primitives";
import { ChoosePathButton } from "../../components/PathInstructionsModal";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";
const instructionsFileHint =
  "Absolute path to a markdown file (e.g. AGENTS.md) that defines this agent's behavior. Injected into the system prompt at runtime.";

export function CopilotLocalConfigFields({
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
  hideInstructionsFile,
}: AdapterConfigFieldsProps) {
  return (
    <>
      <Field label="Execution" hint="The SDK is the default. Legacy CLI execution supports CLI-only flags.">
        <select
          className={inputClass}
          value={isCreate
            ? String(values!.adapterSchemaValues?.transport ?? "sdk")
            : eff("adapterConfig", "transport", String(config.transport ?? "sdk"))}
          onChange={(event) => {
            const transport = event.target.value;
            if (isCreate) {
              set!({ adapterSchemaValues: { ...values!.adapterSchemaValues, transport } });
            } else {
              mark("adapterConfig", "transport", transport === "sdk" ? undefined : transport);
            }
          }}
        >
          <option value="sdk">Copilot SDK</option>
          <option value="cli">Copilot CLI (legacy)</option>
        </select>
      </Field>
      <ToggleField
        label="Approve tool permissions automatically"
        hint="Required for unattended tool use. Disable to deny SDK permission requests."
        checked={isCreate
          ? values!.dangerouslySkipPermissions
          : eff("adapterConfig", "dangerouslySkipPermissions", config.dangerouslySkipPermissions !== false)}
        onChange={(enabled) =>
          isCreate
            ? set!({ dangerouslySkipPermissions: enabled })
            : mark("adapterConfig", "dangerouslySkipPermissions", enabled)
        }
      />
      <ToggleField
        label="New session every run"
        hint="Do not resume the previous Copilot conversation."
        checked={isCreate
          ? values!.adapterSchemaValues?.isolateSession === true
          : eff("adapterConfig", "isolateSession", config.isolateSession === true)}
        onChange={(enabled) =>
          isCreate
            ? set!({ adapterSchemaValues: { ...values!.adapterSchemaValues, isolateSession: enabled } })
            : mark("adapterConfig", "isolateSession", enabled)
        }
      />
      {!hideInstructionsFile && (
        <Field label="Agent instructions file" hint={instructionsFileHint}>
          <div className="flex items-center gap-2">
            <DraftInput
              value={
                isCreate
                  ? values!.instructionsFilePath ?? ""
                  : eff(
                      "adapterConfig",
                      "instructionsFilePath",
                      String(config.instructionsFilePath ?? ""),
                    )
              }
              onCommit={(v) =>
                isCreate
                  ? set!({ instructionsFilePath: v })
                  : mark("adapterConfig", "instructionsFilePath", v || undefined)
              }
              immediate
              className={inputClass}
              placeholder="/absolute/path/to/AGENTS.md"
            />
            <ChoosePathButton />
          </div>
        </Field>
      )}
    </>
  );
}
