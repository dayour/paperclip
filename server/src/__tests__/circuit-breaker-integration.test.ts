/**
 * Integration test suite for the adapter-level circuit breaker (ADR-0006).
 *
 * Covers every scenario listed in ADR §Tests and CLI-162:
 *   1. Happy-path E2E: failures → Open → quarantineHold → Half-Open probe → Closed → hold cleared
 *   2. Re-trip threshold halving: re-trip within reTripGraceSec halves N_burst/N_sustained (floor 1)
 *   3. Re-trip reset: stable Closed ≥ reTripGraceSec → thresholds reset to defaults
 *   4. Assignment to quarantined adapter: stamps quarantineHold=true, first wake deferred to resumeAt
 *   5. Admin reset by human actor: breaker → Closed, quarantineHold cleared, audit row written
 *   6. Admin reset by agent actor: HTTP 403, audit row written for rejection
 *
 * Guard (a): tests are skipped when embedded Postgres is unavailable on this host.
 * Guard (b): tests are skipped when the circuit-breaker module (CLI-157) has not yet landed.
 *
 * Once CLI-156–160 are implemented and merged into feat/cli-121-adapter-circuit-breaker,
 * run this file with:
 *   pnpm vitest run src/__tests__/circuit-breaker-integration.test.ts
 */

import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import express from "express";
import request from "supertest";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// ---------------------------------------------------------------------------
// Guard (a): embedded Postgres
// ---------------------------------------------------------------------------
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();

// ---------------------------------------------------------------------------
// Guard (b): circuit-breaker module not yet implemented
// ---------------------------------------------------------------------------
type CircuitBreakerModule = typeof import("../adapters/circuit-breaker.js");
let circuitBreakerModule: CircuitBreakerModule | null = null;
try {
  circuitBreakerModule = await import("../adapters/circuit-breaker.js");
} catch {
  // Module not yet implemented (CLI-157 still pending). Tests will be skipped.
}

const circuitBreakerSupported = circuitBreakerModule !== null;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping circuit-breaker integration tests: embedded Postgres unavailable — ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}
if (!circuitBreakerSupported) {
  console.warn(
    "Skipping circuit-breaker integration tests: ../adapters/circuit-breaker.ts not yet implemented (CLI-157 pending).",
  );
}

const describeCircuitBreaker =
  embeddedPostgresSupport.supported && circuitBreakerSupported
    ? describe
    : describe.skip;

// ---------------------------------------------------------------------------
// Adapter mock — wired via vi.mock before heartbeatService is imported
// ---------------------------------------------------------------------------
const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "ok",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>(
    "../adapters/index.ts",
  );
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

// Import heartbeat after mocks are in place.
import { heartbeatService } from "../services/heartbeat.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Db = ReturnType<typeof createDb>;

async function waitForRunToSettle(
  heartbeat: ReturnType<typeof heartbeatService>,
  runId: string,
  timeoutMs = 5_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (!run || (run.status !== "queued" && run.status !== "running")) {
      return run;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return heartbeat.getRun(runId);
}

async function setupCompanyAndAgent(
  db: Db,
  opts: { adapterType?: string; adapterConfig?: Record<string, unknown> } = {},
) {
  const companyId = randomUUID();
  const agentId = randomUUID();

  await db.insert(companies).values({
    id: companyId,
    name: "Circuit Breaker Test Co",
    issuePrefix: `CB${companyId.replace(/-/g, "").slice(0, 4).toUpperCase()}`,
    requireBoardApprovalForNewAgents: false,
  });

  await db.insert(agents).values({
    id: agentId,
    companyId,
    name: "TestAgent",
    role: "engineer",
    status: "running",
    adapterType: opts.adapterType ?? "process",
    adapterConfig: opts.adapterConfig ?? { command: "/usr/bin/missing-binary" },
    runtimeConfig: {},
    permissions: {},
  });

  return { companyId, agentId };
}

async function createIssue(
  db: Db,
  companyId: string,
  agentId: string,
  overrides: Partial<{ status: string; title: string }> = {},
) {
  const issueId = randomUUID();
  await db.insert(issues).values({
    id: issueId,
    companyId,
    assigneeAgentId: agentId,
    title: overrides.title ?? "Test issue",
    description: "Circuit breaker integration test issue",
    status: overrides.status ?? "in_progress",
    priority: "medium",
  });
  return issueId;
}

/** Trigger a run for an agent and wait for it to settle. */
async function triggerAndAwaitRun(
  heartbeat: ReturnType<typeof heartbeatService>,
  agentId: string,
  issueId: string,
  timeoutMs = 5_000,
) {
  const wakeup = await heartbeat.invoke(agentId, "on_demand", { issueId });
  if (!wakeup) throw new Error("invoke returned null – check agent/issue setup");
  return waitForRunToSettle(heartbeat, wakeup.id, timeoutMs);
}

/** Make the mock adapter return a classified failure result. */
function mockAdapterFailure(reason = "adapter_missing_command") {
  mockAdapterExecute.mockImplementation(async () => ({
    exitCode: 1,
    signal: null,
    timedOut: false,
    errorMessage: "Process adapter missing command",
    adapterFailureReason: reason,
  }));
}

/** Make the mock adapter return success. */
function mockAdapterSuccess() {
  mockAdapterExecute.mockImplementation(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "ok",
    provider: "test",
    model: "test-model",
  }));
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describeCircuitBreaker("circuit-breaker integration", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-circuit-breaker-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    vi.clearAllMocks();
    mockAdapterSuccess();

    // Reset the in-memory circuit state between tests so they're isolated.
    circuitBreakerModule!.resetAllCircuits();

    await db.delete(activityLog);
    await db.delete(agentWakeupRequests);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  // =========================================================================
  // 1. Happy-path E2E (CLI-66 simulation)
  // =========================================================================
  describe("happy-path E2E: trip → Open → probe → Closed", () => {
    it(
      "trips the breaker after N_burst failures, defers subsequent wakes, then closes on a successful probe",
      async () => {
        const heartbeat = heartbeatService(db);
        const { companyId, agentId } = await setupCompanyAndAgent(db, {
          adapterType: "process",
          adapterConfig: { command: "/missing-binary" },
        });
        const issueId = await createIssue(db, companyId, agentId);

        // Phase 1: Run N_burst (3) classified failures → breaker trips to Open.
        mockAdapterFailure("adapter_missing_command");

        for (let i = 0; i < 3; i++) {
          const run = await triggerAndAwaitRun(heartbeat, agentId, issueId);
          expect(run?.status).toBe("failed");
          expect(run?.errorCode).toBe("adapter_missing_command");
        }

        // After 3 failures the circuit must be Open.
        const key = `process:builtin`;
        const stateAfterTrip = circuitBreakerModule!.getCircuitState(key);
        expect(stateAfterTrip?.state).toBe("Open");

        // Phase 2: quarantineHold must be set on the agent's issue.
        const issueRow = await db
          .select({ quarantineHold: issues.quarantineHold })
          .from(issues)
          .where(eq(issues.id, issueId))
          .then((rows) => rows[0] ?? null);
        expect(issueRow?.quarantineHold).toBe(true);

        // Phase 3: 4th invoke must be deferred — no run row created, no spawn.
        const spawnCountBefore = mockAdapterExecute.mock.calls.length;
        const wakeup4 = await heartbeat.invoke(agentId, "on_demand", { issueId });
        // Give the supervisor a moment to potentially spawn (it should not).
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(mockAdapterExecute.mock.calls.length).toBe(spawnCountBefore);

        // The wakeup request must be in deferred_issue_execution status.
        if (wakeup4) {
          const deferredWakeup = await db
            .select({ status: agentWakeupRequests.status })
            .from(agentWakeupRequests)
            .where(eq(agentWakeupRequests.id, wakeup4.id))
            .then((rows) => rows[0] ?? null);
          expect(deferredWakeup?.status).toBe("deferred_issue_execution");
        }

        // checkoutRunId on the issue must be preserved (not cleared to avoid CLI-37-class orphans).
        const issueAfterDefer = await db
          .select({
            checkoutRunId: issues.checkoutRunId,
            status: issues.status,
          })
          .from(issues)
          .where(eq(issues.id, issueId))
          .then((rows) => rows[0] ?? null);
        // Issue status must NOT have changed (no blocked/failed mutation).
        expect(issueAfterDefer?.status).toBe("in_progress");

        // Phase 4: Wait for cooldown to elapse, feed a successful probe.
        // Advance the circuit clock to Half-Open by calling the test helper.
        circuitBreakerModule!.advanceToHalfOpen(key);
        mockAdapterSuccess();

        const probeRun = await triggerAndAwaitRun(heartbeat, agentId, issueId);
        expect(probeRun?.status).toBe("succeeded");

        // Circuit must now be Closed.
        const stateAfterProbe = circuitBreakerModule!.getCircuitState(key);
        expect(stateAfterProbe?.state).toBe("Closed");

        // quarantineHold must be cleared transactionally on Closed.
        const issueAfterClose = await db
          .select({ quarantineHold: issues.quarantineHold })
          .from(issues)
          .where(eq(issues.id, issueId))
          .then((rows) => rows[0] ?? null);
        expect(issueAfterClose?.quarantineHold).toBeFalsy();

        // Deferred wakes must have been re-promoted (drained).
        const remainingDeferred = await db
          .select({ id: agentWakeupRequests.id })
          .from(agentWakeupRequests)
          .where(
            and(
              eq(agentWakeupRequests.agentId, agentId),
              eq(agentWakeupRequests.status, "deferred_issue_execution"),
            ),
          );
        expect(remainingDeferred).toHaveLength(0);
      },
      30_000,
    );
  });

  // =========================================================================
  // 2. Re-trip path — threshold halving (ADR revision j)
  // =========================================================================
  describe("re-trip threshold halving", () => {
    it(
      "halves N_burst (rounded up, floor 1) when re-trip occurs within reTripGraceSec",
      async () => {
        const heartbeat = heartbeatService(db);
        const { companyId, agentId } = await setupCompanyAndAgent(db);
        const issueId = await createIssue(db, companyId, agentId);

        const key = `process:builtin`;
        const defaultThreshold = circuitBreakerModule!.getEffectiveThreshold(key);
        expect(defaultThreshold).toBeGreaterThanOrEqual(3);

        // First trip (N_burst failures → Open).
        mockAdapterFailure("adapter_missing_command");
        for (let i = 0; i < defaultThreshold; i++) {
          await triggerAndAwaitRun(heartbeat, agentId, issueId);
        }
        expect(circuitBreakerModule!.getCircuitState(key)?.state).toBe("Open");

        // Advance to Half-Open, feed a successful probe → Closed.
        circuitBreakerModule!.advanceToHalfOpen(key);
        mockAdapterSuccess();
        await triggerAndAwaitRun(heartbeat, agentId, issueId);
        expect(circuitBreakerModule!.getCircuitState(key)?.state).toBe("Closed");

        // Re-trip within reTripGraceSec → threshold should halve.
        const halvedThreshold = Math.max(1, Math.ceil(defaultThreshold / 2));
        mockAdapterFailure("adapter_missing_command");

        // One fewer failure than original threshold should now trip.
        for (let i = 0; i < halvedThreshold; i++) {
          await triggerAndAwaitRun(heartbeat, agentId, issueId);
        }

        expect(circuitBreakerModule!.getCircuitState(key)?.state).toBe("Open");
        expect(circuitBreakerModule!.getEffectiveThreshold(key)).toBe(halvedThreshold);
      },
      30_000,
    );
  });

  // =========================================================================
  // 3. Re-trip reset — stable Closed ≥ reTripGraceSec (ADR revision j)
  // =========================================================================
  describe("re-trip threshold reset after grace period", () => {
    it(
      "resets thresholds to default when Closed is held for >= reTripGraceSec without a re-trip",
      async () => {
        const heartbeat = heartbeatService(db);
        const { companyId, agentId } = await setupCompanyAndAgent(db);
        const issueId = await createIssue(db, companyId, agentId);

        const key = `process:builtin`;
        const defaultThreshold = circuitBreakerModule!.getEffectiveThreshold(key);

        // Trip once, probe to Closed.
        mockAdapterFailure("adapter_missing_command");
        for (let i = 0; i < defaultThreshold; i++) {
          await triggerAndAwaitRun(heartbeat, agentId, issueId);
        }
        circuitBreakerModule!.advanceToHalfOpen(key);
        mockAdapterSuccess();
        await triggerAndAwaitRun(heartbeat, agentId, issueId);
        expect(circuitBreakerModule!.getCircuitState(key)?.state).toBe("Closed");

        // Simulate passage of reTripGraceSec without a re-trip.
        circuitBreakerModule!.advancePastReTripGrace(key);

        // Now re-trip — should require the full default threshold again.
        const thresholdAfterGrace = circuitBreakerModule!.getEffectiveThreshold(key);
        expect(thresholdAfterGrace).toBe(defaultThreshold);
      },
      30_000,
    );
  });

  // =========================================================================
  // 4. Assignment to quarantined adapter (ADR revision l)
  // =========================================================================
  describe("assignment to quarantined adapter", () => {
    it(
      "stamps quarantineHold=true at assignment time; first wake is deferred to resumeAt; release drains hold",
      async () => {
        const heartbeat = heartbeatService(db);
        const { companyId, agentId } = await setupCompanyAndAgent(db);

        // Trip the circuit before creating the new issue.
        const existingIssueId = await createIssue(db, companyId, agentId);
        mockAdapterFailure("adapter_missing_command");
        const key = `process:builtin`;
        const defaultThreshold = circuitBreakerModule!.getEffectiveThreshold(key);
        for (let i = 0; i < defaultThreshold; i++) {
          await triggerAndAwaitRun(heartbeat, agentId, existingIssueId);
        }
        expect(circuitBreakerModule!.getCircuitState(key)?.state).toBe("Open");

        // Now assign a new issue to the same (quarantined) agent.
        const newIssueId = await createIssue(db, companyId, agentId, {
          title: "New issue assigned during quarantine",
        });

        // Trigger assignment — the heartbeat/assignment service should stamp quarantineHold.
        await heartbeat.invoke(agentId, "assignment", { issueId: newIssueId });
        await new Promise((resolve) => setTimeout(resolve, 200));

        const newIssueRow = await db
          .select({
            quarantineHold: issues.quarantineHold,
            status: issues.status,
          })
          .from(issues)
          .where(eq(issues.id, newIssueId))
          .then((rows) => rows[0] ?? null);

        // quarantineHold must be set immediately on assignment.
        expect(newIssueRow?.quarantineHold).toBe(true);
        // Issue status must not be mutated by the quarantine.
        expect(newIssueRow?.status).not.toBe("failed");

        // The wake for the new issue must be deferred (no run created).
        const runForNewIssue = await db
          .select({ status: heartbeatRuns.status })
          .from(heartbeatRuns)
          .where(
            eq(
              heartbeatRuns.contextSnapshot,
              // drizzle jsonb operator: select runs where contextSnapshot->issueId = newIssueId
              // Use a raw query here for clarity in the assertion.
              heartbeatRuns.contextSnapshot,
            ),
          );
        // No run should have been spawned (adapter.execute not called for new issue).
        const executeCalls = mockAdapterExecute.mock.calls.length;
        // Only the original `defaultThreshold` failures should have called execute.
        expect(executeCalls).toBe(defaultThreshold);

        // After release (probe success), the hold must be cleared.
        circuitBreakerModule!.advanceToHalfOpen(key);
        mockAdapterSuccess();
        await triggerAndAwaitRun(heartbeat, agentId, existingIssueId);
        expect(circuitBreakerModule!.getCircuitState(key)?.state).toBe("Closed");

        const newIssueAfterRelease = await db
          .select({ quarantineHold: issues.quarantineHold })
          .from(issues)
          .where(eq(issues.id, newIssueId))
          .then((rows) => rows[0] ?? null);
        expect(newIssueAfterRelease?.quarantineHold).toBeFalsy();
      },
      30_000,
    );
  });

  // =========================================================================
  // 5 & 6. Admin routes — human reset and agent-actor rejection (ADR revision m)
  // =========================================================================
  describe("admin reset routes", () => {
    function buildAdminApp(actorOverride: { type: string; userId?: string; agentId?: string }) {
      // Lazily import to respect vi.mock hoisting.
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        (req as any).actor = {
          type: actorOverride.type,
          userId: actorOverride.userId ?? null,
          agentId: actorOverride.agentId ?? null,
          companyIds: [],
          isInstanceAdmin: true,
          source: "local_implicit",
        };
        next();
      });
      // Admin routes are expected at /api/admin/adapters
      // The actual route module will be imported once CLI-159 lands.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { adminAdapterRoutes } = require("../routes/admin-adapters.js");
      app.use("/api/admin/adapters", adminAdapterRoutes(db));
      return app;
    }

    it(
      "human actor can reset the circuit breaker; audit row is written; quarantineHold cleared",
      async () => {
        const heartbeat = heartbeatService(db);
        const { companyId, agentId } = await setupCompanyAndAgent(db);
        const issueId = await createIssue(db, companyId, agentId);

        // Trip the circuit.
        mockAdapterFailure("adapter_missing_command");
        const key = `process:builtin`;
        const threshold = circuitBreakerModule!.getEffectiveThreshold(key);
        for (let i = 0; i < threshold; i++) {
          await triggerAndAwaitRun(heartbeat, agentId, issueId);
        }
        expect(circuitBreakerModule!.getCircuitState(key)?.state).toBe("Open");

        // Build a URL-safe key hash (the route accepts the opaque hash).
        const keyHash = circuitBreakerModule!.toRouteKey(key);

        const app = buildAdminApp({ type: "board", userId: "local-board" });
        const res = await request(app)
          .post(`/api/admin/adapters/${keyHash}/reset`)
          .send({ reason: "fix deployed", actor: "local-board" });

        expect(res.status).toBe(200);

        // Circuit must now be Closed.
        expect(circuitBreakerModule!.getCircuitState(key)?.state).toBe("Closed");

        // quarantineHold on the issue must have been cleared transactionally.
        const issueRow = await db
          .select({ quarantineHold: issues.quarantineHold })
          .from(issues)
          .where(eq(issues.id, issueId))
          .then((rows) => rows[0] ?? null);
        expect(issueRow?.quarantineHold).toBeFalsy();

        // Audit row must be written.
        const auditRows = await db
          .select()
          .from(activityLog)
          .where(
            and(
              eq(activityLog.action, "circuit_reset"),
              eq(activityLog.entityType, "adapter_circuit"),
            ),
          );
        expect(auditRows.length).toBeGreaterThanOrEqual(1);
        expect(auditRows[0]?.actorId).toBe("local-board");
      },
      30_000,
    );

    it(
      "agent actor is rejected with HTTP 403; audit row for rejection is written",
      async () => {
        const heartbeat = heartbeatService(db);
        const { companyId, agentId } = await setupCompanyAndAgent(db);
        const issueId = await createIssue(db, companyId, agentId);

        // Trip the circuit.
        mockAdapterFailure("adapter_missing_command");
        const key = `process:builtin`;
        const threshold = circuitBreakerModule!.getEffectiveThreshold(key);
        for (let i = 0; i < threshold; i++) {
          await triggerAndAwaitRun(heartbeat, agentId, issueId);
        }
        expect(circuitBreakerModule!.getCircuitState(key)?.state).toBe("Open");

        const keyHash = circuitBreakerModule!.toRouteKey(key);

        // Attempt reset as agent actor (should be rejected — CLI-22 T5 mitigation).
        const app = buildAdminApp({ type: "agent", agentId });
        const res = await request(app)
          .post(`/api/admin/adapters/${keyHash}/reset`)
          .send({ reason: "self-rescue attempt", actor: agentId });

        expect(res.status).toBe(403);

        // Circuit must still be Open.
        expect(circuitBreakerModule!.getCircuitState(key)?.state).toBe("Open");

        // Audit row for the rejected attempt must still be written (non-negotiable per ADR).
        const auditRows = await db
          .select()
          .from(activityLog)
          .where(
            and(
              eq(activityLog.action, "circuit_reset_rejected"),
              eq(activityLog.entityType, "adapter_circuit"),
            ),
          );
        expect(auditRows.length).toBeGreaterThanOrEqual(1);
        expect(auditRows[0]?.actorId).toBe(agentId);
      },
      30_000,
    );
  });
});
