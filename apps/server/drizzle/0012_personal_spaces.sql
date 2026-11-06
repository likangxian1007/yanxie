CREATE TABLE "share_grants" (
	"resource_kind" text NOT NULL,
	"resource_id" text NOT NULL,
	"project_id" text NOT NULL,
	"user_id" text NOT NULL,
	"level" text DEFAULT 'view' NOT NULL,
	"granted_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "share_grants_resource_kind_resource_id_user_id_pk" PRIMARY KEY("resource_kind","resource_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "share_links" (
	"resource_kind" text NOT NULL,
	"resource_id" text NOT NULL,
	"project_id" text NOT NULL,
	"scope" text DEFAULT 'invited' NOT NULL,
	"level" text DEFAULT 'view' NOT NULL,
	"token" text NOT NULL,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "share_links_resource_kind_resource_id_pk" PRIMARY KEY("resource_kind","resource_id")
);
--> statement-breakpoint
CREATE TABLE "share_visits" (
	"resource_kind" text NOT NULL,
	"resource_id" text NOT NULL,
	"user_id" text NOT NULL,
	"token" text NOT NULL,
	"visited_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "share_visits_resource_kind_resource_id_user_id_pk" PRIMARY KEY("resource_kind","resource_id","user_id")
);
--> statement-breakpoint
DROP INDEX "papers_citekey_uq";--> statement-breakpoint
DROP INDEX "papers_doi_uq";--> statement-breakpoint
DROP INDEX "papers_arxiv_uq";--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "space" text DEFAULT 'team' NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "owner_user_id" text;--> statement-breakpoint
ALTER TABLE "papers" ADD COLUMN "space" text DEFAULT 'team' NOT NULL;--> statement-breakpoint
ALTER TABLE "papers" ADD COLUMN "owner_user_id" text;--> statement-breakpoint
ALTER TABLE "papers" ADD COLUMN "private_pdf_path" text;--> statement-breakpoint
ALTER TABLE "share_grants" ADD CONSTRAINT "share_grants_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_grants" ADD CONSTRAINT "share_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_grants" ADD CONSTRAINT "share_grants_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_visits" ADD CONSTRAINT "share_visits_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "share_grants_user_idx" ON "share_grants" USING btree ("user_id","project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "share_links_token_uq" ON "share_links" USING btree ("token");--> statement-breakpoint
CREATE INDEX "share_visits_user_idx" ON "share_visits" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "papers" ADD CONSTRAINT "papers_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "documents_space_idx" ON "documents" USING btree ("project_id","space","owner_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "papers_lib_citekey_uq" ON "papers" USING btree ("project_id",coalesce("owner_user_id", ''),"citekey");--> statement-breakpoint
CREATE UNIQUE INDEX "papers_lib_doi_uq" ON "papers" USING btree ("project_id",coalesce("owner_user_id", ''),"doi") WHERE "papers"."doi" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "papers_lib_arxiv_uq" ON "papers" USING btree ("project_id",coalesce("owner_user_id", ''),"arxiv_id") WHERE "papers"."arxiv_id" is not null;