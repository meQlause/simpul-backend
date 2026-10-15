UPDATE public.unit_resolutions SET decided_by = 'model_context' WHERE decided_by = 'search';
ALTER TABLE public.unit_resolutions DROP CONSTRAINT unit_resolutions_decided_valid;
ALTER TABLE public.unit_resolutions ADD CONSTRAINT unit_resolutions_decided_valid CHECK (decided_by IN ('score', 'reference', 'model_context', 'question', 'admin'));
ALTER TABLE public.unit_resolutions DROP COLUMN search_hits;
ALTER TABLE public.unit_resolutions DROP COLUMN search_query;
