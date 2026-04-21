ALTER TABLE "agent_wakeup_requests" ADD COLUMN "issue_id" uuid REFERENCES "issues"("id");
--> statement-breakpoint
ALTER TABLE "agent_wakeup_requests" ADD COLUMN "scheduled_at" timestamp with time zone;
