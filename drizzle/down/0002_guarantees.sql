DROP FUNCTION public.workspace_for_route(uuid);
DROP FUNCTION public.workspace_for_session(text);
DROP FUNCTION public.workspace_for_connection(uuid);
DROP TRIGGER notifications_guard_ins ON public.notifications;
DROP FUNCTION public.notifications_guard();
DROP TRIGGER messages_raw_no_update ON public.messages_raw;
DROP FUNCTION public.messages_raw_immutable();
DO $$
DECLARE scoped_table text;
BEGIN
  FOR scoped_table IN SELECT table_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'workspace_id'
  LOOP
    EXECUTE format('DROP POLICY tenant_scope ON public.%I', scoped_table);
    EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', scoped_table);
  END LOOP;
END $$;
