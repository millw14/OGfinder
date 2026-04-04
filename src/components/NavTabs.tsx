"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const tabs = [
  { href: "/", label: "OGfinder" },
  { href: "/wallet", label: "Wallet" },
] as const;

export function NavTabs() {
  const pathname = usePathname();

  return (
    <nav className="flex items-center justify-center gap-1 py-4">
      {tabs.map((tab) => {
        const active =
          tab.href === "/"
            ? pathname === "/"
            : pathname.startsWith(tab.href);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={`rounded-full px-4 py-1.5 text-sm font-medium transition-all ${
              active
                ? "bg-gray-800 text-gray-100"
                : "text-gray-500 hover:bg-gray-800/40 hover:text-gray-300"
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
