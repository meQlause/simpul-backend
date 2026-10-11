CREATE OR REPLACE FUNCTION public.messages_raw_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'messages_raw is append-only'; END $$;
ALTER TABLE public.messages_raw DROP CONSTRAINT messages_raw_supersedes_messages_raw_id_fk;
ALTER TABLE public.messages_raw ADD CONSTRAINT messages_raw_supersedes_messages_raw_id_fk
  FOREIGN KEY (supersedes) REFERENCES public.messages_raw(id) ON DELETE RESTRICT ON UPDATE RESTRICT;
