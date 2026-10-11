DROP INDEX "markers_op_uq";
ALTER TABLE "progress_markers" DROP CONSTRAINT "progress_markers_op_id_labels_op_id_fk";
ALTER TABLE "labels" DROP CONSTRAINT "labels_retracts_op_id_labels_op_id_fk";
ALTER TABLE "progress_markers" DROP COLUMN "retracted_at", DROP COLUMN "previous_state", DROP COLUMN "op_id";
ALTER TABLE "labels" DROP COLUMN "retracted_at", DROP COLUMN "retracts_op_id";
