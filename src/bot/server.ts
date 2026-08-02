import http from "http";
import { TgUpdate } from "./bot-types";
import { BotConfig } from "./config";
import { escapeHtml } from "./format";

/**
 * Tiny HTTP server: Railway healthcheck, a human-friendly landing page,
 * and (in webhook mode) the Telegram update endpoint.
 */

export interface ServerDeps {
  cfg: BotConfig;
  enqueue: (update: TgUpdate) => void;
  status: () => {
    ok: boolean;
    mode: "polling" | "webhook" | "starting";
    botUsername: string | null;
    uptimeSec: number;
  };
}

const MAX_BODY = 1_000_000;

function landingPage(botUsername: string | null, siteUrl: string | null): string {
  const botLink = botUsername
    ? `<a href="https://t.me/${escapeHtml(botUsername)}">@${escapeHtml(botUsername)}</a>`
    : "starting…";
  const site = siteUrl
    ? `<p><a href="${escapeHtml(siteUrl)}">OGfinder website →</a></p>`
    : "";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>OGfinder Telegram bot</title>
<style>body{background:#0a0a0f;color:#e5e7eb;font-family:system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
main{text-align:center;padding:2rem}h1{font-size:1.6rem}a{color:#fbbf24;text-decoration:none}p{color:#9ca3af}</style></head>
<body><main><h1>🔎 OGfinder Telegram bot</h1>
<p>Scans any Solana CA posted in your group and tells you if it's the original — or a copycat.</p>
<p>Bot: ${botLink}</p>${site}</main></body></html>`;
}

export function startServer(deps: ServerDeps): http.Server {
  const { cfg, enqueue, status } = deps;
  const webhookPath = `/webhook/${cfg.webhookSecret}`;

  const server = http.createServer((req, res) => {
    const url = (req.url ?? "/").split("?")[0];

    if (req.method === "GET" && url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(status()));
      return;
    }

    if (req.method === "GET" && (url === "/" || url === "/index.html")) {
      const s = status();
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(landingPage(s.botUsername, cfg.siteUrl));
      return;
    }

    if (req.method === "POST" && url === webhookPath) {
      const headerSecret = req.headers["x-telegram-bot-api-secret-token"];
      if (headerSecret !== cfg.webhookSecret) {
        res.writeHead(403);
        res.end();
        return;
      }
      let size = 0;
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY) {
          res.writeHead(413);
          res.end();
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => {
        try {
          const update = JSON.parse(
            Buffer.concat(chunks).toString("utf8")
          ) as TgUpdate;
          if (typeof update?.update_id === "number") enqueue(update);
        } catch {
          /* malformed body — ack anyway so Telegram doesn't retry forever */
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("{}");
      });
      req.on("error", () => {
        try {
          res.writeHead(400);
          res.end();
        } catch {
          /* socket gone */
        }
      });
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  });

  server.listen(cfg.port, () => {
    console.log(`[bot] http server on :${cfg.port} (health at /health)`);
  });
  return server;
}
