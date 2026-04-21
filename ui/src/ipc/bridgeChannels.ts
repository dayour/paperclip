import {
  bridgeDenyFlashPayloadSchema,
  bridgeSessionPayloadSchema,
  type BridgeDenyFlashPayload,
  type BridgeSessionPayload,
} from "@paperclipai/shared";
import { useLiveEventSubscription } from "../context/LiveUpdatesProvider";

export interface BridgeLiveEvents {
  onSessionState: (handler: (p: BridgeSessionPayload) => void) => () => void;
  onDenyFlash: (handler: (p: BridgeDenyFlashPayload) => void) => () => void;
}

export function useBridgeLiveEvents(): BridgeLiveEvents {
  const subscribe = useLiveEventSubscription();

  return {
    onSessionState: (handler) =>
      subscribe((event) => {
        if (event.type !== "bridge.session_state") return;
        const parsed = bridgeSessionPayloadSchema.safeParse(event.payload ?? null);
        if (!parsed.success) return;
        handler(parsed.data);
      }),
    onDenyFlash: (handler) =>
      subscribe((event) => {
        if (event.type !== "bridge.deny_flash") return;
        const parsed = bridgeDenyFlashPayloadSchema.safeParse(event.payload ?? null);
        if (!parsed.success) return;
        handler(parsed.data);
      }),
  };
}
