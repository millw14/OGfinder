export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Dynamic import inside the runtime guard is load-bearing: a static
    // import would drag better-sqlite3 into the edge-runtime compile and
    // break `next build`.
    const { ensurePollerStarted } = await import("./lib/poller");
    ensurePollerStarted();
    // Telegram getUpdates long-poll loop — self-gated: token required, and
    // outside production it refuses to start unless TELEGRAM_FORCE_POLL=1
    // (dev polling would steal updates from the prod bot).
    const { ensureTelegramLoopStarted } = await import("./lib/telegram");
    ensureTelegramLoopStarted();
  }
}
