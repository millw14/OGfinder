import { NextResponse } from "next/server";
import { getDb, countIndexedTokens, getPollState } from "@/lib/url-index";
import { getProviderStats } from "@/lib/provider-health";

export const dynamic = "force-dynamic";

export async function GET() {
  let dbOk = false;
  let indexedTokens = 0;
  try {
    getDb().prepare("SELECT 1").get();
    dbOk = true;
    indexedTokens = countIndexedTokens();
  } catch {
    // db stays reported down
  }

  let lastTickMs: number | null = null;
  try {
    const raw = getPollState("poller:last_tick_ms");
    if (raw) {
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) lastTickMs = parsed;
    }
  } catch {
    // poller state unavailable
  }

  const staleSec =
    lastTickMs != null ? Math.round((Date.now() - lastTickMs) / 1000) : null;

  return NextResponse.json({
    ok: dbOk,
    uptimeSec: Math.round(process.uptime()),
    db: { ok: dbOk, indexedTokens },
    providers: getProviderStats(),
    poller: { lastTickMs, staleSec },
  });
}
