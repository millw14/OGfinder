import { NextRequest, NextResponse } from "next/server";
import { rateLimitRequest } from "@/lib/rate-limit";
import { getAlertsForWatches } from "@/lib/watches";

/**
 * In-app alert feed: ?watches=id:secret,id:secret[&since=ms]. Pairs with a
 * wrong id or secret are silently omitted from the response — the shape
 * never reveals whether an id exists.
 */

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

    const watchesParam = request.nextUrl.searchParams.get("watches") ?? "";
    const pairs = watchesParam
      .split(",")
      .map((entry) => {
        const sep = entry.indexOf(":");
        if (sep <= 0) return null;
        const id = Number(entry.slice(0, sep));
        const secret = entry.slice(sep + 1);
        if (!Number.isInteger(id) || id <= 0 || !secret) return null;
        return { id, secret };
      })
      .filter((p): p is { id: number; secret: string } => p !== null);

    const sinceRaw = request.nextUrl.searchParams.get("since");
    const since = sinceRaw != null ? Number(sinceRaw) : undefined;

    const watches = getAlertsForWatches(
      pairs,
      since != null && Number.isFinite(since) ? since : undefined
    );
    return NextResponse.json({ watches });
  } catch (err) {
    if (process.env.NODE_ENV === "development") {
      console.error("[alerts] GET error:", err);
    }
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
