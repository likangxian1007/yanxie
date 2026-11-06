ALTER TABLE "experiment_logs" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "experiments" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "experiment_logs" CASCADE;--> statement-breakpoint
DROP TABLE "experiments" CASCADE;--> statement-breakpoint
ALTER TABLE "notebooks" DROP CONSTRAINT IF EXISTS "notebooks_experiment_id_experiments_id_fk";
--> statement-breakpoint
DROP INDEX "notebooks_experiment_idx";--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN "preferred_research_methods";--> statement-breakpoint
ALTER TABLE "cards" DROP COLUMN "experiment_id";--> statement-breakpoint
ALTER TABLE "notebooks" DROP COLUMN "experiment_id";