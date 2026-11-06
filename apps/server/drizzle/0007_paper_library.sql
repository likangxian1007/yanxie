CREATE TABLE "paper_chunks" (
	"id" text PRIMARY KEY NOT NULL,
	"paper_id" text NOT NULL,
	"project_id" text NOT NULL,
	"seq" integer NOT NULL,
	"kind" text NOT NULL,
	"section_index" integer,
	"section_path" text DEFAULT '' NOT NULL,
	"page" integer NOT NULL,
	"para" integer NOT NULL,
	"boxes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"text" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "papers" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"authors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"year" integer,
	"venue" text,
	"abstract" text,
	"doi" text,
	"arxiv_id" text,
	"url" text,
	"pdf_url" text,
	"pdf_sha256" text,
	"citekey" text NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"source" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"stage" text,
	"error" text,
	"parser" text,
	"file_id" text,
	"page_count" integer,
	"chunk_count" integer DEFAULT 0 NOT NULL,
	"has_latex_source" integer DEFAULT 0 NOT NULL,
	"structure" jsonb,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_by" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "paper_chunks" ADD CONSTRAINT "paper_chunks_paper_id_papers_id_fk" FOREIGN KEY ("paper_id") REFERENCES "public"."papers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_chunks" ADD CONSTRAINT "paper_chunks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "papers" ADD CONSTRAINT "papers_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "papers" ADD CONSTRAINT "papers_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "paper_chunks_paper_idx" ON "paper_chunks" USING btree ("paper_id","seq");--> statement-breakpoint
CREATE INDEX "paper_chunks_project_idx" ON "paper_chunks" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "papers_project_idx" ON "papers" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "papers_citekey_uq" ON "papers" USING btree ("project_id","citekey");--> statement-breakpoint
CREATE UNIQUE INDEX "papers_doi_uq" ON "papers" USING btree ("project_id","doi") WHERE "papers"."doi" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "papers_arxiv_uq" ON "papers" USING btree ("project_id","arxiv_id") WHERE "papers"."arxiv_id" is not null;