import { NextRequest, NextResponse } from "next/server";
import { WalletAnalysis } from "@/lib/types";
import {
  getWalletCache,
  setWalletCache,
  getWalletTxCache,
  setWalletTxCache,
  MAX_DEEP_TXS,
} from "@/lib/cache";
import { analyzeWallet, AnalyzeWalletOptions } from "@/lib/wallet-analysis";
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

  const deepen = request.nextUrl.searchParams.get("deepen") === "1";
  const cacheKey = `wallet:${address}`;

  // Deepen skips the result cache — the caller explicitly wants more data.
  if (!deepen) {
    const cached = getWalletCache<WalletAnalysis>(cacheKey);
    if (cached) {
      return NextResponse.json({ data: cached });
    }
  }

  try {
    // Deepen: resume from the cached cursor while we still hold the prior
    // window. Cache expired or history exhausted → fresh base scan (the
    // button degrades to a refresh).
    let opts: AnalyzeWalletOptions | undefined;
    if (deepen) {
      const prior = getWalletTxCache(address);
      if (prior?.nextBefore && prior.txs.length < MAX_DEEP_TXS) {
        opts = { priorTxs: prior.txs, before: prior.nextBefore };
      }
    }

    const { analysis, txs, nextBefore } = await analyzeWallet(address, opts);
    analysis.canDeepen =
      analysis.truncated === true &&
      nextBefore != null &&
      txs.length < MAX_DEEP_TXS;

    // Nothing came back AND an upstream fetch failed — that's an outage,
    // not an empty wallet. Don't cache it.
    if (
      analysis.partial &&
      analysis.holdings.length === 0 &&
      analysis.txCount === 0
    ) {
      console.error(
        `[wallet] upstream fetches failed for ${address} — not caching`
      );
      return NextResponse.json(
        { error: "Upstream data source failed — try again shortly" },
        { status: 502 }
      );
    }

    setWalletTxCache(address, { txs, nextBefore });
    setWalletCache(cacheKey, analysis);
    return NextResponse.json({ data: analysis });
  } catch (err) {
    console.error(`[wallet] analysis failed for ${address}:`, err);
    return NextResponse.json(
      { error: "Failed to analyze wallet" },
      { status: 500 }
    );
  }
}
