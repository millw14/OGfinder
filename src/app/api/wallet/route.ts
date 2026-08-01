import { NextRequest, NextResponse } from "next/server";
import { WalletAnalysis } from "@/lib/types";
import { getWalletCache, setWalletCache } from "@/lib/cache";
import { analyzeWallet } from "@/lib/wallet-analysis";
import { rateLimitRequest } from "@/lib/rate-limit";

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export async function GET(request: NextRequest) {
  const limited = rateLimitRequest(request.headers);
  if (limited) {
    return NextResponse.json(
      { error: limited.error },
      {
        status: limited.status,
        headers: { "Retry-After": String(limited.retryAfterSec) },
      }
    );
  }

  const address = request.nextUrl.searchParams.get("address")?.trim() ?? "";

  if (!address || !BASE58_RE.test(address)) {
    return NextResponse.json(
      { error: "Invalid Solana wallet address" },
      { status: 400 }
    );
  }

  if (!process.env.HELIUS_API_KEY?.trim()) {
    console.error("[wallet] HELIUS_API_KEY is not configured");
    return NextResponse.json(
      { error: "Wallet analysis is temporarily unavailable" },
      { status: 502 }
    );
  }

  const cacheKey = `wallet:${address}`;
  const cached = getWalletCache<WalletAnalysis>(cacheKey);
  if (cached) {
    return NextResponse.json({ data: cached });
  }

  try {
    const result = await analyzeWallet(address);

    // Nothing came back AND an upstream fetch failed — that's an outage,
    // not an empty wallet. Don't cache it.
    if (result.partial && result.holdings.length === 0 && result.txCount === 0) {
      console.error(
        `[wallet] upstream fetches failed for ${address} — not caching`
      );
      return NextResponse.json(
        { error: "Upstream data source failed — try again shortly" },
        { status: 502 }
      );
    }

    setWalletCache(cacheKey, result);
    return NextResponse.json({ data: result });
  } catch (err) {
    console.error(`[wallet] analysis failed for ${address}:`, err);
    return NextResponse.json(
      { error: "Failed to analyze wallet" },
      { status: 500 }
    );
  }
}
