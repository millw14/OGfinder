import type { Metadata } from "next";
import { HomeClient } from "@/components/HomeClient";
import { decodeSharePayload, formatShareDate } from "@/lib/share";

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
      const title = p.o
        ? `"${p.n}" — OG verified${minted ? ` · minted ${minted}` : ""} | OGfinder`
        : `"${p.n}" — NOT the OG${rankClause} | OGfinder`;
      const description = p.o
        ? `${p.n} ($${p.s}) checks out as the original "${p.n}" on Solana${
            minted ? ` — minted ${minted}` : ""
          }. Verified by on-chain age with OGfinder.`
        : `${p.n} ($${p.s}) is NOT the original "${p.n}" on Solana${
            p.r !== null && p.t !== null
              ? ` — it ranks #${p.r} of ${p.t} by age`
              : ""
          }. Find the real OG with OGfinder.`;
      const ogImage = `/api/og?v=${encodeURIComponent(rawV)}`;
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
