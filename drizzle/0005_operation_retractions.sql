ALTER TABLE "labels" ADD COLUMN "retracts_op_id" uuid;--> statement-breakpoint
ALTER TABLE "labels" ADD COLUMN "retracted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "progress_markers" ADD COLUMN "op_id" uuid;--> statement-breakpoint
ALTER TABLE "progress_markers" ADD COLUMN "previous_state" jsonb;--> statement-breakpoint
ALTER TABLE "progress_markers" ADD COLUMN "retracted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "labels" ADD CONSTRAINT "labels_retracts_op_id_labels_op_id_fk" FOREIGN KEY ("retracts_op_id") REFERENCES "public"."labels"("op_id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "progress_markers" ADD CONSTRAINT "progress_markers_op_id_labels_op_id_fk" FOREIGN KEY ("op_id") REFERENCES "public"."labels"("op_id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE UNIQUE INDEX "markers_op_uq" ON "progress_markers" USING btree ("op_id");