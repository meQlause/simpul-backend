CREATE TABLE "message_access_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "unit_corrections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"action" text NOT NULL,
	"thread_id" uuid NOT NULL,
	"previous_outcome" text NOT NULL,
	"corrected_by" uuid NOT NULL,
	CONSTRAINT "unit_corrections_action_valid" CHECK ("unit_corrections"."action" IN ('create', 'attach'))
);
--> statement-breakpoint
ALTER TABLE "policies" ADD COLUMN "message_text_access" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "message_access_log" ADD CONSTRAINT "message_access_log_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "message_access_log" ADD CONSTRAINT "message_access_log_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "message_access_log" ADD CONSTRAINT "message_access_log_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "unit_corrections" ADD CONSTRAINT "unit_corrections_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "unit_corrections" ADD CONSTRAINT "unit_corrections_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE cascade ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "unit_corrections" ADD CONSTRAINT "unit_corrections_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "unit_corrections" ADD CONSTRAINT "unit_corrections_corrected_by_people_id_fk" FOREIGN KEY ("corrected_by") REFERENCES "public"."people"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE INDEX "message_access_log_ws_time_idx" ON "message_access_log" USING btree ("workspace_id","accessed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "unit_corrections_unit_idx" ON "unit_corrections" USING btree ("workspace_id","unit_id","created_at" DESC NULLS LAST);
--> statement-breakpoint
ALTER TABLE public.message_access_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON public.message_access_log
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE public.unit_corrections ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON public.unit_corrections
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
