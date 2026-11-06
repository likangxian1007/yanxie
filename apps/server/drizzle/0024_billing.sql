CREATE TABLE "credit_balances" (
	"user_id" text PRIMARY KEY NOT NULL,
	"balance" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_ledger" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"delta" bigint NOT NULL,
	"kind" text NOT NULL,
	"ref" text,
	"model" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"cost_usd_micros" bigint,
	"project_id" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kyren_events" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kyren_products" (
	"sku" text PRIMARY KEY NOT NULL,
	"product_id" text NOT NULL,
	"price" text NOT NULL,
	"currency" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pay_orders" (
	"id" text PRIMARY KEY NOT NULL,
	"ref" text NOT NULL,
	"user_id" text NOT NULL,
	"sku" text NOT NULL,
	"credits" bigint NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text NOT NULL,
	"product_id" text NOT NULL,
	"status" text DEFAULT 'created' NOT NULL,
	"kyren_checkout_id" text,
	"kyren_order_id" text,
	"review_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paid_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "credit_balances" ADD CONSTRAINT "credit_balances_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_orders" ADD CONSTRAINT "pay_orders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "credit_ledger_ref_uq" ON "credit_ledger" USING btree ("ref");--> statement-breakpoint
CREATE INDEX "credit_ledger_user_idx" ON "credit_ledger" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "pay_orders_ref_uq" ON "pay_orders" USING btree ("ref");--> statement-breakpoint
CREATE INDEX "pay_orders_user_idx" ON "pay_orders" USING btree ("user_id","created_at");