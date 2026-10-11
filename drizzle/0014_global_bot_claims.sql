CREATE FUNCTION public.bot_account_available(target_workspace uuid, account_id text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM public.bot_connections AS bot
    WHERE bot.provider = 'telegram' AND bot.provider_account_id = account_id
      AND bot.workspace_id <> target_workspace
    UNION ALL
    SELECT 1 FROM public.connection_routes AS route
    WHERE route.provider = 'telegram' AND route.provider_account_id = account_id
      AND route.workspace_id <> target_workspace
  );
$$;
REVOKE ALL ON FUNCTION public.bot_account_available(uuid, text) FROM PUBLIC;

CREATE FUNCTION public.claim_own_bot_account(target_workspace uuid, connection_id uuid, account_id text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF target_workspace IS DISTINCT FROM nullif(current_setting('app.workspace_id', true), '')::uuid THEN
    RAISE insufficient_privilege USING MESSAGE = 'Workspace scope required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.workspace_databases WHERE workspace_id = target_workspace) THEN
    RETURN false;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('bot-account:telegram:' || account_id, 0));
  IF EXISTS (SELECT 1 FROM public.bot_connections AS bot WHERE bot.provider = 'telegram'
      AND (bot.provider_account_id = account_id OR bot.workspace_id = target_workspace))
    OR EXISTS (SELECT 1 FROM public.connection_routes AS route WHERE route.provider = 'telegram'
      AND (route.provider_account_id = account_id OR route.workspace_id = target_workspace)) THEN
    RAISE unique_violation USING CONSTRAINT = 'route_account_uq', MESSAGE = 'Bot is already in use';
  END IF;
  INSERT INTO public.connection_routes (bot_connection_id, workspace_id, provider, provider_account_id)
    VALUES (connection_id, target_workspace, 'telegram', account_id);
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.claim_own_bot_account(uuid, uuid, text) FROM PUBLIC;

CREATE FUNCTION public.bot_global_account_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('bot-account:' || NEW.provider || ':' || NEW.provider_account_id, 0));
  IF EXISTS (SELECT 1 FROM public.connection_routes AS route
      WHERE route.provider = NEW.provider AND route.provider_account_id = NEW.provider_account_id) THEN
    RAISE unique_violation USING CONSTRAINT = 'bot_account_uq', MESSAGE = 'Bot is already in use';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.bot_global_account_guard() FROM PUBLIC;
CREATE TRIGGER bot_global_account_guard BEFORE INSERT OR UPDATE OF provider, provider_account_id
  ON public.bot_connections FOR EACH ROW EXECUTE FUNCTION public.bot_global_account_guard();
