CREATE TABLE "basis_proposals" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"title" text NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"rationale" text DEFAULT '' NOT NULL,
	"impact" text DEFAULT '' NOT NULL,
	"conditions" text DEFAULT '' NOT NULL,
	"claim_type" text,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"base_plan_version" integer,
	"source_plan_id" text,
	"supersedes_basis_id" text,
	"author_id" text NOT NULL,
	"drafted_by" jsonb NOT NULL,
	"submitted_at" timestamp with time zone,
	"decided_by" jsonb,
	"decided_at" timestamp with time zone,
	"decision_note" text DEFAULT '' NOT NULL,
	"result_plan_version" integer,
	"result_basis_id" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "personal_memory" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"user_id" text NOT NULL,
	"title" text NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"updated_by" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plan_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"plan_id" text NOT NULL,
	"version" integer NOT NULL,
	"content" text NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"proposal_id" text,
	"approved_by" jsonb,
	"created_by" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"forked_from_version" integer,
	"owner_id" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "team_basis" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"claim_type" text NOT NULL,
	"conditions" text DEFAULT '' NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"plan_version" integer,
	"proposal_id" text NOT NULL,
	"proposer_id" text,
	"proposer" jsonb NOT NULL,
	"approved_by" jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"review_reason" text DEFAULT '' NOT NULL,
	"superseded_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "basis_proposals" ADD CONSTRAINT "basis_proposals_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "basis_proposals" ADD CONSTRAINT "basis_proposals_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_memory" ADD CONSTRAINT "personal_memory_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_memory" ADD CONSTRAINT "personal_memory_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_versions" ADD CONSTRAINT "plan_versions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_versions" ADD CONSTRAINT "plan_versions_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_basis" ADD CONSTRAINT "team_basis_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_basis" ADD CONSTRAINT "team_basis_proposer_id_users_id_fk" FOREIGN KEY ("proposer_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "basis_proposals_project_idx" ON "basis_proposals" USING btree ("project_id","status","created_at");--> statement-breakpoint
CREATE INDEX "personal_memory_owner_idx" ON "personal_memory" USING btree ("project_id","user_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "plan_versions_plan_version_uq" ON "plan_versions" USING btree ("plan_id","version");--> statement-breakpoint
CREATE INDEX "plans_project_idx" ON "plans" USING btree ("project_id","kind","status");--> statement-breakpoint
CREATE INDEX "team_basis_project_idx" ON "team_basis" USING btree ("project_id","status");