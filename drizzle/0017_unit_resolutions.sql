CREATE TABLE "unit_resolutions" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"unit_id" uuid PRIMARY KEY NOT NULL,
	"verdict" text NOT NULL,
	"decided_by" text NOT NULL,
	"candidates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"chosen_thread_id" uuid,
	"context_message_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "unit_resolutions_verdict_valid" CHECK ("unit_resolutions"."verdict" IN ('ATTACH', 'GREY', 'CREATE')),
	CONSTRAINT "unit_resolutions_decided_valid" CHECK ("unit_resolutions"."decided_by" IN ('score', 'reference', 'model_context', 'question', 'admin')),
	CONSTRAINT "unit_resolutions_candidates_valid" CHECK (jsonb_array_length("unit_resolutions"."candidates") <= 3),
	CONSTRAINT "unit_resolutions_context_valid" CHECK ("unit_resolutions"."context_message_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "unit_resolutions" ADD CONSTRAINT "unit_resolutions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "unit_resolutions" ADD CONSTRAINT "unit_resolutions_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE cascade ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "unit_resolutions" ADD CONSTRAINT "unit_resolutions_chosen_thread_id_threads_id_fk" FOREIGN KEY ("chosen_thread_id") REFERENCES "public"."threads"("id") ON DELETE set null ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE public.unit_resolutions ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON public.unit_resolutions
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
