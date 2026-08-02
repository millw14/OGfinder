# OGfinder

Find the **original** Solana token. Names get cloned endlessly — OGfinder ranks
every token sharing a name by true on-chain creation time. Rank #1 = the OG,
everything else is a copy.

Two surfaces, one pipeline:

- **Web** — Next.js app (`src/app`): name search, CA scan verdicts, social-link
  search, wallet analyzer.
- **Telegram bot** (`src/bot`): drop it in a group and it auto-scans every CA
  anyone posts, replying with the same verdict the site gives — plus compare,
  wallet, trending, watchlist alerts and inline mode.

Both import the same scan core (`src/lib/scan-core.ts`), so a verdict in
Telegram always matches the website: metadata via Helius DAS (with RPC +
Jupiter fallbacks) → same-name search across DexScreener + Jupiter → true
creation time per mint (DAS, oldest pool, full signature-history walk) →
oldest-first ranking.

## Telegram bot

### What it does

- **Group auto-scan** — any Solana CA posted in the chat (raw, or inside
  pump.fun / DexScreener / Solscan / Birdeye / GMGN / Jupiter / BullX / Photon
  links) gets scanned automatically. Verdict card shows OG-or-not, rank by
  age, minted date, launchpad, price/MC/liquidity, and a side-by-side against
  the real OG when the pasted CA isn't it.
- `/og <CA or name>` · `/search <name>` — explicit scans and ranked oldest lists
- `/compare <CA> <CA>` — head-to-head age battle
- `/wallet <address>` — PnL, top coin, hold time, side wallets (needs Helius)
- `/trending` — DexScreener-boosted tokens with one-tap OG checks
- `/watch <CA>` — price-move and liquidity-rug alerts per chat
  (`/watchlist`, `/unwatch`)
- `/settings` — per-group: auto-scan on/off, **quiet mode** (only speak up
  when a pasted CA is NOT the OG — a copycat alarm)
- `/stats`, `/ping`, inline mode (`@bot <query>` in any chat)
- Verdict cards link back to the site with the same share payload the web
  "Share verdict" button generates.

### Deploy on Railway (~5 minutes)

> First check whether an OGfinder project already exists: railway.com →
> your workspace → project list. If one exists, add the bot as a **new
> service** inside it; otherwise create a new project. Either way the steps
> are the same from “deploy from GitHub repo”.

1. **Create the bot** with [@BotFather](https://t.me/BotFather): `/newbot`,
   pick a name and a username (grab `OGfinderBot` if free — the site defaults
   to that handle). Copy the token.
2. **BotFather settings** (required for the good stuff):
   - `/setprivacy` → **Disable** — lets the bot see group messages so
     auto-scan works (alternatively make it a group admin).
   - `/setinline` → enable — turns on `@bot <query>` inline mode.
3. **Railway** → New (or existing OGfinder project) → **Deploy from GitHub
   repo** → pick this repo. The root `railway.json` configures the service:
   start command `npm run bot`, healthcheck `/health`, 1 replica (keep it at
   1 — Telegram allows only one long-polling consumer).
4. **Variables** — add on the service (this is where the token goes,
   never in code or chat):

   | Variable | Required | Notes |
   | --- | --- | --- |
   | `TELEGRAM_BOT_TOKEN` | ✅ | paste from BotFather |
   | `HELIUS_API_KEY` | recommended | same key the site uses |
   | `SITE_URL` | recommended | e.g. `https://your-site.tld` — powers the "View on OGfinder" buttons |
   | `WATCH_ALERT_PCT` / `WATCH_INTERVAL_SEC` | optional | watchlist tuning |

5. Deploy. Logs should show `[bot] @YourBot is booting…` then
   `[bot] ready`. The service's public URL (generate a domain under
   Settings → Networking if you want one) serves a small landing page and
   `/health`.
6. Optional:
   - **Persistence** — mount a volume at `/app/.data` so watchlists,
     group settings and stats survive redeploys.
   - **Webhook mode** — set `TELEGRAM_USE_WEBHOOK=1` (uses the Railway
     domain automatically). Default long polling needs no domain at all.
   - **Web on Railway too** — add a second service from the same repo and
     set its config file to `railway.web.json` (service → Settings → Config
     as code).

### Website ↔ bot link

The site shows the bot handle in the hero and footer. It defaults to
`@OGfinderBot`; if you registered a different username, set
`NEXT_PUBLIC_TELEGRAM_BOT=<username>` where the web is deployed (Vercel or
Railway) or edit `src/lib/site-config.ts`.

## Development

```bash
npm install
npm run dev            # website on :3400
npm run bot:dev        # bot (needs TELEGRAM_BOT_TOKEN exported)
npm run bot:selftest   # offline bot logic tests — no token/network needed
npm run lint
npx tsc --noEmit       # typecheck web + bot
```

Copy `.env.example` to `.env.local` for local secrets. `.data/` (sqlite for
the URL index and bot state) is git-ignored.

## Environment variables

Full reference in [`.env.example`](./.env.example). The bot fails fast with a
clear message if `TELEGRAM_BOT_TOKEN` is missing; everything else degrades
gracefully (public RPC fallback without Helius, no site buttons without
`SITE_URL`).
