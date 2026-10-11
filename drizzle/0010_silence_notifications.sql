DROP INDEX "notif_one_per_label_uq";--> statement-breakpoint
DROP INDEX "notif_one_per_label_channel_uq";--> statement-breakpoint
ALTER TABLE "notifications" ALTER COLUMN "label_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "stale_since" timestamp with time zone;--> statement-breakpoint
WITH legacy AS (
  SELECT n.id, t.last_activity_at, row_number() OVER (
    PARTITION BY n.workspace_id, n.thread_id, n.kind
    ORDER BY n.sent_at NULLS LAST, n.created_at, n.id
  ) AS ordinal FROM notifications n JOIN threads t
    ON t.workspace_id = n.workspace_id AND t.id = n.thread_id
  WHERE n.kind IN ('reminder','escalation') AND n.cancelled_at IS NULL
)
UPDATE notifications n SET
  stale_since = CASE WHEN legacy.ordinal = 1 THEN legacy.last_activity_at ELSE NULL END,
  cancelled_at = CASE WHEN legacy.ordinal > 1 AND n.sent_at IS NULL THEN now() ELSE n.cancelled_at END
FROM legacy WHERE legacy.id = n.id;--> statement-breakpoint
CREATE UNIQUE INDEX "notif_silence_cycle_uq" ON "notifications" USING btree ("workspace_id","thread_id","kind","stale_since") WHERE "notifications"."kind" IN ('reminder','escalation') AND "notifications"."cancelled_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "notif_one_per_label_uq" ON "notifications" USING btree ("label_id","recipient_person_id","kind") WHERE "notifications"."cancelled_at" IS NULL AND "notifications"."kind" IN ('update','correction');--> statement-breakpoint
CREATE UNIQUE INDEX "notif_one_per_label_channel_uq" ON "notifications" USING btree ("label_id","destination_channel_id","kind") WHERE "notifications"."cancelled_at" IS NULL AND "notifications"."kind" IN ('update','correction');--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_source_valid" CHECK ("notifications"."label_id" IS NOT NULL OR ("notifications"."kind" IN ('reminder','escalation') AND "notifications"."thread_id" IS NOT NULL));
