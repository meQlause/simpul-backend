ALTER TABLE public.notifications DROP CONSTRAINT notif_failed_alone;
ALTER TABLE public.notifications DROP CONSTRAINT notif_failure_reason_valid;
ALTER TABLE public.notifications DROP COLUMN failure_reason;
ALTER TABLE public.notifications DROP COLUMN failed_at;
ALTER TABLE public.person_identities DROP COLUMN started_at;
DROP TABLE public.person_invites;
