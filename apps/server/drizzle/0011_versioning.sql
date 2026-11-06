CREATE TABLE "change_proposals" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"target_kind" text NOT NULL,
	"target_id" text NOT NULL,
	"title" text NOT NULL,
	"explanation" text DEFAULT '' NOT NULL,
	"author" jsonb NOT NULL,
	"thread_id" text,
	"review_id" text,
	"status" text DEFAULT 'open' NOT NULL,
	"base_state" "bytea" NOT NULL,
	"draft_state" "bytea" NOT NULL,
	"hunks" jsonb NOT NULL,
	"merge_result" jsonb,
	"merged_by" jsonb,
	"merged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "versioning_settings" (
	"project_id" text PRIMARY KEY NOT NULL,
	"agent_direct_write" boolean DEFAULT false NOT NULL,
	"github_repo" text,
	"github_branch" text DEFAULT 'main' NOT NULL,
	"github_token" text,
	"updated_by" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "versions" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"target_kind" text NOT NULL,
	"target_id" text NOT NULL,
	"kind" text NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"state" "bytea",
	"blob" "bytea",
	"content" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"size" integer DEFAULT 0 NOT NULL,
	"created_by" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "change_proposals" ADD CONSTRAINT "change_proposals_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "versioning_settings" ADD CONSTRAINT "versioning_settings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "versions" ADD CONSTRAINT "versions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "change_proposals_target_idx" ON "change_proposals" USING btree ("project_id","target_kind","target_id");--> statement-breakpoint
CREATE INDEX "change_proposals_review_idx" ON "change_proposals" USING btree ("review_id");--> statement-breakpoint
CREATE INDEX "versions_target_idx" ON "versions" USING btree ("project_id","target_kind","target_id","created_at");