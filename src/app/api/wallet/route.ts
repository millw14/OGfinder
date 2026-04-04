import { NextRequest, NextResponse } from "next/server";
import { WalletAnalysis } from "@/lib/types";
import { getWalletCache, setWalletCache } from "@/lib/cache";
import { analyzeWallet } from "@/lib/wallet-analysis";

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export async function GET(request: NextRequest) {
  const address = request.nextUrl.searchParams.get("address")?.trim() ?? "";

  if (!address || !BASE58_RE.test(address)) {
    return NextResponse.json(
      { error: "Invalid Solana wallet address" },
      { status: 400 }
    );
  }

  const cacheKey = `wallet:${address}`;
  const cached = getWalletCache<WalletAnalysis>(cacheKey);
  if (cached) {
    return NextResponse.json({ data: cached });
  }

  try {
    const result = await analyzeWallet(address);
    setWalletCache(cacheKey, result);
    return NextResponse.json({ data: result });
  } catch (err) {
    const msg =
      err instanceof Error ? err.message : "Failed to analyze wallet";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
