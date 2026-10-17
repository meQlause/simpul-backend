CREATE TABLE "person_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"bot_connection_id" uuid NOT NULL,
	"code_hash" bytea NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	CONSTRAINT "person_invites_expiry_valid" CHECK ("person_invites"."expires_at" > "person_invites"."created_at")
);
--> statement-breakpoint
ALTER TABLE "person_invites" ADD CONSTRAINT "person_invites_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "person_invites" ADD CONSTRAINT "person_invites_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "person_invites" ADD CONSTRAINT "person_invites_bot_connection_id_bot_connections_id_fk" FOREIGN KEY ("bot_connection_id") REFERENCES "public"."bot_connections"("id") ON DELETE cascade ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "person_invites" ADD CONSTRAINT "person_invites_created_by_people_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."people"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE UNIQUE INDEX "person_invites_person_uq" ON "person_invites" USING btree ("workspace_id","person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "person_invites_hash_uq" ON "person_invites" USING btree ("code_hash");--> statement-breakpoint
ALTER TABLE "person_identities" ADD COLUMN "started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "failed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "failure_reason" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notif_failure_reason_valid" CHECK ("notifications"."failure_reason" IN ('recipient_unreachable'));--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notif_failed_alone" CHECK (("notifications"."failed_at" IS NULL) = ("notifications"."failure_reason" IS NULL) AND ("notifications"."failed_at" IS NULL OR ("notifications"."sent_at" IS NULL AND "notifications"."cancelled_at" IS NULL)));
--> statement-breakpoint
ALTER TABLE public.person_invites ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON public.person_invites
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
