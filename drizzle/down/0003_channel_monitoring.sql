ALTER TABLE channels DROP CONSTRAINT channels_monitored_only_when_active;
ALTER TABLE channels ADD CONSTRAINT channels_monitored_only_when_active
  CHECK (NOT monitored OR (connection_status = 'active'
     AND authorization_ack_at IS NOT NULL
     AND monitoring_started_at IS NOT NULL
     AND visible_indicator_message_id IS NOT NULL
     AND (provider <> 'telegram' OR provider_chat_type IN ('group','supergroup'))));
