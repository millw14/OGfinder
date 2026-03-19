import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], weight: ["400", "500", "600", "700", "800", "900"] });

export const metadata: Metadata = {
  title: "OGfinder — Find the Original Solana Token",
  description:
    "Search any token name and find the oldest original mint on Solana. Powered by Helius, DexScreener, and Jupiter.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body
        className={`${inter.className} min-h-screen bg-[#0a0a0f] text-gray-100 antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
