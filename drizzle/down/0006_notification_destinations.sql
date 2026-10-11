DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM notifications WHERE recipient_person_id IS NULL) THEN
    RAISE EXCEPTION 'Cannot remove channel destinations while channel notifications exist';
  END IF;
END $$;
ALTER TABLE notifications DROP CONSTRAINT notifications_exactly_one_destination;
DROP INDEX notif_one_per_label_channel_uq;
ALTER TABLE notifications DROP CONSTRAINT notifications_destination_channel_id_channels_id_fk;
ALTER TABLE notifications DROP COLUMN destination_channel_id;
ALTER TABLE notifications ALTER COLUMN recipient_person_id SET NOT NULL;
