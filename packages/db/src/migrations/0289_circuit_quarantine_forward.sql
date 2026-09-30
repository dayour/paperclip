-- Production previously applied distinct 0071/0072 circuit migrations. Keep the upstream
-- journal unchanged; these guards make the same schema safe on both histories.
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "quarantine_hold" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: Transactional Drizzle migrations cannot build indexes concurrently. Production already has this index; new databases need it to find held issues.
CREATE INDEX IF NOT EXISTS "issues_company_quarantine_hold_idx" ON "issues" USING btree ("company_id","quarantine_hold");
--> statement-breakpoint
ALTER TABLE "agent_wakeup_requests" ADD COLUMN IF NOT EXISTS "issue_id" uuid;
--> statement-breakpoint
ALTER TABLE "agent_wakeup_requests" ADD COLUMN IF NOT EXISTS "scheduled_at" timestamp with time zone;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "agent_wakeup_requests" ADD CONSTRAINT "agent_wakeup_requests_issue_id_issues_id_fk"
    FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: Transactional Drizzle migrations cannot build indexes concurrently. Production already has this index; new databases need it for deferred-wake scheduling.
CREATE INDEX IF NOT EXISTS "agent_wakeup_requests_status_scheduled_idx" ON "agent_wakeup_requests" USING btree ("status","scheduled_at");
