CREATE FUNCTION public.scheduled_workspaces()
RETURNS TABLE(id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT workspace.id FROM public.workspaces AS workspace ORDER BY workspace.id;
$$;
REVOKE ALL ON FUNCTION public.scheduled_workspaces() FROM PUBLIC;
