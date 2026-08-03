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
        <div className="mb-7 text-center">
          <p className="text-micro font-semibold uppercase tracking-[0.18em] text-og">
            Copycat firehose
          </p>
          <h1 className="mt-2 font-display text-[34px] font-bold leading-[1.05] tracking-tight text-fg sm:text-[40px]">
            Trending Clusters
          </h1>
          <p className="mx-auto mt-3 max-w-lg text-balance text-sm leading-relaxed text-fg-2">
            A cluster is one name being launched over and over. We fold every
            new mint&rsquo;s name past lookalike characters, group the
            collisions, and rank them by how hard they&rsquo;re being copied
            right now.
          </p>
        </div>

        <TrendingClusters initial={initial} />
      </main>

      <SiteFooter />
    </div>
  );
}
