CREATE TABLE "notebooks" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"experiment_id" text,
	"title" text DEFAULT '未命名 Notebook' NOT NULL,
	"language" text DEFAULT 'python' NOT NULL,
	"cell_count" integer DEFAULT 0 NOT NULL,
	"ydoc_state" "bytea",
	"created_by" jsonb NOT NULL,
	"updated_by" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "notebooks" ADD CONSTRAINT "notebooks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notebooks" ADD CONSTRAINT "notebooks_experiment_id_experiments_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "public"."experiments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notebooks_project_idx" ON "notebooks" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "notebooks_experiment_idx" ON "notebooks" USING btree ("experiment_id");