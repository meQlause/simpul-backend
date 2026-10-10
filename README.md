# Simpul backend

Build with `npm run build`. With the configured environment and migrations applied,
create a hosted workspace and its first admin:

```powershell
node dist/server.js create-workspace --name "Point Star" --admin-name "Siti Aminah" --admin-email "siti@pointstar.example" --timezone "Asia/Jakarta"
```

The command prints one set-password link, valid for one hour and one use. It creates
the workspace, admin and sign-in account atomically. The operator supplies the link
to the admin. Starting without the command serves the configured process role.
