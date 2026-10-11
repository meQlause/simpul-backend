ALTER TABLE "open_questions" ADD COLUMN "unit_id" uuid;--> statement-breakpoint
ALTER TABLE "open_questions" ADD CONSTRAINT "open_questions_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE cascade ON UPDATE restrict;--> statement-breakpoint
CREATE UNIQUE INDEX "oq_unit_uq" ON "open_questions" USING btree ("unit_id");
