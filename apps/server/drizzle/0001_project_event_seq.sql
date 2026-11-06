-- 事件 seq 改为项目内连续序号（projects.event_seq 计数器分配），见 ARCHITECTURE.md §5.1
DROP INDEX "events_project_seq_idx";--> statement-breakpoint
ALTER TABLE "events" DROP CONSTRAINT "events_pkey";--> statement-breakpoint
ALTER TABLE "events" ALTER COLUMN "seq" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "events" ALTER COLUMN "seq" SET DATA TYPE bigint;--> statement-breakpoint
DROP SEQUENCE IF EXISTS "events_seq_seq";--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "event_seq" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE "projects" p SET "event_seq" = COALESCE((SELECT max(e."seq") FROM "events" e WHERE e."project_id" = p."id"), 0);--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "id" bigserial PRIMARY KEY NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_sessions_coordinator_uq" ON "agent_sessions" USING btree ("project_id") WHERE "agent_sessions"."role" = 'coordinator';--> statement-breakpoint
CREATE UNIQUE INDEX "events_project_seq_uq" ON "events" USING btree ("project_id","seq");
