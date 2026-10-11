CREATE FUNCTION public.own_database_workspaces()
RETURNS TABLE(workspace_id uuid, connection_version text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT registry.workspace_id, encode(secret.nonce, 'hex')
  FROM public.workspace_databases AS registry
  JOIN public.secrets AS secret ON secret.id = registry.url_secret_ref
    AND secret.workspace_id = registry.workspace_id AND secret.purpose = 'database_url'
  WHERE registry.status = 'connected';
$$;
REVOKE ALL ON FUNCTION public.own_database_workspaces() FROM PUBLIC;
