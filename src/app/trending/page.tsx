import type { Metadata } from "next";
import { NavTabs } from "@/components/NavTabs";
import { SiteFooter } from "@/components/SiteFooter";
import { TrendingClusters } from "@/components/TrendingClusters";
import { getTrendingClusters } from "@/lib/trending";

/** Server component: reads the trending lib directly — no self-fetch. */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Trending copycat clusters | OGfinder",
  description:
    "Token names being launched over and over on Solana right now — clustered from OGfinder's discovery firehose.",
};

export default async function TrendingPage() {
  const initial = await getTrendingClusters("24h");

  return (
    <div className="relative flex min-h-screen flex-col">
      <div className="page-ambient pointer-events-none fixed inset-0" aria-hidden />

      <NavTabs />

      <main className="relative mx-auto w-full max-w-3xl flex-1 px-4 pb-12 pt-8 sm:pt-12">
        <div className="mb-6 text-center">
          <h1 className="font-display text-3xl font-bold tracking-tight text-fg sm:text-4xl">
            Trending Clusters
          </h1>
          <p className="mt-2 text-sm text-fg-3">
            Names being launched over and over right now — clustered from the
            discovery firehose by lookalike-folded name
          </p>
        </div>

        <TrendingClusters initial={initial} />
      </main>

      <SiteFooter />
    </div>
  );
}
