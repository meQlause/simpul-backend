CREATE TABLE "digest_items" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"digest_id" uuid NOT NULL,
	"label_id" uuid NOT NULL,
	"rule_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "digest_items" ADD CONSTRAINT "digest_items_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "digest_items" ADD CONSTRAINT "digest_items_digest_id_digests_id_fk" FOREIGN KEY ("digest_id") REFERENCES "public"."digests"("id") ON DELETE cascade ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "digest_items" ADD CONSTRAINT "digest_items_label_id_labels_id_fk" FOREIGN KEY ("label_id") REFERENCES "public"."labels"("id") ON DELETE cascade ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "digest_items" ADD CONSTRAINT "digest_items_rule_id_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."rules"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE UNIQUE INDEX "digest_items_label_uq" ON "digest_items" USING btree ("digest_id","label_id");
--> statement-breakpoint
ALTER TABLE public.digest_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON public.digest_items
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
