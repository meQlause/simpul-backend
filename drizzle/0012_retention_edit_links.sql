ALTER TABLE "messages_raw" DROP CONSTRAINT "messages_raw_supersedes_messages_raw_id_fk";
--> statement-breakpoint
ALTER TABLE "messages_raw" ADD CONSTRAINT "messages_raw_supersedes_messages_raw_id_fk" FOREIGN KEY ("supersedes") REFERENCES "public"."messages_raw"("id") ON DELETE set null ON UPDATE restrict;
--> statement-breakpoint
-- Only a cascading foreign-key cleanup may clear the edit link. The payload stays immutable.
CREATE OR REPLACE FUNCTION public.messages_raw_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF pg_trigger_depth() > 1 AND OLD.supersedes IS NOT NULL AND NEW.supersedes IS NULL
    AND (to_jsonb(NEW) - 'supersedes') = (to_jsonb(OLD) - 'supersedes')
    AND NOT EXISTS (SELECT 1 FROM public.messages_raw WHERE id = OLD.supersedes) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'messages_raw is append-only';
END $$;
