CREATE TABLE "research_workspace_items" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"record_id" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"preview" text DEFAULT '' NOT NULL,
	"resource" jsonb,
	"evidence_ref" jsonb,
	"action" jsonb,
	"origin" jsonb,
	"parent_id" text,
	"position" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"position_version" integer DEFAULT 1 NOT NULL,
	"created_by" jsonb NOT NULL,
	"updated_by" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "research_workspace_relations" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"record_id" text NOT NULL,
	"from_item_id" text NOT NULL,
	"to_item_id" text NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" jsonb NOT NULL,
	"updated_by" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "research_recipe_versions" (
	"id" text NOT NULL,
	"version" integer NOT NULL,
	"project_id" text NOT NULL,
	"record_id" text NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "research_recipe_versions_id_version_pk" PRIMARY KEY("id","version")
);
--> statement-breakpoint
CREATE TABLE "research_run_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"record_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"run_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "research_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"record_id" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "research_workspace_items" ADD CONSTRAINT "research_workspace_items_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_workspace_items" ADD CONSTRAINT "research_workspace_items_record_id_research_entities_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."research_entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_workspace_relations" ADD CONSTRAINT "research_workspace_relations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_workspace_relations" ADD CONSTRAINT "research_workspace_relations_record_id_research_entities_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."research_entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_workspace_relations" ADD CONSTRAINT "research_workspace_relations_from_item_id_research_workspace_items_id_fk" FOREIGN KEY ("from_item_id") REFERENCES "public"."research_workspace_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_workspace_relations" ADD CONSTRAINT "research_workspace_relations_to_item_id_research_workspace_items_id_fk" FOREIGN KEY ("to_item_id") REFERENCES "public"."research_workspace_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_recipe_versions" ADD CONSTRAINT "research_recipe_versions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_run_keys" ADD CONSTRAINT "research_run_keys_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_run_keys" ADD CONSTRAINT "research_run_keys_run_id_research_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."research_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_runs" ADD CONSTRAINT "research_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "research_workspace_items_list_idx" ON "research_workspace_items" USING btree ("project_id","record_id","id");--> statement-breakpoint
CREATE INDEX "research_workspace_relations_list_idx" ON "research_workspace_relations" USING btree ("project_id","record_id","id");--> statement-breakpoint
CREATE INDEX "research_recipe_record_idx" ON "research_recipe_versions" USING btree ("project_id","record_id");--> statement-breakpoint
CREATE UNIQUE INDEX "research_run_key_scope_idx" ON "research_run_keys" USING btree ("project_id","record_id","actor_id","key");--> statement-breakpoint
CREATE INDEX "research_runs_record_idx" ON "research_runs" USING btree ("project_id","record_id");