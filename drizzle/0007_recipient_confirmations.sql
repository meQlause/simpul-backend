ALTER TABLE "progress_markers" ADD COLUMN "confirmed_by" uuid;--> statement-breakpoint
ALTER TABLE "progress_markers" ADD COLUMN "confirmation_id" text;--> statement-breakpoint
ALTER TABLE "progress_markers" ADD CONSTRAINT "progress_markers_confirmed_by_people_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."people"("id") ON DELETE restrict ON UPDATE restrict;