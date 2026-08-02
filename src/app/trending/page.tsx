import type { Metadata } from "next";
import { NavTabs } from "@/components/NavTabs";
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
      <div
        className="pointer-events-none fixed inset-0 bg-[radial-gradient(ellipse_90%_60%_at_50%_-15%,rgba(251,191,36,0.09),transparent_55%)]"
        aria-hidden
      />

      <NavTabs />

      <main className="relative mx-auto w-full max-w-2xl flex-1 px-4 pb-12 pt-4 sm:pt-8">
        <div className="mb-6 text-center">
          <h1 className="text-3xl font-black tracking-tight text-gray-100 sm:text-4xl">
            Trending Clusters
          </h1>
          <p className="mt-2 text-sm text-gray-500">
            Names being launched over and over right now — clustered from the
            discovery firehose by lookalike-folded name
          </p>
        </div>

        <TrendingClusters initial={initial} />
      </main>
    </div>
  );
}
