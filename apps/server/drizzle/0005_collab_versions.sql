ALTER TABLE "reports" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "superseded_by_id" text;