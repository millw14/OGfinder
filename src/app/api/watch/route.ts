import { NextRequest, NextResponse } from "next/server";
import { rateLimitRequest, clientIpFromHeaders } from "@/lib/rate-limit";
import { createWatch, deleteWatch, WatchKind } from "@/lib/watches";

/**
 * Accountless watch management. POST returns the one-time {id, secret} pair
 * the client must store — the secret is the only credential and is never
 * recoverable later.
 */

export async function POST(request: NextRequest) {
  try {
    // Tighter than search: watches are standing state, not queries.
    const limited = rateLimitRequest(request.headers, {
      ratePerMin: 6,
      burst: 3,
    });
    if (limited) {
      return NextResponse.json(
        { error: limited.error },
        {
          status: limited.status,
          headers: { "Retry-After": String(limited.retryAfterSec) },
        }
      );
    }

    const body = (await request.json().catch(() => null)) as {
      query?: unknown;
      kind?: unknown;
      originMint?: unknown;
    } | null;
    const query = typeof body?.query === "string" ? body.query : "";
    const kind: WatchKind =
      body?.kind === "mint-cluster" ? "mint-cluster" : "name";
    const originMint =
      typeof body?.originMint === "string" && body.originMint.length <= 64
        ? body.originMint
        : null;

    const result = createWatch({
      query,
      kind,
      originMint,
      ip: clientIpFromHeaders(request.headers),
    });

    if (!result.ok) {
      if (result.error === "limit") {
        return NextResponse.json(
          { error: "Watch limit reached — remove one to add another" },
          { status: 409 }
        );
      }
      if (result.error === "full") {
        return NextResponse.json(
          { error: "Watchlist capacity reached — try again later" },
          { status: 503 }
        );
      }
      return NextResponse.json(
        { error: "Watch query must be 2-30 characters" },
        { status: 400 }
      );
    }

    return NextResponse.json({
      id: result.watch.id,
      secret: result.watch.secret,
      kind: result.watch.kind,
      displayQuery: result.watch.displayQuery,
      querySkeleton: result.watch.querySkeleton,
      matchMode: result.watch.matchMode,
      telegramLinkUrl: null,
    });
  } catch (err) {
    if (process.env.NODE_ENV === "development") {
      console.error("[watch] POST error:", err);
    }
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
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

    const id = Number(request.nextUrl.searchParams.get("id"));
    const secret = request.nextUrl.searchParams.get("secret") ?? "";
    // Bad id and bad secret are indistinguishable — both 404.
    if (
      !Number.isInteger(id) ||
      id <= 0 ||
      !secret ||
      !deleteWatch(id, secret)
    ) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (process.env.NODE_ENV === "development") {
      console.error("[watch] DELETE error:", err);
    }
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
