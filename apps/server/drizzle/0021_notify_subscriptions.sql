CREATE TABLE "notify_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"subscription_id" text NOT NULL,
	"project_id" text NOT NULL,
	"event_seq" integer NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"text" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"response_status" integer,
	"response_snippet" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notify_subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"project_id" text,
	"provider" text DEFAULT 'feishu' NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"url_hint" text NOT NULL,
	"event_types" text[] DEFAULT '{}'::text[] NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"failure_streak" integer DEFAULT 0 NOT NULL,
	"disabled_reason" text,
	"last_success_at" timestamp with time zone,
	"last_failure_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notify_deliveries" ADD CONSTRAINT "notify_deliveries_subscription_id_notify_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."notify_subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notify_subscriptions" ADD CONSTRAINT "notify_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notify_subscriptions" ADD CONSTRAINT "notify_subscriptions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notify_deliv_idem_uq" ON "notify_deliveries" USING btree ("subscription_id","project_id","event_seq");--> statement-breakpoint
CREATE INDEX "notify_deliv_status_idx" ON "notify_deliveries" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "notify_deliv_sub_idx" ON "notify_deliveries" USING btree ("subscription_id","created_at");--> statement-breakpoint
CREATE INDEX "notify_sub_user_idx" ON "notify_subscriptions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "notify_sub_enabled_idx" ON "notify_subscriptions" USING btree ("enabled");