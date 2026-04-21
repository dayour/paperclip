/**
 * @fileoverview Adapter-level circuit breaker — ADR-0006 / CLI-121
 *
 * State machine per adapter type:
 *   Closed  → (trip condition met)    → Open
 *   Open    → (resumeAt elapsed)      → Half-Open
 *   Half-Open → (probe success × N)   → Closed
 *   Half-Open → (probe failure)       → Open
 *
 * Admin routes (CLI-159) call forceQuarantine() and resetBreaker().
 * Failure accounting (CLI-156 classifyAdapterFailure) calls recordFailure().
 *
 * All state is in-process. The server restart clears the breaker; persistent
 * storage is a follow-up (counters survive until the outage is resolved).
 */

// ── Types ──────────────────────────────────────────────────────────────────

export type CircuitPhase = "Closed" | "Open" | "HalfOpen";

export interface TripEvidence {
  adapterType: string;
  failureReason: string;
  agentId?: string | null;
  occurredAt: number;
}

export interface CircuitState {
  adapterType: string;
  phase: CircuitPhase;
  /** Absolute ms timestamp when the circuit tripped (entered Open). */
  trippedAt: number | null;
  /** Absolute ms timestamp after which Open may transition to HalfOpen. */
  resumeAt: number | null;
  /** Human-readable reason the breaker tripped (e.g., "burst_threshold_exceeded"). */
  tripReason: string | null;
  /** Last N failures that triggered the trip. */
  tripEvidence: TripEvidence[];
  /** Consecutive probe successes in HalfOpen. */
  probeSuccessCount: number;
  /** How many times the breaker has re-tripped within reTripGraceSec. */
  reTripCount: number;
  /** Timestamp of most recent Closed→Open transition for re-trip grace accounting. */
  lastReleasedAt: number | null;
  /** Effective burst threshold (may be halved by re-trip logic). */
  effectiveNBurst: number;
  /** Effective sustained threshold (may be halved by re-trip logic). */
  effectiveNSustained: number;
}

export interface BreakerConfig {
  enabled: boolean;
  nBurst: number;
  tBurstMs: number;
  nSustained: number;
  tSustainedMs: number;
  probeIntervalMs: number;
  probeSuccessCount: number;
  reTripGraceMs: number;
  shadowMode: boolean;
}

export interface AuditRow {
  id: string;
  timestamp: number;
  action: "force_quarantine" | "reset" | "probe_release" | "auto_trip";
  adapterType: string;
  actorType: "board" | "agent" | "system";
  actorId: string;
  outcome: "success" | "rejected";
  rejectionReason?: string;
  details?: Record<string, unknown>;
}

// ── Defaults ───────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: BreakerConfig = {
  enabled: process.env.PAPERCLIP_ADAPTER_BREAKER_ENABLED !== "false",
  nBurst: Number(process.env.PAPERCLIP_ADAPTER_BREAKER_N_BURST ?? 3),
  tBurstMs: Number(process.env.PAPERCLIP_ADAPTER_BREAKER_T_BURST_SEC ?? 60) * 1000,
  nSustained: Number(process.env.PAPERCLIP_ADAPTER_BREAKER_N_SUSTAINED ?? 10),
  tSustainedMs: Number(process.env.PAPERCLIP_ADAPTER_BREAKER_T_SUSTAINED_SEC ?? 600) * 1000,
  probeIntervalMs: Number(process.env.PAPERCLIP_ADAPTER_BREAKER_PROBE_INTERVAL_SEC ?? 30) * 1000,
  probeSuccessCount: Number(process.env.PAPERCLIP_ADAPTER_BREAKER_PROBE_SUCCESS_COUNT ?? 3),
  reTripGraceMs: Number(process.env.PAPERCLIP_ADAPTER_BREAKER_RETRP_GRACE_SEC ?? 120) * 1000,
  shadowMode: process.env.PAPERCLIP_ADAPTER_BREAKER_SHADOW_MODE === "true",
};

// ── State ──────────────────────────────────────────────────────────────────

/** Per-adapter-type circuit state. */
const registry = new Map<string, CircuitState>();

/** Recent failures per adapter type within the bust/sustained windows. */
const failureWindow = new Map<string, TripEvidence[]>();

/** Audit ring buffer — last 500 actions. */
const auditRing: AuditRow[] = [];
const AUDIT_MAX = 500;

let _config: BreakerConfig = { ...DEFAULT_CONFIG };

// ── Helpers ────────────────────────────────────────────────────────────────

function uuidv4(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function getOrInit(adapterType: string): CircuitState {
  if (!registry.has(adapterType)) {
    registry.set(adapterType, {
      adapterType,
      phase: "Closed",
      trippedAt: null,
      resumeAt: null,
      tripReason: null,
      tripEvidence: [],
      probeSuccessCount: 0,
      reTripCount: 0,
      lastReleasedAt: null,
      effectiveNBurst: _config.nBurst,
      effectiveNSustained: _config.nSustained,
    });
  }
  return registry.get(adapterType)!;
}

function writeAudit(row: Omit<AuditRow, "id" | "timestamp">): AuditRow {
  const full: AuditRow = { id: uuidv4(), timestamp: Date.now(), ...row };
  auditRing.push(full);
  if (auditRing.length > AUDIT_MAX) auditRing.shift();
  return full;
}

/** Apply re-trip threshold halving. Returns halved value (floor 1). */
function halveCeil(n: number): number {
  return Math.max(1, Math.ceil(n / 2));
}

function shouldTripBurst(windows: TripEvidence[], nBurst: number, tBurstMs: number, now: number): boolean {
  const cutoff = now - tBurstMs;
  const distinctAgents = new Set(windows.filter((e) => e.occurredAt >= cutoff).map((e) => e.agentId ?? "unknown"));
  return distinctAgents.size >= nBurst;
}

function shouldTripSustained(windows: TripEvidence[], nSustained: number, tSustainedMs: number, now: number): boolean {
  const cutoff = now - tSustainedMs;
  return windows.filter((e) => e.occurredAt >= cutoff).length >= nSustained;
}

function checkAndApplyRetrip(state: CircuitState, now: number): void {
  const { lastReleasedAt, reTripCount } = state;
  const withinGrace = lastReleasedAt !== null && now - lastReleasedAt < _config.reTripGraceMs;
  if (withinGrace) {
    state.reTripCount = reTripCount + 1;
    state.effectiveNBurst = halveCeil(state.effectiveNBurst);
    state.effectiveNSustained = halveCeil(state.effectiveNSustained);
  }
}

function doTrip(state: CircuitState, reason: string, evidence: TripEvidence[], now: number): void {
  checkAndApplyRetrip(state, now);
  state.phase = "Open";
  state.trippedAt = now;
  state.resumeAt = now + _config.probeIntervalMs;
  state.tripReason = reason;
  state.tripEvidence = evidence.slice(-10);
  state.probeSuccessCount = 0;
}

function resetThresholdsIfStable(state: CircuitState, now: number): void {
  if (
    state.lastReleasedAt !== null &&
    now - state.lastReleasedAt >= _config.reTripGraceMs &&
    state.reTripCount > 0
  ) {
    state.reTripCount = 0;
    state.effectiveNBurst = _config.nBurst;
    state.effectiveNSustained = _config.nSustained;
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

export function configure(overrides: Partial<BreakerConfig>): void {
  _config = { ...DEFAULT_CONFIG, ...overrides };
}

export function getConfig(): Readonly<BreakerConfig> {
  return _config;
}

// getCircuitState is defined below in the integration contract section with an
// enriched return type that satisfies both admin-routes tests (.phase) and
// the CLI-162 integration tests (.state, .quarantinedAt, .resumeAt as Date).

export function getAllCircuitStates(): ReadonlyMap<string, CircuitState> {
  return registry;
}

/** Record an adapter-origin failure. Returns true if the breaker tripped. */
export function recordFailure(evidence: TripEvidence): boolean {
  if (!_config.enabled) return false;

  const { adapterType } = evidence;
  const state = getOrInit(adapterType);
  const now = evidence.occurredAt;

  // Ignore failures when already Open (the outage is known)
  if (state.phase === "Open") return false;

  // Accumulate failures
  let window = failureWindow.get(adapterType);
  if (!window) {
    window = [];
    failureWindow.set(adapterType, window);
  }
  window.push(evidence);

  // Prune old entries outside the longer sustained window
  const cutoff = now - _config.tSustainedMs;
  while (window.length > 0 && window[0].occurredAt < cutoff) {
    window.shift();
  }

  const { effectiveNBurst, effectiveNSustained } = state;
  let tripReason: string | null = null;

  if (shouldTripBurst(window, effectiveNBurst, _config.tBurstMs, now)) {
    tripReason = "burst_threshold_exceeded";
  } else if (shouldTripSustained(window, effectiveNSustained, _config.tSustainedMs, now)) {
    tripReason = "sustained_threshold_exceeded";
  }

  if (tripReason) {
    if (!_config.shadowMode) {
      doTrip(state, tripReason, window, now);
    }
    writeAudit({
      action: "auto_trip",
      adapterType,
      actorType: "system",
      actorId: "system",
      outcome: "success",
      details: { tripReason, shadowMode: _config.shadowMode, failureCount: window.length },
    });
    return !_config.shadowMode;
  }

  return false;
}

/** Record a probe result from the health-check background job. */
export function recordProbeResult(adapterType: string, ok: boolean): "released" | "re_tripped" | "noop" {
  const state = registry.get(adapterType);
  if (!state) return "noop";

  const now = Date.now();

  if (state.phase === "Open") {
    if (now >= (state.resumeAt ?? 0)) {
      state.phase = "HalfOpen";
      state.probeSuccessCount = 0;
    } else {
      return "noop";
    }
  }

  if (state.phase !== "HalfOpen") return "noop";

  if (ok) {
    state.probeSuccessCount += 1;
    if (state.probeSuccessCount >= _config.probeSuccessCount) {
      // Release
      state.phase = "Closed";
      state.trippedAt = null;
      state.resumeAt = null;
      state.tripReason = null;
      state.tripEvidence = [];
      state.lastReleasedAt = now;
      failureWindow.delete(adapterType);
      resetThresholdsIfStable(state, now);
      writeAudit({
        action: "probe_release",
        adapterType,
        actorType: "system",
        actorId: "system",
        outcome: "success",
        details: { probeSuccessCount: state.probeSuccessCount },
      });
      return "released";
    }
  } else {
    // Probe failure — re-open
    state.probeSuccessCount = 0;
    doTrip(state, "probe_failure", state.tripEvidence, now);
    writeAudit({
      action: "auto_trip",
      adapterType,
      actorType: "system",
      actorId: "system",
      outcome: "success",
      details: { tripReason: "probe_failure" },
    });
    return "re_tripped";
  }

  return "noop";
}

/**
 * Manually force an adapter into quarantine (Open state).
 * Only board (human) actors may call this; agent actors are rejected.
 * Returns the audit row written.
 */
export function forceQuarantine(
  adapterType: string,
  actorType: "board" | "agent",
  actorId: string,
  reason?: string,
): { allowed: boolean; auditRow: AuditRow } {
  if (actorType === "agent") {
    const row = writeAudit({
      action: "force_quarantine",
      adapterType,
      actorType: "agent",
      actorId,
      outcome: "rejected",
      rejectionReason: "actor_is_agent",
    });
    return { allowed: false, auditRow: row };
  }

  const state = getOrInit(adapterType);
  const now = Date.now();
  doTrip(state, reason ?? "manual_force_quarantine", [], now);

  const row = writeAudit({
    action: "force_quarantine",
    adapterType,
    actorType: "board",
    actorId,
    outcome: "success",
    details: { reason: reason ?? "manual_force_quarantine" },
  });
  return { allowed: true, auditRow: row };
}

/**
 * Manually reset the circuit breaker to Closed state.
 * Only board (human) actors may call this; agent actors are rejected.
 * Returns the audit row written.
 */
export function resetBreaker(
  adapterType: string,
  actorType: "board" | "agent",
  actorId: string,
  force = false,
): { allowed: boolean; auditRow: AuditRow } {
  if (actorType === "agent") {
    const row = writeAudit({
      action: "reset",
      adapterType,
      actorType: "agent",
      actorId,
      outcome: "rejected",
      rejectionReason: "actor_is_agent",
    });
    return { allowed: false, auditRow: row };
  }

  const state = getOrInit(adapterType);
  const now = Date.now();

  state.phase = "Closed";
  state.trippedAt = null;
  state.resumeAt = null;
  state.tripReason = null;
  state.tripEvidence = [];
  state.probeSuccessCount = 0;
  state.lastReleasedAt = now;
  if (force) {
    state.reTripCount = 0;
    state.effectiveNBurst = _config.nBurst;
    state.effectiveNSustained = _config.nSustained;
  }
  failureWindow.delete(adapterType);

  const row = writeAudit({
    action: "reset",
    adapterType,
    actorType: "board",
    actorId,
    outcome: "success",
    details: { force },
  });
  return { allowed: true, auditRow: row };
}

/** Returns a copy of the audit ring buffer (newest last). */
export function getAuditLog(): ReadonlyArray<AuditRow> {
  return [...auditRing];
}

/** Reset all in-memory state (used in tests). */
export function _resetForTesting(): void {
  registry.clear();
  failureWindow.clear();
  auditRing.length = 0;
  _config = { ...DEFAULT_CONFIG };
}

// ── Integration contract (CLI-162) ────────────────────────────────────────
// These exports satisfy the circuit-breaker-integration.test.ts contract and
// are used in CLI-162 integration tests. They are either thin wrappers around
// the above functions or DB-aware async helpers.

import type { Db } from "@paperclipai/db";
import { agents, issues, agentWakeupRequests } from "@paperclipai/db";
import { eq, and, notInArray } from "drizzle-orm";

/** Enriched circuit state returned by getCircuitState (integration contract). */
export type IntegrationCircuitState = Omit<CircuitState, "resumeAt"> & {
  /** Lowercase phase name for integration test compatibility. */
  state: "closed" | "open" | "half-open";
  /** Alias for trippedAt as a Date object. */
  quarantinedAt: Date | null;
  /** resumeAt as a Date object (overrides number|null from CircuitState). */
  resumeAt: Date | null;
};

/** Per-adapter-type Half-Open probe CAS lease (in-process only). */
const probeLease = new Map<string, boolean>();

/** Reset all in-memory circuit state including probe leases (test isolation). */
export function resetAllCircuits(): void {
  _resetForTesting();
  probeLease.clear();
}

/**
 * Returns circuit state enriched with integration-contract fields.
 * Keeps existing `phase` (capitalized) for backward compat with admin-routes tests.
 * Adds `state` (lowercase), `quarantinedAt` (Date|null), `resumeAt` (Date|null).
 */
export function getCircuitState(adapterType: string): IntegrationCircuitState | null {
  const s = registry.get(adapterType);
  if (!s) return null;
  return {
    ...s,
    state: s.phase === "Closed" ? "closed" : s.phase === "Open" ? "open" : "half-open",
    quarantinedAt: s.trippedAt !== null ? new Date(s.trippedAt) : null,
    resumeAt: s.resumeAt !== null ? new Date(s.resumeAt) : null,
  };
}

/** Returns the effective burst/sustained thresholds (may be halved after re-trip). */
export function getEffectiveThreshold(adapterType: string): { nBurst: number; nSustained: number } {
  const s = registry.get(adapterType);
  if (!s) return { nBurst: _config.nBurst, nSustained: _config.nSustained };
  return { nBurst: s.effectiveNBurst, nSustained: s.effectiveNSustained };
}

/**
 * Test helper: directly advance an Open circuit to Half-Open, skipping cooldown.
 * This is NOT a production code path — test isolation only.
 */
export function advanceToHalfOpen(adapterType: string): void {
  const s = registry.get(adapterType);
  if (!s) return;
  s.phase = "HalfOpen";
  s.resumeAt = Date.now() - 1;
  s.probeSuccessCount = 0;
}

/**
 * Test helper: advance the re-trip grace window past expiry so thresholds reset.
 * Sets lastReleasedAt far enough in the past and resets thresholds.
 */
export function advancePastReTripGrace(adapterType: string): void {
  const s = registry.get(adapterType);
  if (!s) return;
  s.lastReleasedAt = Date.now() - _config.reTripGraceMs - 1;
  resetThresholdsIfStable(s, Date.now());
}

/** Returns a URL-safe route key for an adapter type (for admin route paths). */
export function toRouteKey(adapterType: string): string {
  return adapterType.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** Returns true if a Half-Open probe CAS lease is currently held in-process. */
export function probeLeaseHeld(adapterType: string): boolean {
  return probeLease.get(adapterType) ?? false;
}

/**
 * Record an adapter failure with DB side-effects.
 *
 * When the failure trips the circuit (Closed→Open):
 *   - Marks all agents using this adapterType as "quarantined".
 *   - Sets executionState.quarantineHold=true on their open issues.
 *   - Creates agentWakeupRequests rows so issues re-wake after the circuit opens.
 *
 * When the circuit is already Open (not a new trip):
 *   - Stamps quarantineHold on the calling agent's issues that aren't yet stamped.
 *   - Creates wakeup rows for those newly-stamped issues.
 */
export async function recordAdapterFailure(
  db: Db,
  opts: { adapterType: string; agentId: string; reason: string },
): Promise<{ tripped: boolean }> {
  const { adapterType, agentId, reason } = opts;
  const tripped = recordFailure({
    adapterType,
    agentId,
    failureReason: reason,
    occurredAt: Date.now(),
  });

  const state = registry.get(adapterType);
  if (!state || state.phase !== "Open") return { tripped };

  const resumeAtMs = state.resumeAt ?? Date.now() + _config.probeIntervalMs;

  if (tripped) {
    // New trip: quarantine ALL agents with this adapterType and stamp all their issues.
    await db.update(agents).set({ status: "quarantined" }).where(eq(agents.adapterType, adapterType));

    const affectedAgents = await db
      .select({ id: agents.id, companyId: agents.companyId })
      .from(agents)
      .where(eq(agents.adapterType, adapterType));

    for (const agent of affectedAgents) {
      await _stampAndWakeIssues(db, agent.id, agent.companyId, adapterType, resumeAtMs);
    }
  } else {
    // Already open: stamp only the calling agent's issues that aren't yet stamped.
    const agentRow = await db
      .select({ companyId: agents.companyId })
      .from(agents)
      .where(eq(agents.id, agentId));
    const companyId = agentRow[0]?.companyId;
    if (companyId) {
      await _stampAndWakeIssues(db, agentId, companyId, adapterType, resumeAtMs);
    }
  }

  return { tripped };
}

/** Internal helper: stamp quarantineHold + create wakeup for unstamped issues. */
async function _stampAndWakeIssues(
  db: Db,
  agentId: string,
  companyId: string,
  adapterType: string,
  resumeAtMs: number,
): Promise<void> {
  const agentIssues = await db
    .select({ id: issues.id, executionState: issues.executionState })
    .from(issues)
    .where(
      and(
        eq(issues.assigneeAgentId, agentId),
        notInArray(issues.status, ["done", "cancelled"]),
      ),
    );

  for (const issue of agentIssues) {
    const execState = (issue.executionState ?? {}) as Record<string, unknown>;
    if (execState.quarantineHold) continue; // already stamped

    await db
      .update(issues)
      .set({ executionState: { ...execState, quarantineHold: true } })
      .where(eq(issues.id, issue.id));

    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      issueId: issue.id,
      source: "circuit_breaker_quarantine",
      reason: `Adapter quarantined: ${adapterType}`,
      scheduledAt: new Date(resumeAtMs),
      status: "pending",
    });
  }
}

/**
 * Run a Half-Open probe round with DB side-effects and CAS lease protection.
 *
 * The probe lease (in-process Map) ensures that concurrent callers within the
 * same process see exactly one probe execute per adapter per microtask batch.
 *
 * On circuit release (3 consecutive successes):
 *   - Restores agents using this adapterType to "idle".
 *   - Clears executionState.quarantineHold from their issues.
 *   - Creates re-promotion agentWakeupRequests for each cleared issue.
 */
export async function runProbeRound(
  db: Db,
  adapterType: string,
  probeResult: { ok: boolean },
): Promise<{ released: boolean; probeExecuted: boolean }> {
  if (probeLease.get(adapterType)) {
    return { released: false, probeExecuted: false };
  }
  probeLease.set(adapterType, true);
  // Yield so concurrent callers (e.g. Promise.all) observe the lease before we
  // reach the synchronous recordProbeResult call in the non-release path.
  await Promise.resolve();

  try {
    const result = recordProbeResult(adapterType, probeResult.ok);
    const released = result === "released";

    if (released) {
      await db.update(agents).set({ status: "idle" }).where(eq(agents.adapterType, adapterType));

      const affectedAgents = await db
        .select({ id: agents.id, companyId: agents.companyId })
        .from(agents)
        .where(eq(agents.adapterType, adapterType));

      for (const agent of affectedAgents) {
        const heldIssues = await db
          .select({ id: issues.id, executionState: issues.executionState })
          .from(issues)
          .where(eq(issues.assigneeAgentId, agent.id));

        for (const issue of heldIssues) {
          const execState = issue.executionState as Record<string, unknown> | null;
          if (!execState?.quarantineHold) continue;

          const { quarantineHold: _, ...rest } = execState;
          await db
            .update(issues)
            .set({ executionState: Object.keys(rest).length > 0 ? rest : null })
            .where(eq(issues.id, issue.id));

          await db.insert(agentWakeupRequests).values({
            companyId: agent.companyId,
            agentId: agent.id,
            issueId: issue.id,
            source: "circuit_breaker_release",
            reason: `Adapter released: ${adapterType}`,
            scheduledAt: new Date(),
            status: "pending",
          });
        }
      }
    }

    return { released, probeExecuted: true };
  } finally {
    probeLease.delete(adapterType);
  }
}
