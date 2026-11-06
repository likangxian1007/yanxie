CREATE TABLE "paper_annotations" (
	"id" text PRIMARY KEY NOT NULL,
	"paper_id" text NOT NULL,
	"kind" text NOT NULL,
	"color" text DEFAULT 'yellow' NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"file_id" text NOT NULL,
	"pdf_sha256" text,
	"page" integer NOT NULL,
	"quote" text NOT NULL,
	"boxes" jsonb NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"ydoc_state" "bytea" NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"metadata_version" integer DEFAULT 1 NOT NULL,
	"created_by" jsonb NOT NULL,
	"updated_by" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"restored_to_id" text,
	"published_from" jsonb
);
--> statement-breakpoint
CREATE TABLE "paper_notes" (
	"id" text PRIMARY KEY NOT NULL,
	"paper_id" text NOT NULL,
	"title" text NOT NULL,
	"kind" text DEFAULT 'note' NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"ydoc_state" "bytea" NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" jsonb NOT NULL,
	"updated_by" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"published_from" jsonb
);
--> statement-breakpoint
CREATE TABLE "paper_publications" (
	"id" text PRIMARY KEY NOT NULL,
	"publisher_user_id" text,
	"request_id" text NOT NULL,
	"project_id" text NOT NULL,
	"paper_id" text,
	"source_paper_id" text NOT NULL,
	"source_file_id" text,
	"source_updated_at" timestamp with time zone NOT NULL,
	"published_by" jsonb NOT NULL,
	"note_selection" text DEFAULT '[]' NOT NULL,
	"request_options" text DEFAULT '{}' NOT NULL,
	"summary" jsonb,
	"annotation_selection" text DEFAULT '[]' NOT NULL,
	"qa_selection" text DEFAULT '[]' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "paper_qa_revisions" (
	"id" text PRIMARY KEY NOT NULL,
	"turn_id" text NOT NULL,
	"version" integer NOT NULL,
	"question" text NOT NULL,
	"answer" text NOT NULL,
	"kind" text NOT NULL,
	"actor" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "paper_qa_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"paper_id" text NOT NULL,
	"title" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" jsonb NOT NULL,
	"updated_by" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "paper_qa_turns" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"paper_id" text NOT NULL,
	"generation_id" text NOT NULL,
	"request_id" text NOT NULL,
	"request_signature" text NOT NULL,
	"requested_by_user_id" text NOT NULL,
	"question" text NOT NULL,
	"answer" text DEFAULT '' NOT NULL,
	"original_question" text NOT NULL,
	"original_answer" text DEFAULT '' NOT NULL,
	"origin" text DEFAULT 'model' NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"error" text,
	"model_id" text,
	"model_name" text NOT NULL,
	"search_scope" text DEFAULT 'paper' NOT NULL,
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"context" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"context_omitted" boolean DEFAULT false NOT NULL,
	"selection" jsonb,
	"keywords" text[] DEFAULT '{}'::text[] NOT NULL,
	"ydoc_state" "bytea",
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" jsonb NOT NULL,
	"updated_by" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"published_from" jsonb
);
--> statement-breakpoint
ALTER TABLE "files" ALTER COLUMN "project_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "paper_chunks" ALTER COLUMN "project_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "papers" ALTER COLUMN "project_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "owner_user_id" text;--> statement-breakpoint
ALTER TABLE "papers" ADD COLUMN "title_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "papers" ADD COLUMN "tags_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "paper_annotations" ADD CONSTRAINT "paper_annotations_paper_id_papers_id_fk" FOREIGN KEY ("paper_id") REFERENCES "public"."papers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_notes" ADD CONSTRAINT "paper_notes_paper_id_papers_id_fk" FOREIGN KEY ("paper_id") REFERENCES "public"."papers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_publications" ADD CONSTRAINT "paper_publications_publisher_user_id_users_id_fk" FOREIGN KEY ("publisher_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_publications" ADD CONSTRAINT "paper_publications_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_publications" ADD CONSTRAINT "paper_publications_paper_id_papers_id_fk" FOREIGN KEY ("paper_id") REFERENCES "public"."papers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_qa_revisions" ADD CONSTRAINT "paper_qa_revisions_turn_id_paper_qa_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."paper_qa_turns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_qa_sessions" ADD CONSTRAINT "paper_qa_sessions_paper_id_papers_id_fk" FOREIGN KEY ("paper_id") REFERENCES "public"."papers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_qa_turns" ADD CONSTRAINT "paper_qa_turns_session_id_paper_qa_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."paper_qa_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_qa_turns" ADD CONSTRAINT "paper_qa_turns_paper_id_papers_id_fk" FOREIGN KEY ("paper_id") REFERENCES "public"."papers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "paper_annotations_paper_idx" ON "paper_annotations" USING btree ("paper_id","page");--> statement-breakpoint
CREATE INDEX "paper_notes_paper_idx" ON "paper_notes" USING btree ("paper_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "paper_publications_request_uq" ON "paper_publications" USING btree ("publisher_user_id","request_id");--> statement-breakpoint
CREATE INDEX "paper_publications_source_idx" ON "paper_publications" USING btree ("project_id","source_paper_id");--> statement-breakpoint
CREATE UNIQUE INDEX "paper_qa_revisions_version_uq" ON "paper_qa_revisions" USING btree ("turn_id","version");--> statement-breakpoint
CREATE INDEX "paper_qa_sessions_paper_idx" ON "paper_qa_sessions" USING btree ("paper_id","created_at");--> statement-breakpoint
CREATE INDEX "paper_qa_turns_session_idx" ON "paper_qa_turns" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "paper_qa_turns_request_uq" ON "paper_qa_turns" USING btree ("session_id","requested_by_user_id","request_id");--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "files_owner_path_uq" ON "files" USING btree ("owner_user_id","path");--> statement-breakpoint
CREATE INDEX "papers_owner_idx" ON "papers" USING btree ("owner_user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "papers_owner_citekey_uq" ON "papers" USING btree ("owner_user_id","citekey") WHERE "papers"."project_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "papers_owner_doi_uq" ON "papers" USING btree ("owner_user_id","doi") WHERE "papers"."project_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "papers_owner_arxiv_uq" ON "papers" USING btree ("owner_user_id","arxiv_id") WHERE "papers"."project_id" is null;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_one_owner" CHECK (("files"."project_id" is null) <> ("files"."owner_user_id" is null));--> statement-breakpoint
ALTER TABLE "papers" ADD CONSTRAINT "papers_owner_scope" CHECK (("papers"."project_id" is not null and (("papers"."space" = 'team' and "papers"."owner_user_id" is null) or ("papers"."space" = 'personal' and "papers"."owner_user_id" is not null))) or ("papers"."project_id" is null and "papers"."owner_user_id" is not null));