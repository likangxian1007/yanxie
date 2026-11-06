ALTER TABLE "todos" DROP CONSTRAINT "todos_assignee_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "kind" text DEFAULT 'doc' NOT NULL;--> statement-breakpoint
ALTER TABLE "experiment_logs" ADD COLUMN "metrics" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "experiments" ADD COLUMN "params" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "experiments" ADD COLUMN "links" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "experiments" ADD COLUMN "created_by" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "stats" jsonb;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "error" text;--> statement-breakpoint
ALTER TABLE "review_comments" ADD COLUMN "verdict" text;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "thread_id" text;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "snapshot" text;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;