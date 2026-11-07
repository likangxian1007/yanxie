CREATE TABLE "project_credit_balances" (
	"project_id" text PRIMARY KEY NOT NULL,
	"balance" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_credit_caps" (
	"project_id" text NOT NULL,
	"user_id" text NOT NULL,
	"monthly_cap" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_credit_caps_project_id_user_id_pk" PRIMARY KEY("project_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD COLUMN "wallet" text DEFAULT 'personal' NOT NULL;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD COLUMN "turn_ref" text;--> statement-breakpoint
ALTER TABLE "pay_orders" ADD COLUMN "wallet" text DEFAULT 'personal' NOT NULL;--> statement-breakpoint
ALTER TABLE "pay_orders" ADD COLUMN "project_id" text;--> statement-breakpoint
ALTER TABLE "project_credit_balances" ADD CONSTRAINT "project_credit_balances_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_credit_caps" ADD CONSTRAINT "project_credit_caps_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_credit_caps" ADD CONSTRAINT "project_credit_caps_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_orders" ADD CONSTRAINT "pay_orders_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "credit_ledger_project_idx" ON "credit_ledger" USING btree ("project_id","wallet","created_at");--> statement-breakpoint
CREATE INDEX "credit_ledger_turn_idx" ON "credit_ledger" USING btree ("turn_ref");