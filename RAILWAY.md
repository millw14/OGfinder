# Deploying OGfinder to Railway

This repo ships with `railway.json`, so Railway picks up the build and deploy
settings automatically when you connect the repository.

## One-time setup

1. **Create the service** — in [Railway](https://railway.com), create a new
   project → *Deploy from GitHub repo* → select `millw14/OGfinder`. Railway
   builds with Nixpacks (`npm ci && npm run build`) and starts the app with
   `npm run start`. Next.js binds to Railway's injected `PORT` automatically.

2. **Attach a volume** (recommended) — the URL index is a SQLite file, and the
   container filesystem is wiped on every deploy. Add a volume to the service
   (right-click the service → *Attach Volume*), mount it at `/data`, and set
   the `DATA_DIR` variable to `/data`.

3. **Set environment variables** — under the service's *Variables* tab
   (see `.env.example` for details):

   | Variable | Required | Notes |
   |---|---|---|
   | `HELIUS_API_KEY` | recommended | DAS + RPC access; app falls back to public RPC without it |
   | `SOLANA_RPC_URL` | optional | custom RPC fallback when no Helius key |
   | `BIRDEYE_API_KEY` | optional | market data |
   | `NEXT_PUBLIC_SITE_URL` | recommended | your public URL, e.g. `https://<service>.up.railway.app` |
   | `DATA_DIR` | with volume | set to the volume mount path, e.g. `/data` |

   `NEXT_PUBLIC_SITE_URL` is baked in at build time, so redeploy after
   changing it.

4. **Generate a domain** — under *Settings → Networking*, generate a
   `*.up.railway.app` domain (or add a custom one), then set
   `NEXT_PUBLIC_SITE_URL` to it and redeploy.

## Health checks

Railway probes `/api/health` after each deploy (configured in
`railway.json`); a deploy only goes live once it returns 200.
