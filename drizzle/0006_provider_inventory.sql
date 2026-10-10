-- be-architecture section 9.4: bootstrap sees names only, never connection credentials.
CREATE FUNCTION public.providers_in_use()
RETURNS TABLE(provider text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT connection.provider FROM public.bot_connections AS connection
  UNION SELECT route.provider FROM public.connection_routes AS route;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.providers_in_use() FROM PUBLIC;
