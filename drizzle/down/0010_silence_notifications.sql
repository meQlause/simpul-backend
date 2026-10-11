-- Refuse rollback when label-free reminders exist; keep notification history intact.
ALTER TABLE notifications ALTER COLUMN label_id SET NOT NULL;
ALTER TABLE notifications DROP CONSTRAINT notifications_source_valid;
DROP INDEX notif_silence_cycle_uq;
DROP INDEX notif_one_per_label_uq;
DROP INDEX notif_one_per_label_channel_uq;
ALTER TABLE notifications DROP COLUMN stale_since;
CREATE UNIQUE INDEX notif_one_per_label_uq ON notifications (label_id, recipient_person_id, kind) WHERE cancelled_at IS NULL;
CREATE UNIQUE INDEX notif_one_per_label_channel_uq ON notifications (label_id, destination_channel_id, kind) WHERE cancelled_at IS NULL;
