import { ImageResponse } from "next/og";
import type { NextRequest } from "next/server";
import {
  decodeSharePayload,
  formatShareDate,
  SharePayload,
} from "@/lib/share";

export const runtime = "edge";
export const dynamic = "force-dynamic";

/**
 * 1200x630 social card. ?v=<base64url SharePayload> renders the verdict;
 * anything else (or nothing) renders the generic branded card.
 * ImageResponse constraints: inline styles, flexbox only, default font.
 */

const BG = "#0a0a0f";
const AMBER = "#fbbf24";
const AMBER_DEEP = "#f59e0b";
const WHITE = "#f3f4f6";
const GRAY = "#9ca3af";
const GRAY_DIM = "#6b7280";
const GRAY_CARD = "#1f2937";
const CYAN = "#22d3ee";

function truncMint(m: string): string {
  return m.length > 12 ? `${m.slice(0, 4)}…${m.slice(-4)}` : m;
}

function Wordmark({ size = 40 }: { size?: number }) {
  return (
    <div style={{ display: "flex", alignItems: "center" }}>
      <span style={{ color: AMBER, fontWeight: 900, fontSize: size }}>OG</span>
      <span style={{ color: WHITE, fontWeight: 900, fontSize: size }}>
        finder
      </span>
    </div>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        backgroundColor: BG,
        backgroundImage:
          "radial-gradient(circle at 50% -10%, rgba(251,191,36,0.16), rgba(10,10,15,0) 60%)",
        padding: "56px 72px",
      }}
    >
      {children}
    </div>
  );
}

function VerdictCard({ p }: { p: SharePayload }) {
  const minted = formatShareDate(p.d);
  const notOgLabel =
    p.r !== null && p.t !== null
      ? `NOT THE OG — #${p.r} of ${p.t} by age`
      : "NOT THE OG";
  return (
    <Frame>
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            maxWidth: 1050,
            whiteSpace: "nowrap",
          }}
        >
          <span
            style={{
              color: WHITE,
              fontWeight: 900,
              fontSize: p.n.length > 18 ? 56 : 80,
            }}
          >
            {p.n}
          </span>
          <span
            style={{
              color: GRAY_DIM,
              fontWeight: 700,
              fontSize: p.n.length > 18 ? 34 : 44,
              marginLeft: 24,
            }}
          >
            ${p.s}
          </span>
        </div>

        {p.o ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              marginTop: 40,
              backgroundColor: AMBER_DEEP,
              color: BG,
              fontWeight: 900,
              fontSize: 54,
              padding: "16px 48px",
              borderRadius: 24,
            }}
          >
            OG
            {/* inline check (default font has no U+2713 glyph) */}
            <svg
              width="46"
              height="46"
              viewBox="0 0 24 24"
              fill="none"
              style={{ marginLeft: 16 }}
            >
              <path
                d="M4 12.5l5.5 5.5L20 6.5"
                stroke={BG}
                strokeWidth="3.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
        ) : (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              marginTop: 40,
              backgroundColor: GRAY_CARD,
              color: GRAY,
              fontWeight: 800,
              fontSize: p.r !== null && p.t !== null ? 40 : 54,
              padding: "16px 48px",
              borderRadius: 24,
            }}
          >
            {notOgLabel}
          </div>
        )}

        {minted && (
          <div
            style={{
              display: "flex",
              marginTop: 32,
              color: GRAY,
              fontSize: 32,
            }}
          >
            minted {minted}
          </div>
        )}

        {p.m && (
          <div
            style={{
              display: "flex",
              marginTop: 14,
              color: CYAN,
              fontSize: 24,
            }}
          >
            {truncMint(p.m)}
          </div>
        )}
      </div>

      <div
        style={{
          display: "flex",
          justifyContent: "center",
        }}
      >
        <Wordmark />
      </div>
    </Frame>
  );
}

function GenericCard() {
  return (
    <Frame>
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Wordmark size={96} />
        <div
          style={{
            display: "flex",
            marginTop: 28,
            color: GRAY,
            fontSize: 36,
          }}
        >
          find the original Solana token
        </div>
      </div>
      <div style={{ display: "flex", justifyContent: "center" }}>
        <div style={{ display: "flex", color: GRAY_DIM, fontSize: 24 }}>
          name · mint (CA) · social URL
        </div>
      </div>
    </Frame>
  );
}

export function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get("v");
  const payload = raw ? decodeSharePayload(raw) : null;
  return new ImageResponse(
    payload ? <VerdictCard p={payload} /> : <GenericCard />,
    { width: 1200, height: 630 }
  );
}
