ALTER TABLE "progress_markers" DROP CONSTRAINT "progress_markers_confirmed_by_people_id_fk";
ALTER TABLE "progress_markers" DROP COLUMN "confirmation_id";
ALTER TABLE "progress_markers" DROP COLUMN "confirmed_by";
