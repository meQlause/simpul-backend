CREATE TABLE "media_outcomes" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"message_id" uuid PRIMARY KEY NOT NULL,
	"outcome" text NOT NULL,
	CONSTRAINT "media_outcome_valid" CHECK ("media_outcomes"."outcome" IN ('transcript','unread'))
);
--> statement-breakpoint
ALTER TABLE "media_outcomes" ADD CONSTRAINT "media_outcomes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "media_outcomes" ADD CONSTRAINT "media_outcomes_message_id_messages_raw_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages_raw"("id") ON DELETE cascade ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE public.media_outcomes ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON public.media_outcomes
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
