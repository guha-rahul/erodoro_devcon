import type { Metadata } from "next";
import { SellRips } from "@/components/rips/sell-rips";

export const metadata: Metadata = { title: "Deposit stock · erodoro" };

export default function SellRipsPage() {
  return <SellRips />;
}
