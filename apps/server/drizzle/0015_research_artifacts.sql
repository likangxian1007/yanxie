CREATE TABLE "research_artifact_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"record_id" text NOT NULL,
	"item_id" text NOT NULL,
	"version" integer NOT NULL,
	"storage_path" text NOT NULL,
	"request_key" text NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "research_workspace_items" ADD COLUMN "payload" jsonb;--> statement-breakpoint
ALTER TABLE "research_artifact_versions" ADD CONSTRAINT "research_artifact_versions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_artifact_versions" ADD CONSTRAINT "research_artifact_versions_item_id_research_workspace_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."research_workspace_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "research_artifact_item_version_idx" ON "research_artifact_versions" USING btree ("item_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "research_artifact_request_idx" ON "research_artifact_versions" USING btree ("project_id","request_key");--> statement-breakpoint
CREATE INDEX "research_artifact_record_idx" ON "research_artifact_versions" USING btree ("project_id","record_id","item_id","id");