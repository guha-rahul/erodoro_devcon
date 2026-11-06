import type { Metadata } from "next";
import { Suspense } from "react";
import { SwapScreen } from "@/components/swap-screen";

export const metadata: Metadata = { title: "Buy stocks · erodoro" };

export default function SwapPage() {
  return <Suspense fallback={<p className="p-6">Loading stocks…</p>}><SwapScreen /></Suspense>;
}
