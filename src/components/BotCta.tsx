"use client";

import type { ReactNode } from "react";
import { Chip } from "./Chip";
import { TELEGRAM_BOT_URL, TELEGRAM_GROUP_URL } from "@/lib/links";

const EYEBROW = "text-micro font-semibold uppercase tracking-[0.18em]";

/** Icon tiles follow the AlertGlyph pattern: bordered tile + 14px stroke SVG. */
function FeatureTile({
  gold = false,
  children,
}: {
  gold?: boolean;
  children: ReactNode;
}) {
  return (
    <span
      aria-hidden
      className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border ${
        gold ? "border-og/30 bg-og/10 text-og" : "bg-surface-2 text-fg-2"
      }`}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {children}
      </svg>
    </span>
  );
}

function TelegramGlyph({ size = 15 }: { size?: number }) {
  return (
    <svg
      aria-hidden
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0"
    >
      <path d="m22 2-7 20-4-9-9-4 20-7Z" />
    </svg>
  );
}

/** Gold is spent on the verdict row only — the other two tiles stay neutral. */
const FEATURES: {
  key: string;
  gold?: boolean;
  icon: ReactNode;
  title: string;
  body: string;
}[] = [
  {
    key: "verdict",
    gold: true,
    icon: (
      <>
        <path d="M3 7.5 7.5 11 12 4l4.5 7L21 7.5 19.4 16H4.6L3 7.5Z" />
        <path d="M5 19.5h14" />
      </>
    ),
    title: "Instant OG verdict on every pasted CA",
    body: "Anyone drops a contract address in the chat — the bot ranks it against every lookalike by verified on-chain age.",
  },
  {
    key: "risk",
    icon: (
      <>
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
        <path d="m9 11 2 2 4-4" />
      </>
    ),
    title: "Mint, freeze and mutable flags in the same reply",
    body: "Plus top-10 holder concentration and the deployer's serial-launch history — no second tool, no tab switching.",
  },
  {
    key: "watch",
    icon: (
      <>
        <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
        <path d="M13.73 21a2 2 0 0 1-3.46 0" />
      </>
    ),
    title: "/watch <name> for clone and OG-flip alerts",
    body: "The group gets pinged the moment a new clone launches — or a copycat overtakes the OG.",
  },
];

/**
 * Static showcase for the Telegram group bot. The sample reply below is
 * hand-authored markup in the app's own chip/mono language — it is NEVER
 * fetched from Telegram, and is labelled as a sample so it can't read as a
 * live verdict.
 */
export function BotCta() {
  return (
    <section
      aria-labelledby="bot-cta-title"
      className="mt-8 overflow-hidden rounded-2xl border bg-gradient-to-br from-og/[0.06] via-surface-1 to-surface-1 sm:mt-10"
    >
      {/* ── Pitch ─────────────────────────────────────────────────────────── */}
      <div className="p-4 sm:p-6">
        <p className={`${EYEBROW} flex items-center gap-1.5 text-og`}>
          <TelegramGlyph size={12} />
          Telegram bot
        </p>
        <h2
          id="bot-cta-title"
          className="mt-2.5 font-display text-[24px] font-bold leading-[1.1] tracking-tight text-fg sm:text-[30px]"
        >
          OGfinder in your Telegram group
        </h2>
        <p className="mt-2.5 max-w-xl text-balance text-sm leading-relaxed text-fg-2">
          Paste any CA in your group — the bot replies with the OG verdict, risk
          flags, and the dev&rsquo;s history in seconds.
        </p>
      </div>

      {/* ── Features + sample reply ───────────────────────────────────────── */}
      <div className="grid gap-5 border-t bg-bg/40 p-4 sm:grid-cols-2 sm:gap-6 sm:p-6">
        <ul className="space-y-4">
          {FEATURES.map((f) => (
            <li key={f.key} className="flex items-start gap-3">
              <FeatureTile gold={f.gold}>{f.icon}</FeatureTile>
              <span className="min-w-0">
                <span className="block text-[13px] font-semibold leading-snug text-fg">
                  {f.title}
                </span>
                <span className="mt-1 block text-micro leading-relaxed text-fg-3">
                  {f.body}
                </span>
              </span>
            </li>
          ))}
        </ul>

        <div className="rounded-2xl border bg-surface-1/70 p-3 sm:p-3.5">
          <p className={`${EYEBROW} mb-2.5 flex items-center gap-1.5 text-fg-4`}>
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-og/60" />
            Sample reply
          </p>

          {/* Pasted CA (the group member) */}
          <div className="flex justify-end">
            <span className="max-w-[86%] break-all rounded-2xl rounded-br-md border bg-surface-2 px-3 py-1.5 font-mono text-micro text-fg-2">
              8xKwZ4h9moonPigCA7rQv3nT2sWpump
            </span>
          </div>

          {/* Bot verdict */}
          <div className="mt-2.5 flex items-start gap-2">
            <span
              aria-hidden
              className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-og/30 bg-og/10 font-display text-micro font-bold text-og"
            >
              OG
            </span>
            <div className="min-w-0 flex-1 rounded-2xl rounded-tl-md border bg-surface-1 p-3">
              <p className={`${EYEBROW} text-risk`}>Contract scan verdict</p>
              <p className="mt-1.5 font-display text-[20px] font-bold uppercase leading-none tracking-tight text-fg sm:text-[22px]">
                Not the OG
              </p>
              <p className="mt-1.5 text-meta text-fg-3">
                <span className="font-mono font-medium text-risk">#4</span> of{" "}
                <span className="font-mono text-fg-2">12</span> by age
              </p>

              <div className="mt-2.5 border-t pt-2.5">
                <p className="text-meta text-fg-3">
                  <span className="font-display text-[13px] font-bold tracking-tight text-fg">
                    MoonPig
                  </span>{" "}
                  <span className="font-mono text-micro">$MOONPIG</span>
                </p>
                <p className="mt-1 text-micro leading-relaxed text-fg-3">
                  OG is older by{" "}
                  <span className="font-mono text-fg-2">1y 2mo</span> —{" "}
                  <span className="font-semibold text-og">MoonPig</span>{" "}
                  <span className="whitespace-nowrap font-mono text-og/70">
                    3vRt…pump
                  </span>
                </p>
              </div>

              <div className="mt-2.5 flex flex-wrap gap-1.5">
                <Chip tone="risk">mint auth</Chip>
                <Chip tone="warn">mutable</Chip>
                <Chip tone="warn">
                  top 10 accounts hold&nbsp;
                  <span className="font-mono">41%</span>
                </Chip>
              </div>

              <p className="mt-2.5 font-mono text-micro text-fg-4">
                MC <span className="text-fg-2">$412K</span> ·{" "}
                <span className="text-fg-2">$38K</span> liq
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* ── Actions ───────────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-2.5 border-t px-4 py-4 sm:flex-row sm:items-center sm:px-6">
        <a
          href={TELEGRAM_GROUP_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex min-h-[44px] w-full items-center justify-center gap-2 rounded-xl bg-og px-5 text-sm font-semibold text-bg transition-colors hover:bg-og-light sm:w-auto"
        >
          <TelegramGlyph />
          Add to your group
        </a>
        <a
          href={TELEGRAM_BOT_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex min-h-[44px] w-full items-center justify-center gap-1.5 rounded-xl border bg-surface-2 px-4 text-meta font-semibold text-fg-2 transition-colors hover:border-line-str hover:text-fg sm:w-auto"
        >
          Open the bot
          <span aria-hidden>→</span>
        </a>
        <p className="text-center text-micro leading-relaxed text-fg-4 sm:ml-auto sm:text-right">
          Free · works in any group · no wallet connection
        </p>
      </div>
    </section>
  );
}
