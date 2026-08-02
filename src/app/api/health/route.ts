import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** Liveness probe for Railway's healthcheck. */
export async function GET() {
  return NextResponse.json({ status: "ok" });
}
