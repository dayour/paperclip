import { useSyncExternalStore } from "react";
import type {
  BridgeDenyFlashPayload,
  BridgeSessionPayload,
} from "../ipc/bridgeChannels";

export type BridgeSessionState =
  | { kind: "idle" }
  | {
      kind: "active" | "amber" | "expired";
      jti: string;
      shortId: string;
      iat: number;
      exp: number;
      capabilityCount: number;
      capabilities: NonNullable<BridgeSessionPayload>["capabilities"];
    };

type Snapshot = {
  session: NonNullable<BridgeSessionPayload> | null;
  latestDenyFlash: BridgeDenyFlashPayload | null;
  activeFlashCount: number;
};

const listeners = new Set<() => void>();

let snapshot: Snapshot = {
  session: null,
  latestDenyFlash: null,
  activeFlashCount: 0,
};

function emit() {
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot() {
  return snapshot;
}

export function deriveBridgeSessionState(
  session: NonNullable<BridgeSessionPayload> | null,
  now: number = Date.now(),
): BridgeSessionState {
  if (!session) return { kind: "idle" };

  const remaining = session.exp - now;
  const kind = remaining <= 0 ? "expired" : remaining <= 60_000 ? "amber" : "active";
  return {
    kind,
    jti: session.jti,
    shortId: `cap-${session.jti.slice(0, 4)}`,
    iat: session.iat,
    exp: session.exp,
    capabilityCount: session.capabilityCount,
    capabilities: session.capabilities,
  };
}

export function useBridgeSessionStore() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export const __bridgeSessionStoreTestUtils = {
  enqueueDenyFlash(payload: BridgeDenyFlashPayload) {
    snapshot = {
      ...snapshot,
      latestDenyFlash: payload,
      activeFlashCount: snapshot.activeFlashCount + 1,
    };
    emit();
    window.setTimeout(() => {
      snapshot = {
        ...snapshot,
        activeFlashCount: Math.max(0, snapshot.activeFlashCount - 1),
      };
      emit();
    }, 3_000);
  },
  reset() {
    snapshot = {
      session: null,
      latestDenyFlash: null,
      activeFlashCount: 0,
    };
    emit();
  },
  setSessionPayload(payload: BridgeSessionPayload) {
    snapshot = {
      ...snapshot,
      session: payload,
    };
    emit();
  },
};
