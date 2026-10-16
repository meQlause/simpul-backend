CREATE UNIQUE INDEX "identities_handle_uq" ON "person_identities" ("workspace_id", "provider", lower("handle")) WHERE "handle" IS NOT NULL;
