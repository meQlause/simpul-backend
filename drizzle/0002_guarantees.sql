-- data-spec section 6: raw messages are append-only.
CREATE FUNCTION public.messages_raw_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'messages_raw is append-only'; END $$;
--> statement-breakpoint
CREATE TRIGGER messages_raw_no_update BEFORE UPDATE ON public.messages_raw
  FOR EACH ROW EXECUTE FUNCTION public.messages_raw_immutable();
--> statement-breakpoint
-- data-spec section 6: tentative and historical work never notifies.
CREATE FUNCTION public.notifications_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.threads AS thread WHERE thread.id = NEW.thread_id
             AND (thread.status = 'tentative' OR thread.historical)) THEN
    RAISE EXCEPTION 'thread % cannot notify', NEW.thread_id;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER notifications_guard_ins BEFORE INSERT ON public.notifications
  FOR EACH ROW EXECUTE FUNCTION public.notifications_guard();
--> statement-breakpoint
-- be-architecture section 5: missing scope reads nothing.
DO $$
DECLARE scoped_table text;
BEGIN
  FOR scoped_table IN SELECT table_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'workspace_id'
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', scoped_table);
    EXECUTE format('CREATE POLICY tenant_scope ON public.%I
      USING (workspace_id = nullif(current_setting(''app.workspace_id'', true), '''')::uuid)
      WITH CHECK (workspace_id = nullif(current_setting(''app.workspace_id'', true), '''')::uuid)', scoped_table);
  END LOOP;
END $$;
--> statement-breakpoint
-- Narrow entry points used before tenant scope is known. Deployment grants
-- EXECUTE only to its application role; PUBLIC has no access.
CREATE FUNCTION public.workspace_for_connection(connection_id uuid)
RETURNS TABLE(workspace_id uuid, webhook_secret_ref text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT connection.workspace_id, connection.webhook_secret_ref
  FROM public.bot_connections AS connection WHERE connection.id = connection_id;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.workspace_for_connection(uuid) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.workspace_for_session(auth_user_id text)
RETURNS TABLE(workspace_id uuid, person_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT person.workspace_id, person.id FROM public.people AS person
  WHERE person.auth_user_id = $1 AND person.active
  UNION ALL
  SELECT registry.workspace_id, NULL::uuid FROM public.workspace_databases AS registry
  WHERE registry.admin_auth_user_id = $1;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.workspace_for_session(text) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.workspace_for_route(connection_id uuid)
RETURNS TABLE(workspace_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT route.workspace_id FROM public.connection_routes AS route
  WHERE route.bot_connection_id = connection_id;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.workspace_for_route(uuid) FROM PUBLIC;
