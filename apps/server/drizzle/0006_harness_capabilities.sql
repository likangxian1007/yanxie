CREATE TABLE "agent_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"scope" text NOT NULL,
	"owner_user_id" text,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"icon" text DEFAULT 'Sparkles' NOT NULL,
	"prompt" text DEFAULT '' NOT NULL,
	"skills" text[] DEFAULT '{}'::text[] NOT NULL,
	"starters" text[] DEFAULT '{}'::text[] NOT NULL,
	"effort" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "llm_providers" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"base_url" text NOT NULL,
	"api_key" text DEFAULT '' NOT NULL,
	"thinking_format" text DEFAULT 'openai' NOT NULL,
	"models" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_servers" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"scope" text NOT NULL,
	"owner_user_id" text,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"transport" text NOT NULL,
	"command" text DEFAULT '' NOT NULL,
	"args" text[] DEFAULT '{}'::text[] NOT NULL,
	"env" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"url" text DEFAULT '' NOT NULL,
	"headers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"disabled_tools" text[] DEFAULT '{}'::text[] NOT NULL,
	"roles" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_by" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skills" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"scope" text NOT NULL,
	"owner_user_id" text,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"user_invocable" boolean DEFAULT true NOT NULL,
	"model_invocable" boolean DEFAULT true NOT NULL,
	"updated_by" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "slash_commands" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"scope" text NOT NULL,
	"owner_user_id" text,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"argument_hint" text DEFAULT '' NOT NULL,
	"template" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "effort" text;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "profile" text;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "goal" text;--> statement-breakpoint
ALTER TABLE "agent_profiles" ADD CONSTRAINT "agent_profiles_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_profiles" ADD CONSTRAINT "agent_profiles_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_providers" ADD CONSTRAINT "llm_providers_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slash_commands" ADD CONSTRAINT "slash_commands_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slash_commands" ADD CONSTRAINT "slash_commands_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_profiles_project_idx" ON "agent_profiles" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "llm_providers_project_idx" ON "llm_providers" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "mcp_servers_project_idx" ON "mcp_servers" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "skills_project_idx" ON "skills" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "slash_commands_project_idx" ON "slash_commands" USING btree ("project_id");