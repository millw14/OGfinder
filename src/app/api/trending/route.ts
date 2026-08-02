import { NextRequest, NextResponse } from "next/server";
import { rateLimitRequest } from "@/lib/rate-limit";
import { getTrendingClusters, TrendingWindow } from "@/lib/trending";

/** Trending copycat clusters: ?window=24h|7d (default 24h). Cached 60s. */

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
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

    const raw = request.nextUrl.searchParams.get("window") ?? "24h";
    if (raw !== "24h" && raw !== "7d") {
      return NextResponse.json(
        { error: "window must be 24h or 7d" },
        { status: 400 }
      );
    }

    const result = await getTrendingClusters(raw as TrendingWindow);
    return NextResponse.json(result);
  } catch (err) {
    if (process.env.NODE_ENV === "development") {
      console.error("[trending] GET error:", err);
    }
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
