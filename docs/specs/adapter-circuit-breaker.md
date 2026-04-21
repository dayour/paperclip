---
title: Adapter-Level Circuit Breaker and Quarantine
summary: Isolate a failing adapter so one bad adapter cannot wedge the entire fleet
---

# Adapter-Level Circuit Breaker and Quarantine

**Issue:** CLI-121
**Parent:** CLI-75 (fleet outage postmortem, 2026-04-20)
**Status:** Approved (v3) — ClippyQA + ClippyArch sign-off; awaiting ClippyEng call-site confirmation + ClippyCTO final ack before implementation tickets open

**Revision history:**
- v1 — initial draft (ClippyArch, 01:39 UTC).
- v2 — rubber-duck design review, 10 substantive findings folded (two-shape keying, Open=DEFERS, probe CAS lease, failure classification, etc.).
- v3 — QA spec review @ 02:32 UTC: 3 acceptance gaps closed, 2 §-level clarifications, 2 minor hardenings (this revision).

## Problem

On 2026-04-20 06:59 UTC, a single `copilot_local` adapter failure stranded 8 of 9 agents in `status=error` for ~19 minutes and auto-blocked 30+ in-flight issues. Every agent bound to that adapter hit the same `adapter_failed - Process adapter missing command` on its next heartbeat, and there was no mechanism to *isolate* the bad adapter from the rest of the fleet while recovery ran.

The CLI-75 follow-ups shipped detection (CLI-77), gating (CLI-79), and alerting (CLI-84). **This spec covers the missing axis: isolation.** A failing adapter should fail in place without consuming the fleet.

## Non-goals

- Not a retry/back-off policy for individual heartbeats (that lives in the execution loop).
- Not a replacement for CLI-79 release-channel gating; this kicks in *after* a bad adapter is already live.
- Not a cross-adapter failover (we do not migrate agents from `copilot_local` → `codex_local` automatically).

## Design

### 1. Failure accounting

For each `adapterType` (e.g., `copilot_local`), the server maintains a rolling window of adapter-layer failures:

- **Counted:** `adapter_failed`, missing-command errors, adapter-bootstrap timeouts, and any error classified as originating in the adapter itself (not the agent run).
- **Not counted:** agent-side errors (tool call failures, run-timeouts inside the agent, non-zero exits surfaced as run output).

Classification uses the existing error shape. Adapter-origin errors are ones the run loop today maps to `status=error` with `adapter_failed` in the reason; agent-origin errors surface as run failures but leave the agent `idle`.

### 2. Trip conditions

The breaker trips for an `adapterType` when either:

- **Burst:** ≥ `N_burst` adapter-origin failures across distinct agents within `T_burst` seconds (defaults: `N_burst=3`, `T_burst=60s` — matches the CLI-84 alert threshold so alert-fires-and-breaker-trips-together by default).
- **Sustained:** ≥ `N_sustained` adapter-origin failures in `T_sustained` (defaults: `N_sustained=10`, `T_sustained=600s`) — catches slower-rolling outages that would miss the burst window.

Both thresholds are configurable per adapter type via server config (see §6).

### 3. Quarantine state

When the breaker trips for `adapterType=X`:

1. Mark the adapter type `quarantined` in server state, with `quarantinedAt`, `tripReason`, and `tripEvidence` (the last N failure records).
2. For every agent whose current adapter is `X`, transition them to a **new** status `quarantined` (not `error`). Distinction matters:
   - `error` = agent-specific failure, operator investigates this agent.
   - `quarantined` = agent is fine, its adapter is not; no per-agent investigation required.
3. Issues assigned to quarantined agents are **not** auto-blocked. They retain their current status with a `quarantineHold` flag on their execution record. This avoids the CLI-75 secondary symptom where 30+ issues flipped to blocked and required manual rehydration.
4. Emit a single `adapter.quarantined` event (distinct from the per-agent `adapter_failed` events) so alerting/dashboards can show one row, not N.

**Assignment to a quarantined agent (QA gap #3).** New issue assignment to an agent whose current adapter is `quarantined` is **permitted** and stamps `quarantineHold=true` on the execution record at assignment time (no run is started). The issue moves to the agent's queue and waits for release. Rationale: blocking assignment would flip the failure mode back to "fleet stalls on assignment," which is exactly what quarantine is designed to avoid.

### 4. Release (two paths)

The breaker releases `X` when **either**:

- **Automatic probe-based release.** A background health probe runs every `probeIntervalSec` (default `30s`) and executes the adapter's `healthCheck()` (new required adapter method; see §5). After `probeSuccessCount` consecutive successes (default `3`), the breaker releases automatically. Agents transition `quarantined → idle` and resume on their next heartbeat.
- **Manual operator release.** `POST /api/adapters/{adapterType}/release-quarantine` (board-operator-only) clears quarantine immediately, optionally with `force=true` to skip the probe confirmation. Release emits `adapter.quarantine_released` with `releasedBy` and `reason`.

On release, the trip counters reset **and** every `quarantineHold=true` flag belonging to issues bound to adapter `X` is cleared in the same transaction (QA gap #2). The next agent heartbeat for those issues then resumes normal execution; no manual rehydration is needed. If the breaker trips again within `reTripGraceSec` (default `120s`), the trip thresholds are halved for the next window — repeated flapping should escalate, not silently cycle.

### 5. Adapter contract changes

Every adapter gains a required method:

```ts
interface Adapter {
  // ...existing methods
  healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult>;
}

interface HealthCheckResult {
  ok: boolean;
  reason?: string;       // human-readable, logged with quarantine events
  details?: unknown;     // structured, surfaced in admin UI
}
```

Semantics:

- MUST NOT spawn a full agent run. Lightweight only (e.g., `copilot --version`, SDK connectivity check, `which` on the adapter's configured `command`).
- MUST respect `ctx.timeoutMs` (default `5000`). A hung probe **and** an explicit `{ ok: false }` return are weighted equally as a probe failure (QA minor #2). Both reset `probeSuccessCount` and count toward the next trip evidence.
- MUST be idempotent and side-effect-free.

For built-ins, the work is small (copilot_local: reuse the CLI-77 adapter-health-probe check; process: verify `command` resolves; http: HEAD/GET against the configured URL). External adapters get a one-release deprecation window where a missing `healthCheck` degrades to "probe unavailable → manual release only" rather than breaking the plugin.

### 6. Configuration

New server config section (env + config file):

```yaml
adapters:
  circuitBreaker:
    enabled: true                  # global kill-switch
    defaults:
      nBurst: 3
      tBurstSec: 60
      nSustained: 10
      tSustainedSec: 600
      probeIntervalSec: 30
      probeSuccessCount: 3
      reTripGraceSec: 120
    overrides:
      copilot_local:
        nBurst: 3                  # same as default; explicit for the adapter that caused CLI-75
```

Env vars mirror the defaults: `PAPERCLIP_ADAPTER_BREAKER_ENABLED`, `PAPERCLIP_ADAPTER_BREAKER_N_BURST`, etc.

### 7. Observability

- `adapter.quarantined` event: `{adapterType, trippedAt, reason, evidence}`.
- `adapter.quarantine_released` event: `{adapterType, releasedAt, releasedBy, mode: "probe"|"manual"}`.
- `GET /api/adapters/quarantine` returns current quarantine state for all adapter types.
- Dashboard: a banner on the agent-fleet view when any adapter is quarantined, listing affected agents.
- Metrics: `adapter_quarantine_trips_total{adapter_type}`, `adapter_quarantine_duration_seconds{adapter_type}`, `adapter_health_probe_failures_total{adapter_type}`.

### 8. Interaction with CLI-84 alerts

The CLI-84 alert fires when ≥3 agents hit `adapter_failed` within 60s. With this breaker active and using default thresholds, the alert and the trip fire on the same evidence. Recommend: the alert payload includes `quarantined: true|false` so on-call can see at a glance whether isolation already kicked in and whether a human response is still required.

### 9. Interaction with CLI-91 actor-trust

Quarantine release is a state-changing action. It MUST honor the CLI-91 default-deny actor-trust rule: only `"user"` actors can release via the manual API. **Agent actors are explicitly forbidden** from triggering manual release, including `force=true` (QA minor #1) — a compromised agent must not be able to lift its own quarantine. Probe-based automatic release is permitted because the probe itself is a first-class trusted signal, not an actor-authored comment.

## Failure modes and mitigations

| Failure | Mitigation |
|---|---|
| `healthCheck` gives false positives (returns ok while adapter is broken) | Require `probeSuccessCount=3` consecutive passes; log probe results; operator can force-quarantine via API. |
| `healthCheck` gives false negatives (never passes despite adapter being fine) | Manual `force=true` release path; probe result history visible in admin UI so operator can override. |
| Trip storm across every adapter type simultaneously | Global kill-switch (`enabled=false`); per-adapter overrides don't stack into a fleet-wide outage of the breaker itself. |
| External adapter plugin without `healthCheck` | Deprecation window: quarantine still works, but release is manual-only until the plugin updates. |
| Breaker trips during legitimate adapter upgrade | CLI-79 release-channel gating should prevent the new adapter from going live until canaries pass, so the breaker tripping during upgrade is a *signal*, not a bug. |
| Flapping adapter (trips, releases, re-trips) | `reTripGraceSec` halves thresholds on re-trip within the grace window — escalates rather than silently cycling. |

## Rollout plan

1. **Ship the `healthCheck` contract** (no-op breaker). Built-in adapters implement it; external adapters get a warning in the plugin log.
2. **Ship the breaker in shadow mode.** Trip conditions evaluated; events emitted; agent state **not** mutated. Run for one week; compare shadow trips against real-world adapter-origin failures to validate thresholds.
3. **Enable enforcement for `copilot_local` only.** The adapter that triggered CLI-75 is the first real beneficiary.
4. **Enable enforcement fleet-wide** after one clean week on `copilot_local`.
5. **Remove shadow-mode code path** after fleet-wide enforcement is stable for two weeks.

## Acceptance criteria

- [ ] `healthCheck` method added to the `Adapter` interface and implemented for every built-in adapter.
- [ ] Breaker trips on both burst and sustained conditions; unit tests cover both.
- [ ] Quarantined agents transition to `quarantined` status (distinct from `error`); issues assigned to them are **not** auto-blocked.
- [ ] Automatic release after probe confirmation; manual release via API (gated to `user` actors per CLI-91).
- [ ] End-to-end test: simulate `copilot_local` adapter failure → verify breaker trips, agents move to `quarantined`, issues stay open with `quarantineHold`, probe restores → breaker releases → agents resume.
- [ ] **Re-trip threshold halving test (QA gap #1).** Trip → release → re-trip within `reTripGraceSec` → verify `nBurst`/`nSustained` are halved (rounded up) for the next window. Subsequent re-trip within grace halves again until floor of 1.
- [ ] **quarantineHold cleanup on release.** Unit test verifying that on either probe-based or manual release, every `quarantineHold` flag for the released adapter type is cleared in the same transaction; assigned-while-quarantined issues then execute on next heartbeat.
- [ ] **Assignment-to-quarantined-agent.** Unit test: assigning a new issue to a quarantined agent succeeds and stamps `quarantineHold=true` at assignment time (no run started); release path then drains it.
- [ ] Dashboard banner + `/api/adapters/quarantine` endpoint.
- [ ] Runbook entry in `docs/runbooks/` for "how to force-release / force-quarantine an adapter."
- [ ] Shadow-mode rollout validated with one week of data before enforcement.

## Open questions (resolved)

1. **Issue-level hold semantics.** ✅ **Surface in UI.** ClippyQA confirmed: an explicit "held — adapter quarantined" badge prevents "why is my ticket not moving" support noise. Internal-only is a support liability.
2. **Cross-project scope.** ✅ **Per adapter type for v1.** ClippyQA confirmed: the v2 two-shape keying already differentiates by module identity for shared-env adapters; revisit per-instance only if a real incident demands it.
3. **Healthcheck sampling cost.** Tracked but unresolved — `30s` probe interval × N adapter types is cheap for built-ins but could matter for external HTTP adapters. Revisit interval per-adapter if probes become a load issue. Not a blocker for v1.

## Follow-up tickets (to open after this spec is approved)

- Implementation ticket for the breaker core + `healthCheck` contract.
- Per-adapter `healthCheck` implementation tickets (one per built-in).
- Dashboard quarantine banner UI ticket.
- Runbook ticket for operator force-release/force-quarantine procedures.

## References

- CLI-75 postmortem: `docs/postmortems/2026-04-20-fleet-outage.md`
- CLI-77 adapter health probe (detection)
- CLI-79 adapter release-channel guardrail (gating)
- CLI-84 adapter fleet failure alert (alerting)
- CLI-91 deferred-wake reopen bug / actor-trust invariant
- CLI-122 adapter go-live checklist enforcement (sibling follow-up)
- CLI-123 actor-trust invariant spec (sibling follow-up)
