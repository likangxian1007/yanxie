CREATE TABLE "api_operation_audit" (
	"id" text PRIMARY KEY NOT NULL,
	"request_id" text NOT NULL,
	"token_id" text NOT NULL,
	"user_id" text NOT NULL,
	"operation_id" text NOT NULL,
	"target" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" integer NOT NULL,
	"error_code" text,
	"elapsed_ms" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_operation_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"token_id" text NOT NULL,
	"operation_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"target" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"response_status" integer,
	"response_body" text,
	"response_type" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "api_token_write_usage" (
	"token_id" text NOT NULL,
	"day" text NOT NULL,
	"used" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "api_token_write_usage_token_id_day_pk" PRIMARY KEY("token_id","day")
);
--> statement-breakpoint
ALTER TABLE "api_operation_audit" ADD CONSTRAINT "api_operation_audit_token_id_api_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."api_tokens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_operation_audit" ADD CONSTRAINT "api_operation_audit_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_operation_requests" ADD CONSTRAINT "api_operation_requests_token_id_api_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."api_tokens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_token_write_usage" ADD CONSTRAINT "api_token_write_usage_token_id_api_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."api_tokens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_operation_audit_token_created_idx" ON "api_operation_audit" USING btree ("token_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "api_operation_requests_key_uq" ON "api_operation_requests" USING btree ("token_id","operation_id","idempotency_key");