import type { Metadata } from "next";
import { HomeClient } from "@/components/HomeClient";
import {
  decodeSharePayload,
  decodeComparePayload,
  decodeSafetyMarker,
  formatShareDate,
} from "@/lib/share";
import { flagFromCode } from "@/lib/safety";

type PageSearchParams = { [key: string]: string | string[] | undefined };

/** Max query length echoed into the <title> of a shared ?q= link. */
const MAX_TITLE_QUERY = 48;

export function generateMetadata({
  searchParams,
}: {
  searchParams: PageSearchParams;
}): Metadata {
  const rawV = typeof searchParams.v === "string" ? searchParams.v : null;
  const rawQ = typeof searchParams.q === "string" ? searchParams.q.trim() : "";

  // Verdict share link: ?v=<base64url SharePayload> (untrusted; null on junk).
  if (rawV) {
    const p = decodeSharePayload(rawV);
    if (p) {
      const minted = formatShareDate(p.d);
      const rankClause =
        p.r !== null && p.t !== null ? ` · #${p.r} of ${p.t} by age` : "";
      // Optional sibling marker (?sf=): a blocking safety finding. It must
      // reach the title/description too — an unsafe token that is genuinely
      // the oldest may never be described as "OG verified".
      const rawSf = typeof searchParams.sf === "string" ? searchParams.sf : null;
      const marker = decodeSafetyMarker(rawSf);
      const flag = marker ? flagFromCode(marker) : null;
      const title = flag
        ? `"${p.n}" — oldest by age, but UNSAFE: ${flag.label} | OGfinder`
        : p.o
          ? `"${p.n}" — OG verified${minted ? ` · minted ${minted}` : ""} | OGfinder`
          : `"${p.n}" — NOT the OG${rankClause} | OGfinder`;
      const description = flag
        ? `${p.n} ($${p.s})${
            p.o ? ` is the oldest "${p.n}" on Solana` : ""
          } — ${flag.detail} OGfinder is not calling it the OG.`
        : p.o
          ? `${p.n} ($${p.s}) checks out as the original "${p.n}" on Solana${
              minted ? ` — minted ${minted}` : ""
            }. Verified by on-chain age with OGfinder.`
          : `${p.n} ($${p.s}) is NOT the original "${p.n}" on Solana${
              p.r !== null && p.t !== null
                ? ` — it ranks #${p.r} of ${p.t} by age`
                : ""
            }. Find the real OG with OGfinder.`;
      const ogImage = `/api/og?v=${encodeURIComponent(rawV)}${
        marker ? `&sf=${encodeURIComponent(marker)}` : ""
      }`;
      return {
        title,
        description,
        openGraph: {
          title,
          description,
          siteName: "OGfinder",
          type: "website",
          images: [ogImage],
        },
        twitter: {
          card: "summary_large_image",
          title,
          description,
          images: [ogImage],
        },
      };
    }
  }

  // Comparison share link: ?cv=<base64url ComparePayload> (untrusted).
  const rawCv = typeof searchParams.cv === "string" ? searchParams.cv : null;
  if (rawCv) {
    const p = decodeComparePayload(rawCv);
    if (p) {
      const title = `${p.a.n} vs ${p.b.n} — which is older? | OGfinder`;
      const older = p.w === 0 ? p.a : p.w === 1 ? p.b : null;
      const description = older
        ? `${p.a.n} ($${p.a.s}) vs ${p.b.n} ($${p.b.s}) head-to-head — ${older.n} is the older mint on Solana. Compared by verified on-chain age with OGfinder.`
        : `${p.a.n} ($${p.a.s}) vs ${p.b.n} ($${p.b.s}) — compared head-to-head by on-chain age with OGfinder.`;
      const ogImage = `/api/og?cv=${encodeURIComponent(rawCv)}`;
      return {
        title,
        description,
        openGraph: {
          title,
          description,
          siteName: "OGfinder",
          type: "website",
          images: [ogImage],
        },
        twitter: {
          card: "summary_large_image",
          title,
          description,
          images: [ogImage],
        },
      };
    }
  }

  // Plain shared search: ?q=<query>
  if (rawQ) {
    const q =
      rawQ.length > MAX_TITLE_QUERY ? `${rawQ.slice(0, MAX_TITLE_QUERY)}…` : rawQ;
    const title = `${q} — OG token search | OGfinder`;
    const description = `Which "${q}" is the original? OGfinder ranks every matching Solana mint by on-chain age to find the OG.`;
    return {
      title,
      description,
      openGraph: {
        title,
        description,
        siteName: "OGfinder",
        type: "website",
        images: ["/api/og"],
      },
      twitter: {
        card: "summary_large_image",
        title,
        description,
        images: ["/api/og"],
      },
    };
  }

  // No share params — inherit the layout defaults.
  return {};
}

export default function Home() {
  return <HomeClient />;
}
