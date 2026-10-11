ALTER TABLE public.channel_connection_sessions ADD COLUMN credential_version integer NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE public.channel_connection_sessions ADD COLUMN received_at timestamptz;
