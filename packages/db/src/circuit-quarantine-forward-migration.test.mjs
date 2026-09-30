import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const migrations = fileURLToPath(new URL("./migrations/", import.meta.url));
const readJson = async (file) => JSON.parse(await readFile(join(migrations, "meta", file), "utf8"));

test("circuit migration appends to, rather than replaces, upstream history", async () => {
  const journal = await readJson("_journal.json");
  const tags = journal.entries.map((entry) => entry.tag);
  const files = (await readdir(migrations)).filter((file) => file.endsWith(".sql")).sort();

  assert.equal(journal.entries.find((entry) => entry.idx === 71)?.tag, "0071_default_hire_approval_off");
  assert.equal(journal.entries.find((entry) => entry.idx === 72)?.tag, "0072_large_sandman");
  assert.equal(journal.entries.find((entry) => entry.idx === 289)?.tag, "0289_circuit_quarantine_forward");
  assert.ok(
    journal.entries.find((entry) => entry.idx === 289).when >
    journal.entries.find((entry) => entry.idx === 288).when,
  );
  assert.deepEqual(files, tags.map((tag) => `${tag}.sql`).sort());
  assert.equal(new Set(files.map((file) => file.slice(0, 4))).size, files.length);
});

test("forward DDL tolerates the previously applied production circuit columns and indexes", async () => {
  const sql = await readFile(join(migrations, "0289_circuit_quarantine_forward.sql"), "utf8");
  assert.match(sql, /ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "quarantine_hold" boolean DEFAULT false NOT NULL/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS "issues_company_quarantine_hold_idx"/);
  assert.match(sql, /ALTER TABLE "agent_wakeup_requests" ADD COLUMN IF NOT EXISTS "issue_id" uuid/);
  assert.match(sql, /ALTER TABLE "agent_wakeup_requests" ADD COLUMN IF NOT EXISTS "scheduled_at" timestamp with time zone/);
  assert.match(sql, /ADD CONSTRAINT "agent_wakeup_requests_issue_id_issues_id_fk"[\s\S]*?ON DELETE set null ON UPDATE no action/);
  assert.match(sql, /EXCEPTION WHEN duplicate_object THEN NULL/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS "agent_wakeup_requests_status_scheduled_idx"/);
  assert.equal(sql.split(/-->\s*statement-breakpoint/).length, 6);
});

test("new snapshot extends the latest upstream snapshot with the circuit schema", async () => {
  const upstream = await readJson("0288_snapshot.json");
  const forward = await readJson("0289_snapshot.json");
  assert.equal(forward.prevId, upstream.id);
  assert.notEqual(forward.id, upstream.id);
  assert.equal(forward.tables["public.issues"].columns.quarantine_hold.default, false);
  assert.deepEqual(
    forward.tables["public.issues"].indexes.issues_company_quarantine_hold_idx.columns.map((column) => column.expression),
    ["company_id", "quarantine_hold"],
  );
  const wakeups = forward.tables["public.agent_wakeup_requests"];
  assert.equal(wakeups.columns.issue_id.type, "uuid");
  assert.equal(wakeups.columns.scheduled_at.type, "timestamp with time zone");
  assert.equal(wakeups.foreignKeys.agent_wakeup_requests_issue_id_issues_id_fk.onDelete, "set null");
  assert.deepEqual(
    wakeups.indexes.agent_wakeup_requests_status_scheduled_idx.columns.map((column) => column.expression),
    ["status", "scheduled_at"],
  );
});
