CREATE TABLE "agent_wakeups" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"session_id" text NOT NULL,
	"reason" text NOT NULL,
	"wakes" boolean DEFAULT true NOT NULL,
	"item" jsonb NOT NULL,
	"consumed_at" timestamp with time zone,
	"consumed_turn_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "summary_through_turn_id" text;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "current_turn_id" text;--> statement-breakpoint
ALTER TABLE "agent_wakeups" ADD CONSTRAINT "agent_wakeups_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_wakeups" ADD CONSTRAINT "agent_wakeups_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_wakeups_pending_idx" ON "agent_wakeups" USING btree ("session_id","consumed_at");