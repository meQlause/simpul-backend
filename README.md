# Simpul backend

Build with `npm run build`. With the configured environment and migrations applied,
create a hosted workspace and its first admin:

```powershell
node dist/server.js create-workspace --name "Point Star" --admin-name "Siti Aminah" --admin-email "siti@pointstar.example" --timezone "Asia/Jakarta"
```

The command prints one set-password link, valid for one hour and one use. It creates
the workspace, admin and sign-in account atomically. The operator supplies the link
to the admin. Starting without the command serves the configured process role.

For the seeded browser fixture, `SIMPUL_BROWSER_BASE_URL` sets the panel origin
trusted by sign-in. It defaults to `http://127.0.0.1:4173`; set it to the preview
origin when running a production build on another port.
