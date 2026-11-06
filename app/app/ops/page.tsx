import type { Metadata } from "next";
import { OpsPanel } from "@/components/ops/ops-panel";

// Unlinked operator console: kept out of navigation and search indexes. The
// pool contract, not this page, decides who can act.
export const metadata: Metadata = { title: "Operations · erodoro", robots: { index: false, follow: false } };

export default function OpsPage() {
  return <OpsPanel />;
}
