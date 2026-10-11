CREATE FUNCTION public.own_database_probes()
RETURNS TABLE(workspace_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT registry.workspace_id FROM public.workspace_databases AS registry
  WHERE registry.status IN ('connected', 'unreachable');
$$;
REVOKE ALL ON FUNCTION public.own_database_probes() FROM PUBLIC;
