ALTER TABLE "unit_resolutions" ADD COLUMN "search_query" text;
ALTER TABLE "unit_resolutions" ADD COLUMN "search_hits" integer;
ALTER TABLE "unit_resolutions" DROP CONSTRAINT "unit_resolutions_decided_valid";
ALTER TABLE "unit_resolutions" ADD CONSTRAINT "unit_resolutions_decided_valid" CHECK ("unit_resolutions"."decided_by" IN ('score', 'reference', 'model_context', 'question', 'admin', 'search'));
