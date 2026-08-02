export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Dynamic import inside the runtime guard is load-bearing: a static
    // import would drag better-sqlite3 into the edge-runtime compile and
    // break `next build`.
    const { ensurePollerStarted } = await import("./lib/poller");
    ensurePollerStarted();
  }
}
