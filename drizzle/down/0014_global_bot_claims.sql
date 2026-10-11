DROP TRIGGER bot_global_account_guard ON public.bot_connections;
DROP FUNCTION public.bot_global_account_guard();
DROP FUNCTION public.claim_own_bot_account(uuid, uuid, text);
DROP FUNCTION public.bot_account_available(uuid, text);
